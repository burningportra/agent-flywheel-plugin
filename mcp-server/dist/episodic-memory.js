import { execFileSync } from "child_process";
import { basename, dirname } from "path";
// ─── MemPalace Detection ─────────────────────────────────────
let _mempalaceAvailable = null;
let _mempalaceCheckedAt = 0;
const MEMPALACE_FALSE_CACHE_MS = 5_000;
function probeMempalace() {
    try {
        // Use `status` — it exists in all versions and exits 0 whether or not
        // a palace has been initialised. (`--version` is not a valid flag.)
        execFileSync("python3", ["-m", "mempalace", "status"], {
            timeout: 3000,
            stdio: "pipe",
        });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Check if python3 -m mempalace is available.
 *
 * Caches true permanently (process lifetime) — once found, always found.
 * Caches false briefly (5s) to avoid stale negatives if mempalace is installed
 * partway through a session.
 */
export function detectMempalace() {
    const now = Date.now();
    if (_mempalaceAvailable === true)
        return true;
    if (_mempalaceAvailable === false && now - _mempalaceCheckedAt < MEMPALACE_FALSE_CACHE_MS) {
        return false;
    }
    const available = probeMempalace();
    _mempalaceAvailable = available;
    _mempalaceCheckedAt = now;
    return available;
}
/** Reset detection cache (for testing). */
export function resetMempalaceDetection() {
    _mempalaceAvailable = null;
    _mempalaceCheckedAt = 0;
}
// ─── Helpers ────────────────────────────────────────────────
function runMempalace(args, timeoutMs = 10_000) {
    try {
        const result = execFileSync("python3", ["-m", "mempalace", ...args], {
            timeout: timeoutMs,
            stdio: "pipe",
            encoding: "utf8",
        });
        return result;
    }
    catch {
        return null;
    }
}
// ─── Core API ────────────────────────────────────────────────
/**
 * Mine pi session transcripts into MemPalace under the given wing.
 *
 * Passes the parent directory of the transcript (the project's sessions folder)
 * rather than the individual file, because the mempalace `mine` CLI only accepts
 * directories. MemPalace deduplicates automatically, so already-filed sessions
 * are skipped and only new ones are processed.
 *
 * Uses --mode convos (exchange-pair chunking for human/assistant turns)
 * and --extract general (classifies chunks into decisions/preferences/
 * milestones/problems/emotional).
 *
 * @param transcriptPath - Absolute path to a pi session .jsonl file
 * @param projectSlug    - Wing name (e.g. "pi-flywheel"). Use sanitiseSlug().
 * @returns true if CLI exited 0, false on any error. Never throws.
 */
export function mineSession(transcriptPath, projectSlug) {
    if (!detectMempalace())
        return false;
    try {
        execFileSync("python3", [
            "-m", "mempalace",
            "mine", dirname(transcriptPath),
            "--mode", "convos",
            "--wing", projectSlug,
            "--extract", "general",
        ], { timeout: 30_000, stdio: "pipe" });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Semantic search over MemPalace. Returns a formatted string ready for
 * prompt injection, or "" if mempalace is unavailable or yields no results.
 *
 * Output format per result:
 *   [<wing> / <room>] (sim=<similarity>)
 *     <text excerpt>
 */
/**
 * Parse the plain-text output of `mempalace search`.
 *
 * Each result block looks like:
 *   [N] wing / room
 *       Source: filename
 *       Match:  0.XXX
 *
 *       <text lines...>
 *   ────...
 */
function parseSearchOutput(raw) {
    const results = [];
    // Split on the horizontal-rule separator between results
    const blocks = raw.split(/\n\s*[─]+\s*\n/);
    for (const block of blocks) {
        // Look for the result header:  [N] wing / room
        const headerMatch = block.match(/\[\d+\]\s+([^/]+)\/\s*(.+)/);
        if (!headerMatch)
            continue;
        const wing = headerMatch[1].trim();
        const room = headerMatch[2].trim();
        // Similarity score
        const matchLine = block.match(/Match:\s+([0-9.]+)/);
        const similarity = matchLine ? parseFloat(matchLine[1]) : 0;
        // Content: everything after the blank line that follows the Match line,
        // with leading 6-space indentation stripped.
        const contentMatch = block.match(/Match:\s+[0-9.]+\n\n([\s\S]+)/);
        if (!contentMatch)
            continue;
        const text = contentMatch[1]
            .split("\n")
            .map((l) => l.replace(/^      /, "")) // strip 6-space indent
            .join("\n")
            .trim();
        if (!text)
            continue;
        results.push({ wing, room, similarity, text });
    }
    return results;
}
export function searchEpisodic(query, options) {
    if (!detectMempalace())
        return "";
    const nResults = options?.nResults ?? 5;
    // `--results` is the correct flag (not `--n`); no `--json` flag exists.
    const args = ["search", query, "--results", String(nResults)];
    if (options?.wing)
        args.push("--wing", options.wing);
    const raw = runMempalace(args);
    if (!raw)
        return "";
    const results = parseSearchOutput(raw);
    if (results.length === 0)
        return "";
    return results
        .map((r) => {
        const sim = r.similarity.toFixed(2);
        const text = r.text.replace(/\n/g, "\n  ");
        return `[${r.wing} / ${r.room}] (sim=${sim})\n  ${text}`;
    })
        .join("\n\n");
}
/**
 * High-level: get episodic context for a task/goal.
 *
 * Searches MemPalace for relevant past sessions, wraps results in a
 * ## Past Session Examples header suitable for prompt injection.
 * Returns "" if mempalace unavailable or no relevant results found.
 */
export function getEpisodicContext(task, projectSlug) {
    const results = searchEpisodic(task, { wing: projectSlug, nResults: 5 });
    if (!results)
        return "";
    return `## Past Session Examples\n${results}\n`;
}
/**
 * Get MemPalace stats — path and drawer count.
 * Returns a safe zero-value struct on any error. Never throws.
 */
/**
 * Parse plain-text `mempalace status` output.
 *
 * Looks for the total drawer count on the header line:
 *   MemPalace Status — 2595 drawers
 * and the palace path from the default location (~/.mempalace/palace).
 */
function parseStatusOutput(raw) {
    const countMatch = raw.match(/Status[^\n]*—\s*([\d,]+)\s+drawer/);
    const drawerCount = countMatch ? parseInt(countMatch[1].replace(/,/g, ""), 10) : 0;
    // Palace path isn't printed in status output; derive from HOME convention.
    const home = process.env.HOME ?? "";
    const palacePath = home ? `${home}/.mempalace/palace` : null;
    return { drawerCount, palacePath };
}
export function getEpisodicStats() {
    if (!detectMempalace()) {
        return { available: false, palacePath: null, drawerCount: 0 };
    }
    // No `--json` flag exists; parse plain-text output instead.
    const raw = runMempalace(["status"]);
    if (!raw)
        return { available: true, palacePath: null, drawerCount: 0 };
    const { drawerCount, palacePath } = parseStatusOutput(raw);
    return { available: true, palacePath, drawerCount };
}
/**
 * Sanitise a directory basename into a MemPalace wing slug.
 * Replaces any non-alphanumeric character with "-".
 *
 * Example: "/Volumes/1tb/Projects/pi-flywheel" → "pi-flywheel"
 *          "my project (v2)" → "my-project--v2-"
 */
export function sanitiseSlug(cwd) {
    return basename(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}
//# sourceMappingURL=episodic-memory.js.map