#!/usr/bin/env node
// check-skills-bundle: verify that the on-disk skills bundle still matches
// the source tree. Used in CI to catch drift between skills/**/*.md and
// dist/skills.bundle.json.
//
// Two checks:
//   1) Re-walk source files, compute srcSha256 for each, and compare against
//      the matching bundle entry by `name`. Any mismatch (sha differs, name
//      missing on either side) → fail.
//   2) Recompute manifestSha256 from the bundle's own entries[] array (sorted)
//      and compare against bundle.manifestSha256. Catches in-place tampering.
//
// Exit 0 on full match, non-zero otherwise.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
const DEFAULT_BUNDLE_REL = "dist/skills.bundle.json";
const PLUGIN_NAME = "agent-flywheel";
function defaultOpts() {
    return { bundle: null, sourceRoot: null, help: false };
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
            case "--bundle": {
                const v = takeNext();
                if (v === null)
                    return { opts, error: "--bundle requires a path argument" };
                opts.bundle = v;
                break;
            }
            case "--source-root": {
                const v = takeNext();
                if (v === null)
                    return { opts, error: "--source-root requires a path argument" };
                opts.sourceRoot = v;
                break;
            }
            default:
                return { opts, error: `unknown argument '${a}' (use --help)` };
        }
    }
    return { opts, error: null };
}
function helpText() {
    return [
        "check-skills-bundle",
        "",
        "Verifies dist/skills.bundle.json against the source tree by recomputing",
        "srcSha256 per file and the aggregate manifestSha256.",
        "",
        "Usage:",
        "  check-skills-bundle [--bundle <path>] [--source-root <path>]",
        "",
        "Defaults:",
        `  --bundle         <repo>/mcp-server/${DEFAULT_BUNDLE_REL}`,
        "  --source-root    <repo-root> (auto-detected from script location)",
        "",
        "Exit codes:",
        "  0  All entries match.",
        "  1  Drift detected (mismatched sha, missing entries, or manifestSha256 mismatch).",
        "  3  Invalid CLI arguments.",
        "  4  Bundle file unreadable.",
        "",
    ].join("\n");
}
function findRepoRoot() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let dir = here;
    for (let i = 0; i < 8; i++) {
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        if (path.basename(dir) === "mcp-server")
            return parent;
        dir = parent;
    }
    return process.cwd();
}
function findMcpServerRoot() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let dir = here;
    for (let i = 0; i < 8; i++) {
        if (path.basename(dir) === "mcp-server")
            return dir;
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return process.cwd();
}
function canonicalJSON(value) {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return "[" + value.map((v) => canonicalJSON(v)).join(",") + "]";
    }
    const obj = value;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k]));
    return "{" + parts.join(",") + "}";
}
function sha256Hex(data) {
    return createHash("sha256").update(data).digest("hex");
}
async function walkSources(sourceRoot) {
    const skillsDir = path.join(sourceRoot, "skills");
    const out = [];
    const entries = await readdir(skillsDir);
    for (const entry of entries) {
        const dir = path.join(skillsDir, entry);
        let st;
        try {
            st = await stat(dir);
        }
        catch {
            continue;
        }
        if (!st.isDirectory())
            continue;
        const skillMd = path.join(dir, "SKILL.md");
        try {
            const skillStat = await stat(skillMd);
            if (skillStat.isFile()) {
                out.push({
                    absPath: skillMd,
                    relPath: path.relative(sourceRoot, skillMd),
                    skillName: `${PLUGIN_NAME}:${entry}`,
                });
            }
        }
        catch {
            // skip
        }
    }
    const startDir = path.join(skillsDir, "start");
    try {
        const startEntries = await readdir(startDir);
        for (const entry of startEntries) {
            if (!entry.startsWith("_") || !entry.endsWith(".md"))
                continue;
            const abs = path.join(startDir, entry);
            const subStat = await stat(abs);
            if (!subStat.isFile())
                continue;
            const subSkillName = `start_${entry.slice(1, -3)}`;
            out.push({
                absPath: abs,
                relPath: path.relative(sourceRoot, abs),
                skillName: `${PLUGIN_NAME}:${subSkillName}`,
            });
        }
    }
    catch {
        // skip
    }
    return out;
}
export async function main(argv) {
    const { opts, error } = parseArgs(argv);
    if (error) {
        process.stderr.write(`check-skills-bundle: ${error}\n`);
        return 3;
    }
    if (opts.help) {
        process.stderr.write(helpText());
        return 0;
    }
    const sourceRoot = opts.sourceRoot
        ? path.resolve(process.cwd(), opts.sourceRoot)
        : findRepoRoot();
    const bundlePath = opts.bundle
        ? path.resolve(process.cwd(), opts.bundle)
        : path.join(findMcpServerRoot(), DEFAULT_BUNDLE_REL);
    let bundleRaw;
    try {
        bundleRaw = await readFile(bundlePath, "utf8");
    }
    catch (err) {
        process.stderr.write(`check-skills-bundle: cannot read bundle ${bundlePath}: ${String(err)}\n`);
        return 4;
    }
    let bundle;
    try {
        bundle = JSON.parse(bundleRaw);
    }
    catch (err) {
        process.stderr.write(`check-skills-bundle: invalid JSON at ${bundlePath}: ${String(err)}\n`);
        return 4;
    }
    const drifts = [];
    // 1) Verify aggregate manifestSha256 over the bundle's own entries[].
    const recomputedManifestSha = sha256Hex(canonicalJSON(bundle.entries));
    if (recomputedManifestSha !== bundle.manifestSha256) {
        drifts.push({
            name: "<manifest>",
            reason: `manifestSha256 mismatch: bundle=${bundle.manifestSha256.slice(0, 16)} recomputed=${recomputedManifestSha.slice(0, 16)}`,
        });
    }
    // 2) Re-walk source and compare per-entry srcSha256.
    const sources = await walkSources(sourceRoot);
    const bundleByName = new Map();
    for (const e of bundle.entries)
        bundleByName.set(e.name, e);
    const seen = new Set();
    for (const src of sources) {
        seen.add(src.skillName);
        const buf = await readFile(src.absPath);
        const srcSha = sha256Hex(buf);
        const bundled = bundleByName.get(src.skillName);
        if (!bundled) {
            drifts.push({
                name: src.skillName,
                reason: `source exists (${src.relPath}) but missing from bundle`,
            });
            continue;
        }
        if (bundled.srcSha256 !== srcSha) {
            drifts.push({
                name: src.skillName,
                reason: `srcSha256 differs: bundle=${bundled.srcSha256.slice(0, 16)} source=${srcSha.slice(0, 16)}`,
            });
        }
    }
    for (const e of bundle.entries) {
        if (!seen.has(e.name)) {
            drifts.push({
                name: e.name,
                reason: `bundle entry has no matching source file (${e.path})`,
            });
        }
    }
    if (drifts.length === 0) {
        process.stderr.write(`OK: ${bundle.entries.length} entries match\n`);
        return 0;
    }
    process.stderr.write(`FAIL: ${drifts.length} entries drifted:\n`);
    for (const d of drifts) {
        process.stderr.write(`  - ${d.name}: ${d.reason}\n`);
    }
    return 1;
}
const invokedDirect = (() => {
    if (!process.argv[1])
        return false;
    try {
        return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
    }
    catch {
        return false;
    }
})();
if (invokedDirect) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
        process.stderr.write(`check-skills-bundle: unexpected error: ${String(err)}\n`);
        process.exit(1);
    });
}
//# sourceMappingURL=check-skills-bundle.js.map