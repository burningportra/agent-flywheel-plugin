#!/usr/bin/env node
// lint-skill-dir: lint every .md file in a directory with ONE shared baseline.
//
// Why this exists: `lint-skill.ts` lints a single file per invocation and
// overwrites the baseline on --update-baseline. The flywheel's `skills/start/`
// directory has 11 skill files; linting only SKILL.md left blind spots that
// shipped unparseable AskUserQuestion calls (M2 beads). This driver covers the
// whole directory with one baseline so a 5-option AUQ added to any start file
// fails CI.
//
// Semantics mirror lint-skill.ts for the surface it reuses: --ci, --baseline,
// --format, --max-bytes. Multi-file additions: --dir <path> and
// --update-baseline writes merged entries from every file in one pass.
import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
function isCompiledScript(scriptUrl) {
    return scriptUrl.includes("/dist/scripts/");
}
const isCompiled = isCompiledScript(import.meta.url);
const lintBase = isCompiled ? "../lint" : "../src/lint";
function defaultOpts() {
    return {
        dir: null,
        ci: false,
        baseline: null,
        format: null,
        updateBaseline: false,
        help: false,
    };
}
function parseArgs(argv) {
    const opts = defaultOpts();
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const takeNext = () => {
            const v = argv[i + 1];
            if (v === undefined || v.startsWith("--"))
                return null;
            i++;
            return v;
        };
        switch (a) {
            case "-h":
            case "--help":
                opts.help = true;
                break;
            case "--ci":
                opts.ci = true;
                break;
            case "--update-baseline":
                opts.updateBaseline = true;
                break;
            case "--dir": {
                const v = takeNext();
                if (v === null)
                    return { opts, error: "--dir requires a path" };
                opts.dir = v;
                break;
            }
            case "--baseline": {
                const v = takeNext();
                if (v === null)
                    return { opts, error: "--baseline requires a path" };
                opts.baseline = v;
                break;
            }
            case "--format": {
                const v = takeNext();
                if (v === null)
                    return { opts, error: "--format requires a value" };
                if (v !== "pretty" && v !== "compact" && v !== "gha" && v !== "json") {
                    return { opts, error: `invalid --format '${v}'` };
                }
                opts.format = v;
                break;
            }
            default:
                return { opts, error: `unknown flag: ${a}` };
        }
    }
    return { opts, error: null };
}
function printHelp() {
    process.stdout.write([
        "lint-skill-dir: lint every .md file in a directory with ONE baseline.",
        "",
        "Usage: lint-skill-dir --dir <path> [--baseline <path>] [--ci] [--format <name>]",
        "       lint-skill-dir --dir <path> --baseline <path> --update-baseline",
        "",
        "Each file is linted via the lint-skill rule set. One baseline covers all",
        "files; --update-baseline rewrites the baseline with the UNION of every",
        "file's current findings.",
        "",
    ].join("\n"));
}
function walkMd(dir) {
    const out = [];
    for (const entry of readdirSync(dir).sort()) {
        const p = path.join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) {
            out.push(...walkMd(p));
        }
        else if (entry.endsWith(".md")) {
            out.push(p);
        }
    }
    return out;
}
// Starts work early without an unhandled rejection when an earlier step returns first.
function settle(p) {
    return p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
}
export function resolveRepoRoot(scriptUrl) {
    const here = path.dirname(fileURLToPath(scriptUrl));
    const mcpServerRoot = isCompiledScript(scriptUrl)
        ? path.resolve(here, "..", "..")
        : path.resolve(here, "..");
    return path.resolve(mcpServerRoot, "..");
}
async function main() {
    const { opts, error } = parseArgs(process.argv.slice(2));
    if (error) {
        process.stderr.write(`lint-skill-dir: ${error}\n`);
        return 3;
    }
    if (opts.help) {
        printHelp();
        return 0;
    }
    if (!opts.dir) {
        process.stderr.write("lint-skill-dir: --dir is required\n");
        return 3;
    }
    // Module imports, the .md reads, the registry (manifest) load and the baseline
    // load are independent, so they run together; results are still checked in
    // the original order so errors and output don't change.
    const modulesLoad = Promise.all([
        import(`${lintBase}/index.js`),
        import(`${lintBase}/baseline.js`),
        import(`${lintBase}/reporters/index.js`),
        import(`${lintBase}/skillRegistry.js`),
        import(`${lintBase}/rules/askUserQuestion.js`),
        import(`${lintBase}/rules/slashReferences.js`),
        import(`${lintBase}/rules/placeholders.js`),
        import(`${lintBase}/rules/implicitDecisions.js`),
        import(`${lintBase}/rules/errorCodeReferences.js`),
        import(`${lintBase}/rules/reserve001.js`),
        import(`${lintBase}/rules/pane001.js`),
        import(`${lintBase}/rules/tone001.js`),
    ]);
    const repoRoot = resolveRepoRoot(import.meta.url);
    const dirAbs = path.resolve(process.cwd(), opts.dir);
    let files = [];
    let walkError = null;
    try {
        files = walkMd(dirAbs);
    }
    catch (e) {
        walkError = e;
    }
    const reads = files.map((file) => settle(readFile(file, "utf8")));
    const [lintMod, baselineMod, reportersMod, registryMod, auq, slash, place, impl, err, reserve, pane, tone] = (await modulesLoad);
    const rules = [...auq.auqRules, slash.slash001, place.place001, impl.impl001, err.err001, reserve.reserve001, pane.pane001, tone.tone001];
    if (walkError !== null) {
        process.stderr.write(`lint-skill-dir: cannot read ${dirAbs}: ${String(walkError)}\n`);
        return 4;
    }
    if (files.length === 0) {
        process.stderr.write(`lint-skill-dir: no .md files under ${dirAbs}\n`);
        return 4;
    }
    const registryLoad = settle(registryMod.loadSkillRegistry({ repoRoot, ci: opts.ci }));
    const baselineLoad = opts.baseline && !opts.updateBaseline ? settle(baselineMod.loadBaseline(opts.baseline)) : null;
    const registryResult = await registryLoad;
    if (!registryResult.ok)
        throw registryResult.error;
    const registry = registryResult.value;
    // One lint per file, then merge findings.
    const allFindings = [];
    const perFileSources = new Map();
    // Dedupe key — rules that scan cross-cutting repo files (RESERVE001, PANE001)
    // emit the same global findings on every per-file lint pass; without dedupe
    // the baseline collects N copies.
    const seen = new Set();
    for (const [i, file] of files.entries()) {
        const read = await reads[i];
        if (!read.ok) {
            process.stderr.write(`lint-skill-dir: cannot read ${file}: ${String(read.error)}\n`);
            return 4;
        }
        const source = baselineMod.normalizeSourceForFingerprint(read.value);
        perFileSources.set(file, source);
        const result = await lintMod.lint({
            source,
            filePath: file,
            rules,
            ruleContextExtras: { registry, source, repoRoot },
        });
        for (const f of result.findings) {
            const key = `${f.ruleId}|${f.file}|${f.line}|${f.column}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            allFindings.push(f);
        }
    }
    if (opts.updateBaseline) {
        if (!opts.baseline) {
            process.stderr.write("lint-skill-dir: --update-baseline requires --baseline <path>\n");
            return 3;
        }
        // Fingerprints are per-file: regenerate baseline from each file's own source so
        // the resulting entries match correctly on re-lint.
        const entriesByFile = new Map();
        for (const f of allFindings) {
            const arr = entriesByFile.get(f.file) ?? [];
            arr.push(f);
            entriesByFile.set(f.file, arr);
        }
        const allEntries = [];
        for (const [file, findings] of entriesByFile) {
            const source = perFileSources.get(file) ?? "";
            const bf = baselineMod.generateBaseline(findings, source, undefined, repoRoot);
            allEntries.push(...bf.entries);
        }
        const merged = {
            schemaVersion: 1,
            rulesetVersion: 1,
            generated: new Date().toISOString(),
            entries: allEntries,
        };
        await baselineMod.saveBaseline(opts.baseline, merged);
        process.stdout.write(`wrote baseline: ${opts.baseline} (${allEntries.length} entries across ${entriesByFile.size} files)\n`);
        return 0;
    }
    // Apply baseline (per-file source for fingerprint matching).
    let liveFindings = [];
    let baselinedCount = 0;
    if (opts.baseline) {
        const loaded = await baselineLoad;
        if (!loaded.ok) {
            process.stderr.write(`lint-skill-dir: failed to load baseline ${opts.baseline}: ${String(loaded.error)}\n`);
            return 4;
        }
        const bf = loaded.value;
        // Reject baseline entries with empty reasons — a baseline is "fix later, not
        // forgotten", and an unexplained entry is indistinguishable from a mistake.
        // The error prints the offenders so a reviewer can patch them in one pass.
        const bfTyped = bf;
        const emptyReason = (bfTyped?.entries ?? []).filter((e) => !e.reason || e.reason.trim().length < 10);
        if (emptyReason.length > 0) {
            process.stderr.write(`lint-skill-dir: ${emptyReason.length} baseline entries have empty or trivially-short reasons (< 10 chars) — every entry needs a one-line justification:\n`);
            for (const e of emptyReason.slice(0, 10)) {
                process.stderr.write(`  ${e.ruleId} ${e.file}:${e.line} reason=${JSON.stringify(e.reason ?? "")}\n`);
            }
            if (emptyReason.length > 10) {
                process.stderr.write(`  ... and ${emptyReason.length - 10} more\n`);
            }
            return 3;
        }
        const byFile = new Map();
        for (const f of allFindings) {
            const arr = byFile.get(f.file) ?? [];
            arr.push(f);
            byFile.set(f.file, arr);
        }
        for (const [file, findings] of byFile) {
            const source = perFileSources.get(file) ?? "";
            const { live, baselined } = baselineMod.applyBaseline(findings, bf, source, repoRoot);
            liveFindings.push(...live, ...baselined);
            baselinedCount += baselined.length;
        }
    }
    else {
        liveFindings = allFindings.slice();
    }
    const reporter = opts.format ?? reportersMod.selectReporter();
    const sorted = reportersMod.sortFindings(liveFindings);
    const text = reportersMod.format(reporter, { findings: sorted, internalErrors: [] });
    if (text)
        process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
    const liveErrors = liveFindings.filter((f) => f.severity === "error");
    return liveErrors.length > 0 ? 1 : 0;
}
const entryPath = process.argv[1] ? realpathSync(path.resolve(process.argv[1])) : "";
const modulePath = realpathSync(fileURLToPath(import.meta.url));
if (entryPath === modulePath) {
    void main().then((code) => process.exit(code), (err) => {
        process.stderr.write(`lint-skill-dir: ${String(err)}\n`);
        process.exit(2);
    });
}
//# sourceMappingURL=lint-skill-dir.js.map