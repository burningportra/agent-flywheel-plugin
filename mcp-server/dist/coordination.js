import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { brExec, resilientExec } from "./cli-exec.js";
import { createLogger } from "./logger.js";
import { FlywheelError } from "./errors.js";
import { normalizeText } from "./utils/text-normalize.js";
const log = createLogger("coordination");
export function selectStrategy(backend) {
    if (backend.beads && backend.agentMail)
        return "beads+agentmail";
    if (backend.sophia)
        return "sophia";
    return "worktrees";
}
/**
 * Select coordination mode based on available backends.
 * When agent-mail is available, agents can safely share a single branch
 * using file reservations. Otherwise, fall back to worktree isolation.
 */
export function selectMode(backend) {
    return backend.agentMail ? "single-branch" : "worktree";
}
// ─── Detection ─────────────────────────────────────────────────
let _cached = null;
/**
 * Detect all available coordination backends. Cached after first call.
 * Call `resetDetection()` to force re-detect (e.g. after install).
 */
export async function detectCoordinationBackend(exec, cwd) {
    if (_cached)
        return _cached;
    const [beads, agentMail, sophia] = await Promise.all([
        detectBeads(exec, cwd),
        detectAgentMail(exec),
        detectSophia(exec, cwd),
    ]);
    const preCommitGuardInstalled = agentMail
        ? await checkPreCommitGuard(exec, cwd)
        : false;
    if (agentMail && !preCommitGuardInstalled) {
        log.warn("Agent Mail is available but the pre-commit guard is not installed. Run scaffoldPreCommitGuard() or set AGENT_NAME and install .git/hooks/pre-commit.");
    }
    _cached = { beads, agentMail, sophia, preCommitGuardInstalled };
    return _cached;
}
export function resetDetection() {
    _cached = null;
}
export function getCachedBackend() {
    return _cached;
}
// ─── Individual detectors ──────────────────────────────────────
async function detectBeads(exec, cwd) {
    // Check br CLI is installed
    const result = await brExec(exec, ["--help"], { timeout: 3000, cwd, maxRetries: 0 });
    if (!result.ok)
        return false;
    // Check .beads/ directory exists (initialized)
    return existsSync(join(cwd, ".beads"));
}
async function isAgentMailReachable(exec) {
    const result = await resilientExec(exec, "curl", [
        "-s", "--max-time", "2",
        "http://127.0.0.1:8765/health/liveness",
    ], { timeout: 3000, maxRetries: 0 });
    if (!result.ok)
        return false;
    try {
        const parsed = JSON.parse(result.value.stdout.trim());
        return parsed?.status === "ok" || parsed?.status === "healthy" || parsed?.status === "alive";
    }
    catch {
        return result.value.code === 0 && result.value.stdout.length > 0;
    }
}
async function detectAgentMail(exec) {
    // Check if already running
    if (await isAgentMailReachable(exec))
        return true;
    // Not running — check if installed and try to start it
    const whichResult = await resilientExec(exec, "uv", ["run", "python", "-c", "import mcp_agent_mail"], {
        timeout: 5000,
        maxRetries: 0,
    });
    if (!whichResult.ok || whichResult.value.code !== 0)
        return false; // not installed
    // Installed but not running — start in background
    const startResult = await resilientExec(exec, "bash", ["-c",
        "nohup uv run python -m mcp_agent_mail.cli serve-http > /dev/null 2>&1 &"
    ], { timeout: 5000, maxRetries: 0 });
    if (!startResult.ok)
        return false;
    // Wait up to ~5 seconds with exponential backoff (50ms → 100ms → 200ms → 400ms → 800ms → 1600ms)
    // Breaks immediately on success instead of polling full window
    for (const delayMs of [50, 100, 200, 400, 800, 1600]) {
        await new Promise((r) => setTimeout(r, delayMs));
        if (await isAgentMailReachable(exec))
            return true;
    }
    return false;
}
// ─── Pre-Commit Guard ──────────────────────────────────────────
/**
 * Check if the Agent Mail pre-commit guard is installed.
 * Returns true if .git/hooks/pre-commit exists and contains "AGENT_NAME" or "agent-mail".
 */
export async function checkPreCommitGuard(_exec, cwd) {
    try {
        const hookPath = join(cwd, ".git/hooks/pre-commit");
        if (!existsSync(hookPath))
            return false;
        const content = readFileSync(hookPath, "utf-8");
        return content.includes("AGENT_NAME") || content.includes("agent-mail");
    }
    catch {
        return false;
    }
}
/**
 * Write the Agent Mail pre-commit guard hook to .git/hooks/pre-commit.
 * The hook blocks commits when another agent has an exclusive file reservation.
 * Makes the hook executable.
 */
export async function scaffoldPreCommitGuard(_exec, cwd) {
    const hookPath = join(cwd, ".git/hooks/pre-commit");
    const script = `#!/bin/sh
# Agent Mail pre-commit guard
# Blocks commits to files exclusively reserved by another agent.
if [ -n "$AGENT_NAME" ]; then
  curl -s -X POST http://127.0.0.1:8765/api \\
    -H 'Content-Type: application/json' \\
    -d "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"tools/call\\",\\"params\\":{\\"name\\":\\"check_commit_conflicts\\",\\"arguments\\":{\\"human_key\\":\\"$(pwd)\\",\\"agent_name\\":\\"$AGENT_NAME\\"}}}" \\
    | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  conflicts=d.get('result',{}).get('structuredContent',{}).get('conflicts',[])
  if conflicts:
    [print(f'COMMIT BLOCKED — reservation conflict: {c}') for c in conflicts]
    sys.exit(1)
except Exception:
  pass  # agent-mail unavailable — allow commit
" 2>/dev/null
fi
`;
    writeFileSync(hookPath, script, "utf-8");
    chmodSync(hookPath, 0o755);
}
// ─── UBS Detection ─────────────────────────────────────────────
let _ubsAvailable = null;
/**
 * Detects whether the `ubs` CLI is available. Result is cached.
 */
export async function detectUbs(exec, cwd) {
    if (_ubsAvailable !== null)
        return _ubsAvailable;
    const result = await resilientExec(exec, "ubs", ["--help"], { timeout: 5000, cwd, maxRetries: 1, retryDelayMs: 500 });
    _ubsAvailable = result.ok && result.value.code === 0;
    return _ubsAvailable;
}
/** Reset UBS detection cache (for testing). */
export function resetUbsCache() {
    _ubsAvailable = null;
}
// ─── Wave Collision Detection (agent-flywheel-plugin-iy4) ───────
//
// Post-hoc, actual-modified-files reconciliation for swarm waves. After each
// worker in a wave commits, we run `git diff --name-only <wave-start-sha>..HEAD`
// in the worker's worktree to discover what it *actually* touched — not what
// it *declared* it would touch. Any path appearing in two or more workers'
// sets is a collision. Collisions force a serial re-run of the colliding
// units against the already-committed branch so the last writer doesn't
// silently win.
export const COLLISION_IGNORE_PATH = ".pi-flywheel/collision-ignore";
/** Default ignore patterns seeded into `.pi-flywheel/collision-ignore`. */
export const DEFAULT_COLLISION_IGNORE = [
    "package-lock.json",
    "__snapshots__/**",
    "*.generated.*",
];
/**
 * Capture the wave-start SHA from `git rev-parse HEAD` in `cwd`. Call this
 * immediately before dispatching workers so the diff window lines up.
 */
export async function captureWaveStartSha(exec, cwd) {
    const result = await exec("git", ["rev-parse", "HEAD"], { timeout: 5000, cwd });
    if (result.code !== 0) {
        throw new FlywheelError({
            code: "cli_failure",
            message: `git rev-parse HEAD failed in ${cwd}`,
            hint: "Check that git is installed and the cwd is a git repository; set FW_LOG_LEVEL=debug to see the git stderr.",
            cause: result.stderr.trim() || `exit ${result.code}`,
        });
    }
    const sha = result.stdout.trim();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) {
        throw new FlywheelError({
            code: "parse_failure",
            message: `git rev-parse returned an unexpected value`,
            hint: "git rev-parse HEAD returned a non-SHA value — retry; if persistent, run `git fsck` and set FW_LOG_LEVEL=debug.",
            cause: sha.slice(0, 80),
        });
    }
    return sha;
}
/**
 * Diff a worker's worktree against the wave-start SHA.
 * Returns the list of paths the worker actually modified.
 */
export async function diffWorkerAgainstWaveStart(exec, worktreeCwd, waveStartSha) {
    const result = await exec("git", ["diff", "--name-only", `${waveStartSha}..HEAD`], { timeout: 10000, cwd: worktreeCwd });
    if (result.code !== 0) {
        throw new FlywheelError({
            code: "cli_failure",
            message: `git diff --name-only failed in ${worktreeCwd}`,
            hint: "Check that the worktree exists and is a git repository; set FW_LOG_LEVEL=debug to see the git stderr.",
            cause: result.stderr.trim() || `exit ${result.code}`,
        });
    }
    return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}
/**
 * Load collision-ignore globs. Returns {@link DEFAULT_COLLISION_IGNORE} when
 * the file is absent. Blank lines and `#`-comments are stripped.
 */
export function loadCollisionIgnore(repoRoot) {
    const path = join(repoRoot, COLLISION_IGNORE_PATH);
    if (!existsSync(path))
        return [...DEFAULT_COLLISION_IGNORE];
    try {
        const body = normalizeText(readFileSync(path, "utf-8"));
        const patterns = body
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith("#"));
        return patterns.length > 0 ? patterns : [...DEFAULT_COLLISION_IGNORE];
    }
    catch {
        return [...DEFAULT_COLLISION_IGNORE];
    }
}
/**
 * Seed `.pi-flywheel/collision-ignore` with the default ignore set, if the
 * file does not already exist. Creates the parent directory as needed. This
 * is idempotent — existing user-edited files are never overwritten.
 */
export function seedCollisionIgnore(repoRoot) {
    const parent = join(repoRoot, ".pi-flywheel");
    const path = join(repoRoot, COLLISION_IGNORE_PATH);
    if (existsSync(path))
        return { created: false, path };
    mkdirSync(parent, { recursive: true });
    const body = [
        "# agent-flywheel-plugin-iy4 — wave collision ignore globs",
        "# One pattern per line. Blank lines and `#` comments are ignored.",
        "# Patterns use a minimal glob dialect: `*` (one segment), `**` (many",
        "# segments), and `?` (single char). Paths listed here never count as",
        "# collisions even if two workers edit them in the same wave.",
        "",
        ...DEFAULT_COLLISION_IGNORE,
        "",
    ].join("\n");
    writeFileSync(path, body, "utf-8");
    return { created: true, path };
}
/**
 * Minimal glob matcher. Supports `*`, `**`, and `?`. Paths are normalised to
 * forward-slash separators before matching. Avoids a minimatch/micromatch
 * dependency for the single use-case we need here.
 */
export function matchesGlob(pattern, path) {
    const normPath = path.replace(/\\/g, "/");
    const STAR_STAR = "\x00__STARSTAR__\x00";
    const STAR = "\x00__STAR__\x00";
    const QUESTION = "\x00__Q__\x00";
    const stamped = pattern
        .replace(/\\/g, "/")
        .replace(/\*\*/g, STAR_STAR)
        .replace(/\*/g, STAR)
        .replace(/\?/g, QUESTION);
    const escaped = stamped.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const regexBody = escaped
        .replace(new RegExp(STAR_STAR, "g"), ".*")
        .replace(new RegExp(STAR, "g"), "[^/]*")
        .replace(new RegExp(QUESTION, "g"), "[^/]");
    const anchored = new RegExp(`^${regexBody}$`);
    if (anchored.test(normPath))
        return true;
    // Bare basename patterns (no slash) also match the file's basename so that
    // `*.generated.*` catches `src/foo.generated.ts`.
    if (!pattern.includes("/")) {
        const base = normPath.split("/").pop() ?? normPath;
        return anchored.test(base);
    }
    return false;
}
/** Return true iff `path` matches any pattern in `patterns`. */
export function isIgnoredCollisionPath(path, patterns) {
    for (const p of patterns) {
        if (matchesGlob(p, path))
            return true;
    }
    return false;
}
/**
 * Aggregate per-worker touched files into a collision report. Files matching
 * the ignore-globs are dropped from both the per-unit sets and the collision
 * scan. A path is a collision iff two or more units touched it after the
 * filter.
 */
export function aggregateCollisions(waveStartSha, perWorker, ignorePatterns) {
    const touchedByUnit = {};
    const pathToUnits = new Map();
    for (const { unitId, touched } of perWorker) {
        const kept = [];
        for (const raw of touched) {
            if (isIgnoredCollisionPath(raw, ignorePatterns))
                continue;
            kept.push(raw);
            let bucket = pathToUnits.get(raw);
            if (!bucket) {
                bucket = new Set();
                pathToUnits.set(raw, bucket);
            }
            bucket.add(unitId);
        }
        touchedByUnit[unitId] = kept.sort();
    }
    const collisions = [];
    for (const [path, units] of pathToUnits) {
        if (units.size >= 2) {
            collisions.push({ path, unitIds: [...units].sort() });
        }
    }
    collisions.sort((a, b) => a.path.localeCompare(b.path));
    return {
        waveStartSha,
        touchedByUnit,
        collisions,
        hasCollision: collisions.length > 0,
    };
}
/**
 * End-to-end collision detection for a single wave.
 *
 * Steps:
 * 1. Diff each worker's worktree against {@link waveStartSha}.
 * 2. Load the project's ignore-globs from `.pi-flywheel/collision-ignore`
 *    (falling back to {@link DEFAULT_COLLISION_IGNORE}).
 * 3. Aggregate and return a {@link CollisionReport}.
 *
 * The caller decides what to do with a `hasCollision` report — see
 * {@link forceSerialRerun} for the canonical response.
 */
export async function detectWaveCollisions(exec, repoRoot, waveStartSha, workers) {
    const perWorker = [];
    for (const w of workers) {
        const touched = await diffWorkerAgainstWaveStart(exec, w.worktreeCwd, waveStartSha);
        perWorker.push({ unitId: w.unitId, touched });
    }
    const ignore = loadCollisionIgnore(repoRoot);
    return aggregateCollisions(waveStartSha, perWorker, ignore);
}
/**
 * Compute the colliding unit IDs (stable, sorted) from a report. Convenience
 * helper for orchestrators that only care which units need a serial re-run.
 */
export function collidingUnitIds(report) {
    const units = new Set();
    for (const entry of report.collisions) {
        for (const id of entry.unitIds)
            units.add(id);
    }
    return [...units].sort();
}
/** Canonical hint wording for the `wave_collision_detected` error. */
export const WAVE_COLLISION_HINT = "Colliding beads touched shared files; re-running serially against the already-committed branch";
/**
 * Strategy executor for the serial re-run. Given a report, call `runOne` for
 * each colliding unit in order. The caller's `runOne` is responsible for
 * checking out the already-committed branch and replaying the unit's work.
 *
 * Returns a map of unitId → runOne's return value for observability.
 */
export async function forceSerialRerun(report, runOne) {
    const out = {};
    for (const unitId of collidingUnitIds(report)) {
        out[unitId] = await runOne(unitId);
    }
    return out;
}
// ─── End collision detection ───────────────────────────────────
async function detectSophia(exec, cwd) {
    // CLI available
    const helpResult = await resilientExec(exec, "sophia", ["--help"], { timeout: 3000, cwd, maxRetries: 0 });
    if (!helpResult.ok || helpResult.value.code !== 0)
        return false;
    // SOPHIA.yaml present (initialized)
    if (!existsSync(join(cwd, "SOPHIA.yaml")))
        return false;
    // Can list CRs (fully functional)
    const listResult = await resilientExec(exec, "sophia", ["cr", "list", "--json"], { timeout: 3000, cwd, maxRetries: 0 });
    if (!listResult.ok || listResult.value.code !== 0)
        return false;
    try {
        const parsed = JSON.parse(listResult.value.stdout);
        return parsed.ok === true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=coordination.js.map