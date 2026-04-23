import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createLintLogger } from "./logger.js";
import { normalizeText } from "../utils/text-normalize.js";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MANIFEST_REL = "mcp-server/.lintskill-manifest.json";
const DEFAULT_ALLOWLIST_REL = "mcp-server/.lintskill-allowlist.json";
const MAX_PLUGIN_DEPTH = 6;
const log = createLintLogger("skillRegistry");
function normalizeName(name) {
    return name.startsWith("/") ? name.slice(1) : name;
}
function withTimeout(p, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`registry timeout: ${label}`)), timeoutMs);
        p.then((v) => {
            clearTimeout(t);
            resolve(v);
        }, (e) => {
            clearTimeout(t);
            reject(e);
        });
    });
}
function checkAborted(signal) {
    if (signal?.aborted)
        throw new Error("aborted");
}
async function safeReaddir(dir, signal, timeoutMs) {
    const entries = await withTimeout(readdir(dir, { withFileTypes: true }), timeoutMs, `readdir ${dir}`);
    checkAborted(signal);
    return entries.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
    }));
}
async function loadRepoSkills(repoRoot, signal, timeoutMs) {
    const skillsDir = path.join(repoRoot, "skills");
    try {
        const entries = await safeReaddir(skillsDir, signal, timeoutMs);
        const names = [];
        for (const entry of entries) {
            if (!entry.isDirectory)
                continue;
            checkAborted(signal);
            const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
            try {
                const st = await withTimeout(stat(skillMd), timeoutMs, `stat ${skillMd}`);
                if (st.isFile()) {
                    names.push(entry.name.toLowerCase());
                }
            }
            catch {
                // No SKILL.md in this directory; skip.
            }
        }
        return names;
    }
    catch (err) {
        log.debug("repo skills layer skipped", { err: String(err), dir: skillsDir });
        return [];
    }
}
async function loadManifest(manifestAbs, signal, timeoutMs) {
    try {
        const raw = await withTimeout(readFile(manifestAbs, { encoding: "utf8", signal }), timeoutMs, `readFile ${manifestAbs}`);
        checkAborted(signal);
        let parsed;
        try {
            parsed = JSON.parse(normalizeText(raw));
        }
        catch (e) {
            log.debug("manifest invalid JSON", { path: manifestAbs, err: String(e) });
            return [];
        }
        if (!parsed ||
            typeof parsed !== "object" ||
            parsed.schemaVersion !== 1 ||
            !Array.isArray(parsed.skills)) {
            log.debug("manifest shape invalid", { path: manifestAbs });
            return [];
        }
        const skills = parsed.skills;
        return skills.filter((s) => typeof s === "string").map(normalizeName);
    }
    catch (err) {
        const code = err.code;
        if (code === "ENOENT")
            return [];
        log.debug("manifest read failed", { path: manifestAbs, err: String(err) });
        return [];
    }
}
async function loadAllowlist(allowlistAbs, signal, timeoutMs) {
    try {
        const raw = await withTimeout(readFile(allowlistAbs, { encoding: "utf8", signal }), timeoutMs, `readFile ${allowlistAbs}`);
        checkAborted(signal);
        let parsed;
        try {
            parsed = JSON.parse(normalizeText(raw));
        }
        catch (e) {
            log.debug("allowlist invalid JSON", { path: allowlistAbs, err: String(e) });
            return [];
        }
        if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== 1) {
            log.debug("allowlist shape invalid", { path: allowlistAbs });
            return [];
        }
        const known = parsed.knownExternalSlashes;
        if (!Array.isArray(known))
            return [];
        return known.filter((s) => typeof s === "string").map(normalizeName);
    }
    catch (err) {
        const code = err.code;
        if (code === "ENOENT")
            return [];
        log.debug("allowlist read failed", { path: allowlistAbs, err: String(err) });
        return [];
    }
}
async function walkPluginsForSkills(root, signal, timeoutMs) {
    const found = [];
    async function recur(dir, depth) {
        if (depth > MAX_PLUGIN_DEPTH)
            return;
        checkAborted(signal);
        let entries;
        try {
            entries = await safeReaddir(dir, signal, timeoutMs);
        }
        catch (err) {
            log.debug("plugins readdir failed", { dir, err: String(err) });
            return;
        }
        const isSkillsDir = path.basename(dir) === "skills";
        if (isSkillsDir) {
            for (const entry of entries) {
                if (!entry.isDirectory)
                    continue;
                const skillMd = path.join(dir, entry.name, "SKILL.md");
                try {
                    const st = await withTimeout(stat(skillMd), timeoutMs, `stat ${skillMd}`);
                    if (st.isFile()) {
                        found.push(entry.name.toLowerCase());
                    }
                }
                catch {
                    // No SKILL.md; skip.
                }
            }
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory)
                continue;
            if (entry.name.startsWith("."))
                continue;
            await recur(path.join(dir, entry.name), depth + 1);
        }
    }
    try {
        await recur(root, 0);
    }
    catch (err) {
        log.debug("plugins walk aborted", { root, err: String(err) });
    }
    return found;
}
function levenshtein(a, b) {
    if (a === b)
        return 0;
    if (a.length === 0)
        return b.length;
    if (b.length === 0)
        return a.length;
    const m = a.length;
    const n = b.length;
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++)
        prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        const ai = a.charCodeAt(i - 1);
        for (let j = 1; j <= n; j++) {
            const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
            const del = prev[j] + 1;
            const ins = curr[j - 1] + 1;
            const sub = prev[j - 1] + cost;
            curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}
export async function loadSkillRegistry(opts) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signal = opts.signal;
    const repoRoot = opts.repoRoot;
    const manifestAbs = path.isAbsolute(opts.manifestPath ?? "")
        ? opts.manifestPath
        : path.join(repoRoot, opts.manifestPath ?? DEFAULT_MANIFEST_REL);
    const allowlistAbs = path.isAbsolute(opts.allowlistPath ?? "")
        ? opts.allowlistPath
        : path.join(repoRoot, opts.allowlistPath ?? DEFAULT_ALLOWLIST_REL);
    const sources = new Map();
    const addLayer = (names, src) => {
        for (const raw of names) {
            const n = normalizeName(raw);
            if (!n)
                continue;
            if (!sources.has(n))
                sources.set(n, src);
        }
    };
    if (signal?.aborted) {
        log.debug("aborted before load");
        return makeRegistry(sources);
    }
    addLayer(await loadRepoSkills(repoRoot, signal, timeoutMs), "repo");
    addLayer(await loadManifest(manifestAbs, signal, timeoutMs), "manifest");
    addLayer(await loadAllowlist(allowlistAbs, signal, timeoutMs), "allowlist");
    if (!opts.ci && opts.pluginsRoot !== null) {
        const pluginsRoot = opts.pluginsRoot ?? path.join(os.homedir(), ".claude", "plugins");
        addLayer(await walkPluginsForSkills(pluginsRoot, signal, timeoutMs), "plugins");
    }
    return makeRegistry(sources);
}
function makeRegistry(sources) {
    const names = Array.from(sources.keys());
    return {
        size: names.length,
        has(slashName) {
            return sources.has(normalizeName(slashName));
        },
        source(slashName) {
            return sources.get(normalizeName(slashName));
        },
        suggest(slashName, k = 3) {
            const target = normalizeName(slashName);
            if (names.length === 0)
                return [];
            const scored = names
                .map((n) => ({ n, d: levenshtein(target, n) }))
                .filter((x) => x.d <= 5)
                .sort((a, b) => (a.d - b.d) || a.n.localeCompare(b.n));
            return scored.slice(0, Math.max(0, k)).map((x) => x.n);
        },
    };
}
//# sourceMappingURL=skillRegistry.js.map