#!/usr/bin/env node
// build-skills-bundle: walk skills/**/SKILL.md + skills/start/_*.md, parse
// frontmatter, atomic-write a deterministic JSON bundle to disk for use by
// the get-skill MCP tool (T13).
//
// Output: <output> (default mcp-server/dist/skills.bundle.json) — a single
// JSON file containing per-entry metadata + body + sha256 + an aggregate
// manifestSha256 over the entries[] array.
//
// The bundle is atomic: written to <output>.tmp, fsync'd, then renamed.
// Per-entry size is capped (default 200 KiB); total size is capped (default
// 5 MiB). Either cap exceeded → build fails non-zero with a structured error.
import { createHash } from "node:crypto";
import { open, readdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
const DEFAULT_OUTPUT_REL = "dist/skills.bundle.json";
const DEFAULT_MAX_TOTAL = 5 * 1024 * 1024;
const DEFAULT_MAX_ENTRY = 200 * 1024;
const PLUGIN_NAME = "agent-flywheel";
function defaultOpts() {
    return {
        output: null,
        sourceRoot: null,
        maxTotal: DEFAULT_MAX_TOTAL,
        maxEntry: DEFAULT_MAX_ENTRY,
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
            case "--output": {
                const v = takeNext();
                if (v === null)
                    return { opts, error: "--output requires a path argument" };
                opts.output = v;
                break;
            }
            case "--source-root": {
                const v = takeNext();
                if (v === null)
                    return { opts, error: "--source-root requires a path argument" };
                opts.sourceRoot = v;
                break;
            }
            case "--max-total": {
                const v = takeNext();
                if (v === null)
                    return { opts, error: "--max-total requires an integer argument" };
                const n = Number(v);
                if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
                    return { opts, error: `invalid --max-total '${v}' (expected positive integer bytes)` };
                }
                opts.maxTotal = n;
                break;
            }
            case "--max-entry": {
                const v = takeNext();
                if (v === null)
                    return { opts, error: "--max-entry requires an integer argument" };
                const n = Number(v);
                if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
                    return { opts, error: `invalid --max-entry '${v}' (expected positive integer bytes)` };
                }
                opts.maxEntry = n;
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
        "build-skills-bundle",
        "",
        "Walks skills/**/SKILL.md + skills/start/_*.md, parses frontmatter, and",
        "writes a deterministic JSON bundle for runtime consumption.",
        "",
        "Usage:",
        "  build-skills-bundle [--output <path>] [--source-root <path>]",
        "                     [--max-total <bytes>] [--max-entry <bytes>]",
        "",
        "Defaults:",
        `  --output         <repo>/mcp-server/${DEFAULT_OUTPUT_REL}`,
        "  --source-root    <repo-root> (auto-detected from script location)",
        `  --max-total      ${DEFAULT_MAX_TOTAL} (5 MiB)`,
        `  --max-entry      ${DEFAULT_MAX_ENTRY} (200 KiB)`,
        "",
        "Exit codes:",
        "  0  Bundle written.",
        "  1  Cap exceeded, walk failure, or write failure.",
        "  3  Invalid CLI arguments.",
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
function stripQuotes(value) {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return trimmed
                .slice(1, -1)
                .replace(/\\"/g, '"')
                .replace(/\\'/g, "'")
                .replace(/\\\\/g, "\\");
        }
    }
    return trimmed;
}
function parseFrontmatter(text) {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    if (lines.length === 0 || lines[0].trim() !== "---") {
        return { frontmatter: {}, body: normalized, hasFrontmatter: false };
    }
    let closeIdx = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === "---") {
            closeIdx = i;
            break;
        }
    }
    if (closeIdx === -1) {
        return { frontmatter: {}, body: normalized, hasFrontmatter: false };
    }
    const frontmatter = {};
    for (let i = 1; i < closeIdx; i++) {
        const line = lines[i];
        if (line.trim() === "" || line.trim().startsWith("#"))
            continue;
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1)
            continue;
        const key = line.slice(0, colonIdx).trim();
        const rawValue = line.slice(colonIdx + 1);
        if (key.length === 0)
            continue;
        frontmatter[key] = stripQuotes(rawValue);
    }
    const body = lines.slice(closeIdx + 1).join("\n");
    return { frontmatter, body, hasFrontmatter: true };
}
// --- canonical JSON --------------------------------------------------------------------
//
// Stable stringify with recursively sorted object keys. Arrays preserve order;
// the entries[] array is pre-sorted by `name` in build(). Used for the
// manifestSha256 hash so byte-equal source produces a byte-equal manifest.
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
    let entries;
    try {
        entries = await readdir(skillsDir);
    }
    catch (err) {
        throw new Error(`cannot read skills directory ${skillsDir}: ${String(err)}`);
    }
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
            // SKILL.md missing in this directory — fine, just skip
        }
    }
    // Additionally walk skills/start/_*.md sub-files
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
        // No start dir — fine
    }
    return out;
}
// --- atomic write ---------------------------------------------------------------------
async function atomicWriteJSON(outputPath, content) {
    const tmpPath = `${outputPath}.tmp`;
    const buf = Buffer.from(content, "utf8");
    const handle = await open(tmpPath, "w");
    try {
        await handle.write(buf, 0, buf.length, 0);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await rename(tmpPath, outputPath);
}
// --- generator id ---------------------------------------------------------------------
async function detectGeneratorId(repoRoot) {
    // Best-effort: try to read .git/HEAD + resolved ref short hash. If anything
    // fails, fall back to the script name alone.
    const fallback = "build-skills-bundle.ts";
    try {
        const headPath = path.join(repoRoot, ".git", "HEAD");
        const head = await readFile(headPath, "utf8");
        const m = /^ref:\s*(\S+)/.exec(head.trim());
        if (m) {
            const refPath = path.join(repoRoot, ".git", m[1]);
            try {
                const sha = (await readFile(refPath, "utf8")).trim();
                if (sha.length >= 7)
                    return `${fallback}@${sha.slice(0, 12)}`;
            }
            catch {
                // Packed ref or detached — try packed-refs once.
                try {
                    const packed = await readFile(path.join(repoRoot, ".git", "packed-refs"), "utf8");
                    const line = packed
                        .split("\n")
                        .find((l) => l.endsWith(" " + m[1]) && !l.startsWith("#"));
                    if (line) {
                        const sha = line.split(" ")[0];
                        if (sha && sha.length >= 7)
                            return `${fallback}@${sha.slice(0, 12)}`;
                    }
                }
                catch {
                    // ignore
                }
            }
        }
        else {
            // Detached HEAD: the file itself is a SHA.
            const sha = head.trim();
            if (/^[0-9a-f]{7,}$/.test(sha))
                return `${fallback}@${sha.slice(0, 12)}`;
        }
    }
    catch {
        // ignore
    }
    return fallback;
}
export async function build(opts) {
    const sources = await walkSources(opts.sourceRoot);
    const generatedAt = new Date().toISOString();
    const generator = await detectGeneratorId(opts.sourceRoot);
    const entries = [];
    for (const src of sources) {
        const buf = await readFile(src.absPath);
        const text = buf.toString("utf8");
        const { frontmatter, body, hasFrontmatter } = parseFrontmatter(text);
        const isSubFile = path.basename(src.absPath).startsWith("_");
        if (!hasFrontmatter && !isSubFile) {
            process.stderr.write(`warn: skipping ${src.relPath} — no frontmatter found in SKILL.md\n`);
            continue;
        }
        const srcSha256 = sha256Hex(buf);
        const bodyBytes = Buffer.byteLength(body, "utf8");
        if (bodyBytes > opts.maxEntry) {
            throw new Error(`entry too large: ${src.relPath} body is ${bodyBytes} bytes > --max-entry ${opts.maxEntry}`);
        }
        entries.push({
            name: src.skillName,
            path: src.relPath,
            frontmatter,
            body,
            srcSha256,
            sizeBytes: bodyBytes,
            bundledAt: generatedAt,
        });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const manifestSha256 = sha256Hex(canonicalJSON(entries));
    const bundle = {
        bundleVersion: 1,
        generatedAt,
        generator,
        manifestSha256,
        entries,
    };
    const serialized = JSON.stringify(bundle, null, 2) + "\n";
    const totalBytes = Buffer.byteLength(serialized, "utf8");
    if (totalBytes > opts.maxTotal) {
        throw new Error(`bundle too large: ${totalBytes} bytes > --max-total ${opts.maxTotal}`);
    }
    await atomicWriteJSON(opts.outputPath, serialized);
    return { bundle, outputPath: opts.outputPath, totalBytes };
}
export async function main(argv) {
    const { opts, error } = parseArgs(argv);
    if (error) {
        process.stderr.write(`build-skills-bundle: ${error}\n`);
        return 3;
    }
    if (opts.help) {
        process.stderr.write(helpText());
        return 0;
    }
    const sourceRoot = opts.sourceRoot
        ? path.resolve(process.cwd(), opts.sourceRoot)
        : findRepoRoot();
    const outputPath = opts.output
        ? path.resolve(process.cwd(), opts.output)
        : path.join(findMcpServerRoot(), DEFAULT_OUTPUT_REL);
    try {
        const result = await build({
            sourceRoot,
            outputPath,
            maxTotal: opts.maxTotal,
            maxEntry: opts.maxEntry,
        });
        process.stderr.write(`bundled ${result.bundle.entries.length} entries → ${result.outputPath} ` +
            `(${result.totalBytes} total, manifestSha256=${result.bundle.manifestSha256})\n`);
        return 0;
    }
    catch (err) {
        process.stderr.write(`build-skills-bundle: ${String(err)}\n`);
        return 1;
    }
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
        process.stderr.write(`build-skills-bundle: unexpected error: ${String(err)}\n`);
        process.exit(1);
    });
}
//# sourceMappingURL=build-skills-bundle.js.map