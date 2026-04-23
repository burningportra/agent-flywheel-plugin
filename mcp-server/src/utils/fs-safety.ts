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

import {
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

// ─── Allowlist ────────────────────────────────────────────────

/**
 * Directory names/segments the flywheel considers its own. A destructive
 * op is only allowed if the resolved target sits inside one of these roots.
 *
 * We deliberately accept an explicit allowlist rather than a blocklist —
 * defence-in-depth against future refactors that introduce new destructive
 * sites on user-owned paths.
 */
export const FLYWHEEL_MANAGED_DIRS = [
  ".pi-flywheel",
  ".pi-flywheel-feedback",
  // Build output, never authored by hand.
  join("mcp-server", "dist"),
] as const;

/**
 * Tmpdir prefix the flywheel uses for scratch work. `bead-review.ts` and
 * other short-lived helpers should put their work under this prefix so a
 * `guardedUnlink`/`guardedRemoveDir` on tmpdir content is still covered
 * by an ownership signal, not a bare "it's under os.tmpdir()" assumption.
 */
export const FLYWHEEL_TMP_PREFIX = "pi-flywheel-";

/** Subdir under `.pi-flywheel/` used by `backupThenReplace`. */
export const BACKUP_SUBDIR = "_backup";

// ─── Types ────────────────────────────────────────────────────

export type GuardFailureReason =
  | "target_outside_allowlist"
  | "target_is_symlink_off_root"
  | "path_resolve_failed";

export interface GuardResult {
  ok: boolean;
  /** Absolute, resolved target path (filled on success and most failures). */
  resolvedPath?: string;
  /** Why the guard refused (only on !ok). */
  reason?: GuardFailureReason;
  /** Human-readable explanation, for logs. */
  detail?: string;
}

// ─── Ownership check ─────────────────────────────────────────

/**
 * Return true iff `absPath` resolves under a flywheel-managed directory
 * rooted at `cwd`, or under the flywheel tmpdir prefix.
 *
 * Pure function: no fs access, just path arithmetic. Callers that want
 * symlink-escape protection should pre-resolve with `fs.realpathSync`.
 */
export function isFlywheelManagedPath(absPath: string, cwd: string): boolean {
  const resolved = resolve(absPath);
  const cwdAbs = resolve(cwd);

  for (const dir of FLYWHEEL_MANAGED_DIRS) {
    const root = resolve(cwdAbs, dir);
    if (resolved === root || resolved.startsWith(root + sep)) {
      return true;
    }
  }

  // Tmpdir scratch: <tmpdir>/pi-flywheel-<whatever>/...
  const tmpRoot = resolve(tmpdir());
  if (resolved.startsWith(tmpRoot + sep)) {
    const afterTmp = resolved.slice(tmpRoot.length + 1);
    const firstSeg = afterTmp.split(sep)[0] ?? "";
    if (firstSeg.startsWith(FLYWHEEL_TMP_PREFIX)) return true;
  }

  return false;
}

/**
 * Build a guard failure for a path that refused the ownership check.
 */
function denied(absPath: string, cwd: string): GuardResult {
  return {
    ok: false,
    resolvedPath: resolve(absPath),
    reason: "target_outside_allowlist",
    detail:
      `Refusing destructive op on '${absPath}': not inside any flywheel-managed ` +
      `directory (${FLYWHEEL_MANAGED_DIRS.join(", ")}) under cwd '${cwd}' ` +
      `and not under tmpdir/${FLYWHEEL_TMP_PREFIX}*.`,
  };
}

// ─── Public: guardedUnlink ───────────────────────────────────

/**
 * Delete a file only if the target resolves inside a flywheel-managed
 * directory. If the target does not exist, returns ok (idempotent).
 *
 * Does NOT throw on guard failure — returns `{ ok: false, reason }`.
 * Will surface unexpected fs errors (permission denied, EBUSY) via throw.
 */
export function guardedUnlink(absPath: string, cwd: string): GuardResult {
  if (!isFlywheelManagedPath(absPath, cwd)) {
    return denied(absPath, cwd);
  }

  const resolved = resolve(absPath);
  if (!existsSync(resolved)) {
    return { ok: true, resolvedPath: resolved, detail: "target does not exist" };
  }
  unlinkSync(resolved);
  return { ok: true, resolvedPath: resolved };
}

// ─── Public: backupThenReplace ───────────────────────────────

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
export function backupThenReplace(absPath: string, cwd: string): string {
  const resolved = resolve(absPath);
  if (!existsSync(resolved)) return "";

  const ts = buildBackupTimestamp();
  const backupDir = resolve(cwd, ".pi-flywheel", BACKUP_SUBDIR, ts);
  mkdirSync(backupDir, { recursive: true });

  // Use the basename so a single backup dir can hold multiple files.
  const base = resolved.split(sep).pop() ?? "file";
  const backupPath = join(backupDir, base);

  // Prefer rename (atomic + instant) when both paths are on the same
  // filesystem; fall back to copy+unlink otherwise.
  try {
    renameSync(resolved, backupPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EXDEV") {
      copyFileSync(resolved, backupPath);
      unlinkSync(resolved);
    } else {
      throw err;
    }
  }
  return backupPath;
}

/**
 * Build a filesystem-safe, collision-resistant timestamp for backup
 * directories. Combines ISO date + high-res process.hrtime nanoseconds
 * + PID so concurrent writers in the same millisecond cannot collide.
 */
function buildBackupTimestamp(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const hr = process.hrtime.bigint().toString();
  return `${iso}-${hr}-${process.pid}`;
}

// ─── Public: guardedRename ───────────────────────────────────

/**
 * Rename `src` to `dest`. Both paths must be inside a flywheel-managed
 * directory. If `dest` already exists and is not being overwritten
 * intentionally, the caller must backup first — `guardedRename` only
 * does the minimum: it verifies both sides of the rename.
 */
export function guardedRename(
  srcPath: string,
  destPath: string,
  cwd: string,
): GuardResult {
  if (!isFlywheelManagedPath(srcPath, cwd)) return denied(srcPath, cwd);
  if (!isFlywheelManagedPath(destPath, cwd)) return denied(destPath, cwd);

  renameSync(resolve(srcPath), resolve(destPath));
  return { ok: true, resolvedPath: resolve(destPath) };
}

// ─── Public: guardedRemoveDir ────────────────────────────────

/**
 * Recursively remove a directory only if its resolved path is inside
 * the flywheel allowlist (or the flywheel tmpdir prefix). Used by
 * short-lived scratch dirs (`bead-review.ts`). Refuses to touch any
 * path outside the allowlist.
 *
 * Implemented as a guarded wrapper around `fs.rmSync({ recursive: true })`.
 * Returns an GuardResult rather than throwing on guard failure.
 */
export function guardedRemoveDir(absPath: string, cwd: string): GuardResult {
  if (!isFlywheelManagedPath(absPath, cwd)) return denied(absPath, cwd);

  const resolved = resolve(absPath);
  if (!existsSync(resolved)) {
    return { ok: true, resolvedPath: resolved, detail: "target does not exist" };
  }

  // Extra belt: reject if target is not a directory. rmSync-recursive on
  // a symlink pointing outside the allowlist would be catastrophic.
  let st;
  try {
    st = statSync(resolved);
  } catch (err) {
    return {
      ok: false,
      resolvedPath: resolved,
      reason: "path_resolve_failed",
      detail: (err as Error).message,
    };
  }
  if (!st.isDirectory()) {
    return {
      ok: false,
      resolvedPath: resolved,
      reason: "target_is_symlink_off_root",
      detail: "guardedRemoveDir target is not a directory",
    };
  }

  // Lazy require to avoid pulling in rmSync at module-load if unused.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { rmSync } = require("node:fs") as typeof import("node:fs");
  rmSync(resolved, { recursive: true, force: true });
  return { ok: true, resolvedPath: resolved };
}
