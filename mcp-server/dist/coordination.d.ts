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
export declare const COLLISION_IGNORE_PATH = ".pi-flywheel/collision-ignore";
/** Default ignore patterns seeded into `.pi-flywheel/collision-ignore`. */
export declare const DEFAULT_COLLISION_IGNORE: readonly string[];
/** Per-worker output of the wave — the worktree cwd and which unit it ran. */
export interface WaveWorkerResult {
    /** Stable identifier for the unit of work (bead ID, step index, etc.). */
    unitId: string;
    /** Absolute path to the worktree where the worker executed. */
    worktreeCwd: string;
}
/** One collision entry — a path and every unit that touched it. */
export interface CollisionEntry {
    path: string;
    unitIds: string[];
}
/** Report returned by {@link detectWaveCollisions}. */
export interface CollisionReport {
    /** Git SHA captured before the wave was dispatched. */
    waveStartSha: string;
    /** Files touched by each unit, after ignore-globs filter. */
    touchedByUnit: Record<string, string[]>;
    /** Paths touched by >=2 units (post-ignore). */
    collisions: CollisionEntry[];
    /** True iff `collisions.length > 0`. */
    hasCollision: boolean;
}
/**
 * Capture the wave-start SHA from `git rev-parse HEAD` in `cwd`. Call this
 * immediately before dispatching workers so the diff window lines up.
 */
export declare function captureWaveStartSha(exec: ExecFn, cwd: string): Promise<string>;
/**
 * Diff a worker's worktree against the wave-start SHA.
 * Returns the list of paths the worker actually modified.
 */
export declare function diffWorkerAgainstWaveStart(exec: ExecFn, worktreeCwd: string, waveStartSha: string): Promise<string[]>;
/**
 * Load collision-ignore globs. Returns {@link DEFAULT_COLLISION_IGNORE} when
 * the file is absent. Blank lines and `#`-comments are stripped.
 */
export declare function loadCollisionIgnore(repoRoot: string): string[];
/**
 * Seed `.pi-flywheel/collision-ignore` with the default ignore set, if the
 * file does not already exist. Creates the parent directory as needed. This
 * is idempotent — existing user-edited files are never overwritten.
 */
export declare function seedCollisionIgnore(repoRoot: string): {
    created: boolean;
    path: string;
};
/**
 * Minimal glob matcher. Supports `*`, `**`, and `?`. Paths are normalised to
 * forward-slash separators before matching. Avoids a minimatch/micromatch
 * dependency for the single use-case we need here.
 */
export declare function matchesGlob(pattern: string, path: string): boolean;
/** Return true iff `path` matches any pattern in `patterns`. */
export declare function isIgnoredCollisionPath(path: string, patterns: readonly string[]): boolean;
/**
 * Aggregate per-worker touched files into a collision report. Files matching
 * the ignore-globs are dropped from both the per-unit sets and the collision
 * scan. A path is a collision iff two or more units touched it after the
 * filter.
 */
export declare function aggregateCollisions(waveStartSha: string, perWorker: Array<{
    unitId: string;
    touched: string[];
}>, ignorePatterns: readonly string[]): CollisionReport;
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
export declare function detectWaveCollisions(exec: ExecFn, repoRoot: string, waveStartSha: string, workers: readonly WaveWorkerResult[]): Promise<CollisionReport>;
/**
 * Compute the colliding unit IDs (stable, sorted) from a report. Convenience
 * helper for orchestrators that only care which units need a serial re-run.
 */
export declare function collidingUnitIds(report: CollisionReport): string[];
/** Canonical hint wording for the `wave_collision_detected` error. */
export declare const WAVE_COLLISION_HINT = "Colliding beads touched shared files; re-running serially against the already-committed branch";
/**
 * Strategy executor for the serial re-run. Given a report, call `runOne` for
 * each colliding unit in order. The caller's `runOne` is responsible for
 * checking out the already-committed branch and replaying the unit's work.
 *
 * Returns a map of unitId → runOne's return value for observability.
 */
export declare function forceSerialRerun<T>(report: CollisionReport, runOne: (unitId: string) => Promise<T>): Promise<Record<string, T>>;
//# sourceMappingURL=coordination.d.ts.map