import type { CoordinationMode } from "./types.js";
import type { ExecFn } from "./exec.js";
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
export type CoordinationStrategy = "beads+agentmail" | "sophia" | "worktrees";
export declare function selectStrategy(backend: CoordinationBackend): CoordinationStrategy;
/**
 * Select coordination mode based on available backends.
 * When agent-mail is available, agents can safely share a single branch
 * using file reservations. Otherwise, fall back to worktree isolation.
 */
export declare function selectMode(backend: CoordinationBackend): CoordinationMode;
/**
 * Detect all available coordination backends. Cached after first call.
 * Call `resetDetection()` to force re-detect (e.g. after install).
 */
export declare function detectCoordinationBackend(exec: ExecFn, cwd: string): Promise<CoordinationBackend>;
export declare function resetDetection(): void;
export declare function getCachedBackend(): CoordinationBackend | null;
/**
 * Check if the Agent Mail pre-commit guard is installed.
 * Returns true if .git/hooks/pre-commit exists and contains "AGENT_NAME" or "agent-mail".
 */
export declare function checkPreCommitGuard(_exec: ExecFn, cwd: string): Promise<boolean>;
/**
 * Write the Agent Mail pre-commit guard hook to .git/hooks/pre-commit.
 * The hook blocks commits when another agent has an exclusive file reservation.
 * Makes the hook executable.
 */
export declare function scaffoldPreCommitGuard(_exec: ExecFn, cwd: string): Promise<void>;
/**
 * Detects whether the `ubs` CLI is available. Result is cached.
 */
export declare function detectUbs(exec: ExecFn, cwd: string): Promise<boolean>;
/** Reset UBS detection cache (for testing). */
export declare function resetUbsCache(): void;
//# sourceMappingURL=coordination.d.ts.map