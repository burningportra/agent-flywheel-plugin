/**
 * fs-safety: ownership-guarded destructive filesystem operations.
 *
 * Motivation — CE phase4 blunder #3 (`forceSymlink`): unconditional
 * `fs.unlink` with no ownership check silently destroyed user-owned
 * regular files under `~/.agents/skills/`. This module centralises
 * every destructive call in the flywheel so that:
 *
 *   1. Each call has a positive ownership signal. A target path is
 *      accepted only if it resolves inside a known flywheel-managed
 *      directory (`.pi-flywheel/`, `mcp-server/dist/`, or the OS
 *      tmpdir under a flywheel-prefixed subdir). User-owned paths
 *      get an explicit refusal, not best-effort cleanup.
 *   2. Before overwriting any path that already holds content, we
 *      move the existing bytes to `.pi-flywheel/_backup/<ts>/` so a
 *      hand-edit is never silently discarded.
 *
 * These helpers never throw on guard failure — they return a typed
 * result so callers can log/warn and degrade gracefully. They throw
 * only when the underlying fs call itself fails unexpectedly.
 */
/**
 * Directory names/segments the flywheel considers its own when invoked
 * inside ANY repo. A destructive op is only allowed if the resolved target
 * sits inside one of these roots.
 *
 * `mcp-server/dist` is intentionally NOT in this list — it is owned by the
 * plugin repo only, and a consumer project can legitimately ship its own
 * `mcp-server/dist`. See `getFlywheelManagedDirs(cwd)` for the cwd-aware
 * resolver that adds `mcp-server/dist` only when cwd is the plugin repo.
 */
export declare const FLYWHEEL_MANAGED_DIRS: readonly [".pi-flywheel", ".pi-flywheel-feedback"];
/**
 * Heuristic: is `cwd` the agent-flywheel-plugin repo itself?
 *
 * We accept either signal:
 *   - `process.env.CLAUDE_PLUGIN_ROOT` is set and matches `cwd`
 *     (plugin runtime sets this when launching the MCP server).
 *   - `<cwd>/mcp-server/package.json` declares `"name": "agent-flywheel-mcp"`
 *     (the plugin checkout in dev).
 *
 * Pure heuristic — never throws. Returns false on any I/O error.
 */
export declare function isPluginRepoRoot(cwd: string): boolean;
/**
 * Cwd-aware managed-directory list. Adds `mcp-server/dist` only when cwd
 * is the plugin repo itself — a consumer project's own dist/ stays
 * user-owned.
 */
export declare function getFlywheelManagedDirs(cwd: string): readonly string[];
/**
 * Tmpdir prefix the flywheel uses for scratch work. `bead-review.ts` and
 * other short-lived helpers should put their work under this prefix so a
 * `guardedUnlink`/`guardedRemoveDir` on tmpdir content is still covered
 * by an ownership signal, not a bare "it's under os.tmpdir()" assumption.
 */
export declare const FLYWHEEL_TMP_PREFIX = "pi-flywheel-";
/** Subdir under `.pi-flywheel/` used by `backupThenReplace`. */
export declare const BACKUP_SUBDIR = "_backup";
export type GuardFailureReason = "target_outside_allowlist" | "target_is_symlink_off_root" | "path_resolve_failed";
export interface GuardResult {
    ok: boolean;
    /** Absolute, resolved target path (filled on success and most failures). */
    resolvedPath?: string;
    /** Why the guard refused (only on !ok). */
    reason?: GuardFailureReason;
    /** Human-readable explanation, for logs. */
    detail?: string;
}
/**
 * Return true iff `absPath` resolves under a flywheel-managed directory
 * rooted at `cwd`, or under the flywheel tmpdir prefix.
 *
 * Pure function: no fs access, just path arithmetic. Callers that want
 * symlink-escape protection should pre-resolve with `fs.realpathSync`.
 */
export declare function isFlywheelManagedPath(absPath: string, cwd: string): boolean;
/**
 * Delete a file only if the target resolves inside a flywheel-managed
 * directory. If the target does not exist, returns ok (idempotent).
 *
 * Does NOT throw on guard failure — returns `{ ok: false, reason }`.
 * Will surface unexpected fs errors (permission denied, EBUSY) via throw.
 */
export declare function guardedUnlink(absPath: string, cwd: string): GuardResult;
/**
 * Before overwriting a path that already has content, copy its current
 * bytes to `<cwd>/.pi-flywheel/_backup/<ISO-with-nanos>/<basename>`.
 *
 * Returns the backup path on success, or an empty string if the target
 * didn't exist (no backup needed). Throws only on unexpected fs errors.
 *
 * Timestamp format: ISO date + nanosecond-precision suffix + PID, so
 * two rapid-fire calls in the same millisecond cannot collide (the CE
 * phase4 blunder #6 lesson — `toISOString()` alone is second-precision
 * and WILL race under test harnesses / CI scripts).
 */
export declare function backupThenReplace(absPath: string, cwd: string): string;
/**
 * Rename `src` to `dest`. Both paths must be inside a flywheel-managed
 * directory. If `dest` already exists and is not being overwritten
 * intentionally, the caller must backup first — `guardedRename` only
 * does the minimum: it verifies both sides of the rename.
 */
export declare function guardedRename(srcPath: string, destPath: string, cwd: string): GuardResult;
/**
 * Recursively remove a directory only if its resolved path is inside
 * the flywheel allowlist (or the flywheel tmpdir prefix). Used by
 * short-lived scratch dirs (`bead-review.ts`). Refuses to touch any
 * path outside the allowlist.
 *
 * Implemented as a guarded wrapper around `fs.rmSync({ recursive: true })`.
 * Returns an GuardResult rather than throwing on guard failure.
 */
export declare function guardedRemoveDir(absPath: string, cwd: string): GuardResult;
//# sourceMappingURL=fs-safety.d.ts.map