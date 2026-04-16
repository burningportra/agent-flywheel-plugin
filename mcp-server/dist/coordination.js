import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { brExec, resilientExec } from "./cli-exec.js";
import { createLogger } from "./logger.js";
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