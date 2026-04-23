import { execFileSync } from "child_process";
import { basename, dirname } from "path";
import { PostmortemDraftSchema, } from "./types.js";
import { resilientExec } from "./cli-exec.js";
import { agentMailRPC, unwrapRPC } from "./agent-mail.js";
import { createLogger } from "./logger.js";
import { SolutionDocSchema, inferSolutionCategory, slugifySolutionTitle, } from "./solution-doc-schema.js";
const log = createLogger("episodic-memory");
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
const POSTMORTEM_GIT_TIMEOUT_MS = 8_000;
/**
 * Determine the git log range for the post-mortem draft.
 *
 * Strategy:
 *   1. Try `<sessionStartSha>..HEAD` if sessionStartSha is set AND
 *      `git cat-file -e <sha>` succeeds.
 *   2. Else try merge-base against main: `<merge-base>..HEAD`.
 *   3. Else fall back to `HEAD~10..HEAD`.
 *
 * Emits `postmortem_checkpoint_stale` when step 1 was attempted but failed
 * (indicating an intentional sessionStartSha couldn't be honoured), as well
 * as when step 1 wasn't available and we fell back to a best-guess range.
 */
async function resolveRange(ctx) {
    const warnings = [];
    const { cwd, sessionStartSha, exec, signal } = ctx;
    // Step 1 — Try sessionStartSha..HEAD
    if (sessionStartSha && sessionStartSha.trim().length > 0) {
        const shaExists = await resilientExec(exec, "git", ["cat-file", "-e", sessionStartSha.trim()], { cwd, timeout: POSTMORTEM_GIT_TIMEOUT_MS, signal, maxRetries: 0, logWarnings: false });
        if (shaExists.ok) {
            return { range: `${sessionStartSha.trim()}..HEAD`, warnings };
        }
        // sessionStartSha was set but isn't in the git log — fall through to
        // fallbacks and record the staleness.
        warnings.push("postmortem_checkpoint_stale");
    }
    // Step 2 — merge-base against main
    const mergeBase = await resilientExec(exec, "git", ["merge-base", "HEAD", "main"], { cwd, timeout: POSTMORTEM_GIT_TIMEOUT_MS, signal, maxRetries: 0, logWarnings: false });
    if (mergeBase.ok && mergeBase.value.stdout.trim().length > 0) {
        const baseSha = mergeBase.value.stdout.trim().split(/\s+/)[0];
        return { range: `${baseSha}..HEAD`, warnings };
    }
    // Step 3 — final fallback
    if (!warnings.includes("postmortem_checkpoint_stale")) {
        warnings.push("postmortem_checkpoint_stale");
    }
    return { range: "HEAD~10..HEAD", warnings };
}
/** Parse `git log --pretty=format:'%h|%s|%an'` output. */
function parseCommits(stdout) {
    const out = [];
    for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        const parts = trimmed.split("|");
        if (parts.length < 2)
            continue;
        const [sha, subject, author] = parts;
        out.push({
            sha: (sha ?? "").trim(),
            subject: (subject ?? "").trim(),
            author: (author ?? "").trim(),
        });
    }
    return out;
}
/**
 * Parse `git log --stat` into a list of files with aggregate change counts.
 * Stat lines look like: " path/to/file | 12 +++--"
 * Returns top-3 by change count.
 */
function parseTopTouchedFiles(stdout, limit = 3) {
    const totals = new Map();
    for (const rawLine of stdout.split("\n")) {
        // Drop leading/trailing whitespace; skip summary lines like
        // "N files changed, …"
        const line = rawLine.trim();
        if (!line || /files? changed/i.test(line))
            continue;
        // Format: "path | N +++--" or "path | Bin"
        const m = line.match(/^(.+?)\s+\|\s+(\d+|Bin)\b/);
        if (!m)
            continue;
        const file = m[1].trim();
        const count = m[2] === "Bin" ? 1 : parseInt(m[2], 10);
        if (!file || !Number.isFinite(count))
            continue;
        totals.set(file, (totals.get(file) ?? 0) + count);
    }
    return [...totals.entries()]
        .map(([path, changes]) => ({ path, changes }))
        .sort((a, b) => b.changes - a.changes)
        .slice(0, limit);
}
async function fetchCommits(ctx, range) {
    const res = await resilientExec(ctx.exec, "git", ["log", range, "--pretty=format:%h|%s|%an", "--no-merges"], { cwd: ctx.cwd, timeout: POSTMORTEM_GIT_TIMEOUT_MS, signal: ctx.signal, maxRetries: 0, logWarnings: false });
    if (!res.ok)
        return [];
    return parseCommits(res.value.stdout);
}
async function fetchTopTouchedFiles(ctx, range) {
    const res = await resilientExec(ctx.exec, "git", ["log", range, "--stat", "--no-merges", "--pretty=format:"], { cwd: ctx.cwd, timeout: POSTMORTEM_GIT_TIMEOUT_MS, signal: ctx.signal, maxRetries: 0, logWarnings: false });
    if (!res.ok)
        return [];
    return parseTopTouchedFiles(res.value.stdout, 3);
}
/**
 * Pull recent inbox messages and extract completion-style `[impl] …` subjects
 * plus blocker-style subjects (importance=high or contains "blocked"/"failed").
 *
 * Silently tolerates agent-mail being offline — returns empty lists. Uses
 * `include_bodies: false` to stay lightweight as required by the spec.
 */
async function fetchInboxSummary(ctx) {
    const agentName = ctx.agentName ?? "FlywheelAgent";
    let rpcResult;
    try {
        rpcResult = unwrapRPC(await agentMailRPC(ctx.exec, "fetch_inbox", {
            project_key: ctx.cwd,
            agent_name: agentName,
            include_bodies: false,
            limit: 50,
        }));
    }
    catch (err) {
        log.debug("agent-mail fetch_inbox threw; skipping", {
            err: err instanceof Error ? err.message : String(err),
        });
        return { completions: [], blockers: [], coordinatorAgent: null };
    }
    const messages = Array.isArray(rpcResult?.messages)
        ? rpcResult.messages
        : Array.isArray(rpcResult?.inbox)
            ? rpcResult.inbox
            : Array.isArray(rpcResult)
                ? rpcResult
                : [];
    const completions = [];
    const blockers = [];
    let coordinator = null;
    for (const msg of messages) {
        const subject = typeof msg.subject === "string" ? msg.subject : "";
        const sender = typeof msg.sender_name === "string" ? msg.sender_name : "";
        const importance = typeof msg.importance === "string" ? msg.importance : "";
        if (subject.includes("[impl]") && completions.length < 10) {
            completions.push({ subject, sender });
        }
        if ((importance === "high" || importance === "urgent" ||
            /blocked|failed|abort|error/i.test(subject)) &&
            blockers.length < 5) {
            blockers.push({ subject, sender });
        }
        if (!coordinator && sender) {
            // First sender that looks like a coordinator — heuristic: TitleCase name.
            if (/^[A-Z][a-zA-Z]+[A-Z][a-zA-Z]+/.test(sender))
                coordinator = sender;
        }
    }
    return { completions, blockers, coordinatorAgent: coordinator };
}
function topErrorCodes(telemetry, limit = 5) {
    if (!telemetry || !telemetry.counts)
        return [];
    return Object.entries(telemetry.counts)
        .map(([code, count]) => ({ code, count: Number(count) || 0 }))
        .filter((e) => e.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
}
function renderMarkdown(goal, inputs) {
    const today = new Date().toISOString().slice(0, 10);
    const lines = [];
    lines.push(`Session (${today}): ${goal}`);
    lines.push("");
    // ── What shipped ──────────────────────────────────────────
    lines.push("## What shipped");
    if (inputs.commits.length === 0) {
        lines.push("- (no commits in range)");
    }
    else {
        for (const c of inputs.commits) {
            lines.push(`- ${c.sha} ${c.subject}`);
        }
    }
    lines.push("");
    // ── What failed ───────────────────────────────────────────
    lines.push("## What failed");
    if (inputs.blockers.length === 0) {
        lines.push("- (no blocker messages surfaced)");
    }
    else {
        for (const b of inputs.blockers) {
            const from = b.sender ? ` (from ${b.sender})` : "";
            lines.push(`- ${b.subject}${from}`);
        }
    }
    lines.push("");
    // ── Completion messages (top-10 [impl] subjects) ─────────
    if (inputs.completions.length > 0) {
        lines.push("## Completion messages");
        for (const m of inputs.completions) {
            const from = m.sender ? ` (from ${m.sender})` : "";
            lines.push(`- ${m.subject}${from}`);
        }
        lines.push("");
    }
    // ── Top error codes ──────────────────────────────────────
    lines.push("## Top error codes");
    if (inputs.topErrorCodes.length === 0) {
        lines.push("- (none recorded)");
    }
    else {
        for (const e of inputs.topErrorCodes) {
            lines.push(`- ${e.code}: ${e.count}`);
        }
    }
    lines.push("");
    // ── Related files (top-3) ────────────────────────────────
    lines.push("## Related files");
    if (inputs.touchedFiles.length === 0) {
        lines.push("- (none)");
    }
    else {
        for (const f of inputs.touchedFiles) {
            lines.push(`- ${f.path} (${f.changes} changes)`);
        }
    }
    lines.push("");
    // ── Coordinator ──────────────────────────────────────────
    lines.push("## Coordinator session identity");
    lines.push(inputs.coordinatorAgent ?? "(unknown — agent-mail unavailable or no identity resolved)");
    return lines.join("\n");
}
/**
 * Draft a post-mortem summary for the current session. Read-only — NEVER
 * writes to CASS / calls `flywheel_memory` with `operation: 'store'`. The
 * tool layer gates persistence via the user.
 *
 * P-1 / P-2 / P-4 are enforced by never throwing on degraded input: every
 * branch produces a valid Zod-parsed `PostmortemDraft` with warnings[]
 * populated when inputs were partial.
 */
export async function draftPostmortem(ctx) {
    const { range, warnings } = await resolveRange(ctx);
    const commits = await fetchCommits(ctx, range);
    // P-1: empty session → terse draft with warning.
    if (commits.length === 0) {
        warnings.push("postmortem_empty_session");
    }
    const touchedFiles = commits.length === 0 ? [] : await fetchTopTouchedFiles(ctx, range);
    const { completions, blockers, coordinatorAgent } = await fetchInboxSummary(ctx);
    const errorCodes = topErrorCodes(ctx.errorCodeTelemetry);
    const inputs = {
        range,
        commits,
        touchedFiles,
        completions,
        blockers,
        topErrorCodes: errorCodes,
        coordinatorAgent,
        warnings,
    };
    const markdown = renderMarkdown(ctx.goal, inputs);
    const dedupedWarnings = [...new Set(warnings)];
    const candidate = {
        version: 1,
        sessionStartSha: ctx.sessionStartSha,
        goal: ctx.goal,
        phase: ctx.phase,
        markdown,
        hasWarnings: dedupedWarnings.length > 0,
        warnings: dedupedWarnings,
    };
    // G-1 invariant: Zod-parse every MCP-boundary output.
    return PostmortemDraftSchema.parse(candidate);
}
/**
 * Format a `PostmortemDraft` for human display. The canonical markdown body
 * already lives in `draft.markdown`; this helper prepends the warning banner
 * when `hasWarnings` is true so callers (tool layer + user) see the
 * degraded-input signal without parsing `warnings[]` themselves.
 */
export function formatPostmortemMarkdown(draft) {
    if (!draft.hasWarnings || draft.warnings.length === 0)
        return draft.markdown;
    const banner = `> **Warnings:** ${draft.warnings.join(", ")}`;
    return `${banner}\n\n${draft.markdown}`;
}
/**
 * Derive a one-line problem_type tag from the session goal + warnings.
 * Pure heuristic — downstream bead `bve` can override with richer logic.
 */
function deriveProblemType(goal, warnings) {
    const g = goal.toLowerCase();
    if (warnings.some((w) => w === "postmortem_empty_session"))
        return "empty_session";
    if (warnings.some((w) => w === "postmortem_checkpoint_stale"))
        return "stale_checkpoint";
    if (/flak/.test(g))
        return "flaky_test";
    if (/timeout|hang/.test(g))
        return "timeout";
    if (/leak/.test(g))
        return "resource_leak";
    if (/fix\b|\bbug\b/.test(g))
        return "bug_fix";
    if (/refactor|rename|extract/.test(g))
        return "refactor";
    if (/add\b|feat|feature/.test(g))
        return "new_feature";
    return "session_learning";
}
/**
 * Pick a dominant `component` name from the top-touched files list.
 * Strategy: take the file with the highest change count, strip extension
 * and leading directories. Falls back to "unknown" when nothing is touched.
 */
function deriveComponent(touchedFiles) {
    if (touchedFiles.length === 0)
        return "unknown";
    const top = touchedFiles[0].path;
    // Example transforms:
    //   "mcp-server/src/episodic-memory.ts" -> "episodic-memory"
    //   "skills/start/_wrapup.md"           -> "_wrapup"
    //   "README.md"                         -> "README"
    const base = top.split("/").pop() ?? top;
    return base.replace(/\.[A-Za-z0-9]+$/, "") || "unknown";
}
/**
 * Today's date in YYYY-MM-DD form. Extracted so tests can stub via
 * `Date` mocking without touching module internals.
 */
function todayIso() {
    return new Date().toISOString().slice(0, 10);
}
/**
 * Draft a `SolutionDoc` (durable docs/solutions/ learning entry) from the
 * session context. Read-only — NEVER writes to disk or CASS. The wrap-up
 * skill (`skills/start/_wrapup.md` Step 10.55) is responsible for writing
 * the rendered markdown via the native Write tool.
 *
 * Invariants:
 *   S-1: Non-throwing — degraded inputs still yield a Zod-valid SolutionDoc.
 *   S-2: Frontmatter always includes a non-empty `entry_id` (F-1).
 *   S-3: Path conforms to `docs/solutions/<category>/<slug>-YYYY-MM-DD.md`.
 *   S-4: `body` re-uses the post-mortem markdown so both artifacts share
 *        the same shipping / failing / error-codes narrative.
 *
 * Leaves a stable contract for downstream bead `bve` (compound-refresh)
 * which joins CASS and docs/solutions/ on `frontmatter.entry_id`.
 */
export async function draftSolutionDoc(ctx) {
    const postmortem = ctx.postmortem ?? (await draftPostmortem(ctx));
    // Recompute touchedFiles for component inference. We run a cheap re-fetch
    // only when we had to compute the post-mortem ourselves *and* a pre-parsed
    // list wasn't supplied — for the common wrap-up path the post-mortem has
    // already walked git-log, so we parse its markdown to recover the list.
    const touchedFiles = parseTouchedFilesFromMarkdown(postmortem.markdown);
    const category = inferSolutionCategory(ctx.goal, touchedFiles.map((f) => f.path));
    const slug = slugifySolutionTitle(ctx.goal);
    const created_at = todayIso();
    const path = `docs/solutions/${category}/${slug}-${created_at}.md`;
    const problem_type = deriveProblemType(ctx.goal, postmortem.warnings);
    const component = deriveComponent(touchedFiles);
    const tags = Array.from(new Set([
        category,
        problem_type,
        ctx.phase && ctx.phase !== "idle" ? `phase:${ctx.phase}` : null,
    ].filter((t) => !!t)));
    const applies_when = postmortem.warnings.length > 0
        ? `session ended with warnings: ${postmortem.warnings.join(", ")}`
        : `session goal: ${ctx.goal}`;
    // Body re-uses the post-mortem markdown (S-4) + a small provenance
    // footer so grep hits show the CASS entry_id inline.
    const body = [
        postmortem.markdown,
        "",
        "---",
        `_CASS entry: ${ctx.entryId}_`,
    ].join("\n");
    const candidate = {
        path,
        frontmatter: {
            entry_id: ctx.entryId,
            problem_type,
            component,
            tags,
            applies_when,
            created_at,
        },
        body,
    };
    return SolutionDocSchema.parse(candidate);
}
/**
 * Recover touched-file paths from a rendered post-mortem markdown string.
 * Looks for the `## Related files` section and parses `- <path> (<N> changes)`
 * lines. Returns an empty list on any parse failure — non-throwing.
 */
function parseTouchedFilesFromMarkdown(markdown) {
    const out = [];
    const lines = markdown.split("\n");
    let inSection = false;
    for (const raw of lines) {
        const line = raw.trim();
        if (line === "## Related files") {
            inSection = true;
            continue;
        }
        if (inSection) {
            if (line.startsWith("## "))
                break; // next section
            if (!line.startsWith("- "))
                continue;
            const m = line.match(/^- (.+?) \((\d+) changes\)$/);
            if (!m)
                continue;
            out.push({ path: m[1], changes: parseInt(m[2], 10) });
        }
    }
    return out;
}
//# sourceMappingURL=episodic-memory.js.map