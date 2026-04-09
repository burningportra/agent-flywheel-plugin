import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import type { CoordinationMode } from "./types.js";
import type { ExecFn } from "./agent-mail.js";
import { brExec, resilientExec } from "./cli-exec.js";
import { createLogger } from "./logger.js";

const log = createLogger("coordination");

// ─── Types ─────────────────────────────────────────────────────

export interface CoordinationBackend {
  /** br CLI installed AND .beads/ initialized in project */
  beads: boolean;
  /** Agent-mail MCP server reachable */
  agentMail: boolean;
  /** Sophia CLI installed AND SOPHIA.yaml present */
  sophia: boolean;
  /** Whether .git/hooks/pre-commit contains the agent-mail guard */
  preCommitGuardInstalled?: boolean;
}

/**
 * Coordination strategy derived from available backends.
 *
 * - "beads+agentmail": full coordination — beads for task lifecycle, agent-mail for messaging + file reservations
 * - "sophia": legacy — sophia CR/task lifecycle, worktrees for isolation
 * - "worktrees": bare — worktree isolation only, no task tracking or messaging
 */
export type CoordinationStrategy =
  | "beads+agentmail"
  | "sophia"
  | "worktrees";

export function selectStrategy(backend: CoordinationBackend): CoordinationStrategy {
  if (backend.beads && backend.agentMail) return "beads+agentmail";
  if (backend.sophia) return "sophia";
  return "worktrees";
}

/**
 * Select coordination mode based on available backends.
 * When agent-mail is available, agents can safely share a single branch
 * using file reservations. Otherwise, fall back to worktree isolation.
 */
export function selectMode(backend: CoordinationBackend): CoordinationMode {
  return backend.agentMail ? "single-branch" : "worktree";
}

// ─── Detection ─────────────────────────────────────────────────

let _cached: CoordinationBackend | null = null;

/**
 * Detect all available coordination backends. Cached after first call.
 * Call `resetDetection()` to force re-detect (e.g. after install).
 */
export async function detectCoordinationBackend(
  exec: ExecFn,
  cwd: string
): Promise<CoordinationBackend> {
  if (_cached) return _cached;

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

export function resetDetection(): void {
  _cached = null;
}

export function getCachedBackend(): CoordinationBackend | null {
  return _cached;
}

// ─── Individual detectors ──────────────────────────────────────

async function detectBeads(exec: ExecFn, cwd: string): Promise<boolean> {
  // Check br CLI is installed
  const result = await brExec(exec, ["--help"], { timeout: 3000, cwd, maxRetries: 0 });
  if (!result.ok) return false;

  // Check .beads/ directory exists (initialized)
  return existsSync(join(cwd, ".beads"));
}

async function isAgentMailReachable(exec: ExecFn): Promise<boolean> {
  const result = await resilientExec(exec, "curl", [
    "-s", "--max-time", "2",
    "http://127.0.0.1:8765/health/liveness",
  ], { timeout: 5000, maxRetries: 1 });
  if (!result.ok) return false;
  try {
    const parsed = JSON.parse(result.value.stdout.trim());
    return parsed?.status === "ok" || parsed?.status === "healthy" || parsed?.status === "alive";
  } catch {
    return result.value.code === 0 && result.value.stdout.length > 0;
  }
}

async function detectAgentMail(exec: ExecFn): Promise<boolean> {
  // Check if already running
  if (await isAgentMailReachable(exec)) return true;

  // Not running — check if installed and try to start it
  const whichResult = await resilientExec(exec, "uv", ["run", "python", "-c", "import mcp_agent_mail"], {
    timeout: 5000,
    maxRetries: 0,
  });
  if (!whichResult.ok || whichResult.value.code !== 0) return false; // not installed

  // Installed but not running — start in background
  const startResult = await resilientExec(exec, "bash", ["-c",
    "nohup uv run python -m mcp_agent_mail.cli serve-http > /dev/null 2>&1 &"
  ], { timeout: 5000, maxRetries: 0 });

  if (!startResult.ok) return false;

  // Wait up to 5 seconds for it to become reachable
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isAgentMailReachable(exec)) return true;
  }

  return false;
}

// ─── Pre-Commit Guard ──────────────────────────────────────────

/**
 * Check if the Agent Mail pre-commit guard is installed.
 * Returns true if .git/hooks/pre-commit exists and contains "AGENT_NAME" or "agent-mail".
 */
export async function checkPreCommitGuard(
  _exec: ExecFn,
  cwd: string
): Promise<boolean> {
  try {
    const hookPath = join(cwd, ".git/hooks/pre-commit");
    if (!existsSync(hookPath)) return false;
    const content = readFileSync(hookPath, "utf-8");
    return content.includes("AGENT_NAME") || content.includes("agent-mail");
  } catch {
    return false;
  }
}

/**
 * Write the Agent Mail pre-commit guard hook to .git/hooks/pre-commit.
 * The hook blocks commits when another agent has an exclusive file reservation.
 * Makes the hook executable.
 */
export async function scaffoldPreCommitGuard(
  _exec: ExecFn,
  cwd: string
): Promise<void> {
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

let _ubsAvailable: boolean | null = null;

/**
 * Detects whether the `ubs` CLI is available. Result is cached.
 */
export async function detectUbs(exec: ExecFn, cwd: string): Promise<boolean> {
  if (_ubsAvailable !== null) return _ubsAvailable;
  const result = await resilientExec(exec, "ubs", ["--help"], { timeout: 3000, cwd, maxRetries: 0 });
  _ubsAvailable = result.ok && result.value.code === 0;
  return _ubsAvailable;
}

/** Reset UBS detection cache (for testing). */
export function resetUbsCache(): void {
  _ubsAvailable = null;
}

async function detectSophia(exec: ExecFn, cwd: string): Promise<boolean> {
  // CLI available
  const helpResult = await resilientExec(exec, "sophia", ["--help"], { timeout: 3000, cwd, maxRetries: 0 });
  if (!helpResult.ok || helpResult.value.code !== 0) return false;

  // SOPHIA.yaml present (initialized)
  if (!existsSync(join(cwd, "SOPHIA.yaml"))) return false;

  // Can list CRs (fully functional)
  const listResult = await resilientExec(exec, "sophia", ["cr", "list", "--json"], { timeout: 3000, cwd, maxRetries: 0 });
  if (!listResult.ok || listResult.value.code !== 0) return false;

  try {
    const parsed = JSON.parse(listResult.value.stdout);
    return parsed.ok === true;
  } catch {
    return false;
  }
}
