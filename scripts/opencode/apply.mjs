#!/usr/bin/env node

/**
 * Transactional apply substrate for the OpenCode sync engine (bead claude-25tj).
 *
 * This module owns the durable state under `<configDir>/.flywheel-sync/`:
 *   - `ledger.json`  — schema-versioned installed hashes per owned path.
 *   - `lock/`        — advisory single-writer lock (owner PID + start time).
 *   - `journal.json` — planned ops for the in-flight transaction.
 *   - `backups/`     — mode-0700 per-file backups of overwritten content.
 *   - `staging-<pid>/` — rendered tree materialized on the destination FS so
 *                        renames into place are same-filesystem and atomic.
 *
 * It is intentionally stdlib-only and free of any import from `sync.mjs`, so
 * there is no import cycle: `sync.mjs` classifies (source/ledger/live hashes)
 * and hands this module an ordered plan; this module runs the transaction and
 * recovers abandoned journals. The mcp merge write is delegated back via a
 * per-op `writeMcp` callback.
 */

import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import * as path from "node:path";

export const STATE_DIR_NAME = ".flywheel-sync";
export const LEDGER_SCHEMA_VERSION = 1;
export const JOURNAL_SCHEMA_VERSION = 1;

/** Error carrying an explicit process exit code (2 = usage/lock, 1 = apply). */
export class ApplyError extends Error {
  constructor(message, exitCode = 1, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ApplyError";
    this.exitCode = exitCode;
    if (options.crash) this.crash = true;
    if (options.injected) this.injected = true;
  }
}

// ─── small fs helpers ───────────────────────────────────────────────────────

async function exists(target) {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw);
}

/** Deterministic JSON with sorted keys, for order-independent comparison. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function writeJsonAtomic(file, value, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true });
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const tmp = `${file}.tmp-${suffix}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(tmp, file);
}

/** Copy a file or directory tree, preserving permissions. */
async function copyPath(source, dest) {
  const stat = await lstat(source);
  if (stat.isDirectory()) {
    await cp(source, dest, { recursive: true, force: true, preserveTimestamps: true });
    return;
  }
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(source, dest);
  await chmod(dest, stat.mode & 0o777);
}

// ─── hashing (source / installed / live classification) ─────────────────────

async function hashFileContent(absPath) {
  return createHash("sha256").update(await readFile(absPath)).digest("hex");
}

async function hashTree(root) {
  const rows = [];
  const walk = async (current, relative) => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(current, entry.name);
      const stat = await lstat(child);
      if (entry.isDirectory()) {
        rows.push([childRelative, "d", stat.mode & 0o777]);
        await walk(child, childRelative);
      } else if (entry.isFile()) {
        rows.push([childRelative, "f", stat.mode & 0o777, await hashFileContent(child)]);
      } else {
        rows.push([childRelative, "o", stat.mode & 0o777]);
      }
    }
  };
  await walk(root, "");
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/** SHA-256 of a file's bytes or a canonical digest of a directory tree. */
export async function hashPath(absPath) {
  let stat;
  try {
    stat = await lstat(absPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isDirectory()) return hashTree(absPath);
  if (stat.isFile()) return hashFileContent(absPath);
  return `special:${stat.mode & 0o777}`;
}

// ─── process liveness ───────────────────────────────────────────────────────

/** True when a PID names a live process (EPERM counts as alive, ESRCH dead). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// ─── state-dir path helpers ─────────────────────────────────────────────────

export function stateDirFor(configDir) {
  return path.join(configDir, STATE_DIR_NAME);
}
function ledgerPath(stateDir) {
  return path.join(stateDir, "ledger.json");
}
function journalPath(stateDir) {
  return path.join(stateDir, "journal.json");
}
function lockDirFor(stateDir) {
  return path.join(stateDir, "lock");
}
function backupsDir(stateDir) {
  return path.join(stateDir, "backups");
}
function stagingDirFor(stateDir, ownerPid) {
  return path.join(stateDir, `staging-${ownerPid}`);
}

// ─── lock ───────────────────────────────────────────────────────────────────

/**
 * Acquire the single-writer lock. A live foreign owner rejects with exit 2; a
 * dead owner is reclaimed with a `[WARN]` line. Returns a handle for release.
 */
export async function acquireLock(stateDir, { output, ownerPid, startedAt }) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockDir = lockDirFor(stateDir);
  const metaPath = path.join(lockDir, "meta.json");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // The lock dir is only a container; the atomic claim is the O_EXCL create of
    // meta.json below. Creating the dir is therefore idempotent and never the
    // gate — a crash that left an empty lock dir behind is reclaimed by simply
    // winning the meta write, so this never needs to distinguish "just made" from
    // "already there".
    await mkdir(lockDir, { recursive: true });
    try {
      // O_EXCL (flag "wx"): exactly one racer creates meta.json, and it stamps
      // the owner pid in the SAME syscall that creates the file. There is no
      // window in which the lock is held but its owner is unknown, so a loser can
      // always PID-check the holder — two concurrent acquirers can never both
      // read a missing meta, both reclaim, and both win (the double-acquire bug).
      await writeFile(metaPath, `${JSON.stringify({ pid: ownerPid, startedAt }, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return { lockDir, released: false };
    } catch (error) {
      // A racer reclaimed the lock dir out from under us between mkdir and the
      // create: just retry (re-make the dir and re-race the claim).
      if (error?.code === "ENOENT") continue;
      if (error?.code !== "EEXIST") throw error;
      const meta = await readJson(metaPath).catch(() => null);
      const holder = meta?.pid;
      if (Number.isInteger(holder) && pidAlive(holder) && holder !== ownerPid) {
        throw new ApplyError(
          `another OpenCode sync is already running (pid ${holder}); retry after it finishes`,
          2,
        );
      }
      // Held by a dead owner (or an unknown/corrupt meta, or a stale self-owned
      // lock): reclaim the whole lock dir and retry the claim.
      output.write(
        `[WARN] reclaiming stale sync lock (owner pid ${holder ?? "unknown"} is not alive)\n`,
      );
      await rm(lockDir, { recursive: true, force: true });
      continue;
    }
  }
  throw new ApplyError("could not acquire the OpenCode sync lock after reclaim attempts", 2);
}

export async function releaseLock(handle) {
  if (!handle || handle.released) return;
  handle.released = true;
  await rm(handle.lockDir, { recursive: true, force: true }).catch(() => {});
}

// ─── ledger ─────────────────────────────────────────────────────────────────

export async function readLedger(stateDir) {
  const raw = await readFile(ledgerPath(stateDir), "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return { schemaVersion: LEDGER_SCHEMA_VERSION, entries: {} };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt ledger is treated as absent rather than fatal: the next apply
    // rebuilds a full snapshot from live hashes.
    return { schemaVersion: LEDGER_SCHEMA_VERSION, entries: {} };
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object") {
    return { schemaVersion: LEDGER_SCHEMA_VERSION, entries: {} };
  }
  return { schemaVersion: parsed.schemaVersion ?? LEDGER_SCHEMA_VERSION, entries: parsed.entries };
}

// ─── journal ────────────────────────────────────────────────────────────────

export async function readJournal(stateDir) {
  const raw = await readFile(journalPath(stateDir), "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function removeJournal(stateDir) {
  await rm(journalPath(stateDir), { force: true }).catch(() => {});
}

// ─── restore (shared by rollback and recovery) ──────────────────────────────

/**
 * Restore every journaled op to its pre-apply state. Idempotent: applying it to
 * a fully-applied, partially-applied, or untouched tree all converge on the
 * pre-transaction bytes. `tag` is the log label (`RECOVER` or `ROLLBACK`).
 */
async function restoreOps(ops, { output, tag }) {
  let restored = 0;
  for (const op of [...ops].reverse()) {
    if (op.isNew) {
      if (await exists(op.target)) {
        await rm(op.target, { recursive: true, force: true });
        output.write(`[${tag}] removed ${op.relTarget}\n`);
        restored += 1;
      }
      continue;
    }
    if (op.backup && (await exists(op.backup))) {
      await rm(op.target, { recursive: true, force: true }).catch(() => {});
      await mkdir(path.dirname(op.target), { recursive: true });
      await copyPath(op.backup, op.target);
      output.write(`[${tag}] restored ${op.relTarget}\n`);
      restored += 1;
    }
  }
  return restored;
}

/**
 * Startup recovery. An abandoned journal whose owner PID is dead is validated
 * and its ops restored before any new render/apply. A journal owned by a live
 * PID is left untouched (defensive: never clobber an active apply).
 */
export async function recoverState(stateDir, { output }) {
  const journal = await readJournal(stateDir);
  if (!journal || !Array.isArray(journal.ops)) return { recovered: 0 };
  const owner = journal.ownerPid;
  if (pidAlive(owner)) {
    output.write(`[WARN] journal owned by live pid ${owner}; skipping recovery\n`);
    return { recovered: 0, skipped: true };
  }
  output.write(
    `[RECOVER] abandoned journal from pid ${owner ?? "unknown"} (schema ${journal.schemaVersion}); ` +
      `restoring ${journal.ops.length} op(s)\n`,
  );
  const restored = await restoreOps(journal.ops, { output, tag: "RECOVER" });
  if (typeof journal.stagingDir === "string") {
    await rm(journal.stagingDir, { recursive: true, force: true }).catch(() => {});
  }
  await removeJournal(stateDir);
  output.write(`[RECOVER] recovery complete (${restored} path(s) restored)\n`);
  return { recovered: restored };
}

// ─── transaction ────────────────────────────────────────────────────────────

function maybeFail(step, env) {
  if (env.FW_SYNC_FAIL_AFTER === step) {
    throw new ApplyError(`injected failure after ${step}`, 1, { injected: true });
  }
}

function maybeCrash(step, env) {
  if (env.FW_SYNC_CRASH_AFTER === step) {
    throw new ApplyError(`injected crash after ${step}`, 1, { crash: true });
  }
}

/**
 * Run the apply transaction over `ops` (drifting owned paths only).
 *
 * Sequence: stage on the destination FS → write journal → per-file backup →
 * apply (rename for file/tree, `writeMcp` for mcp) → write ledger LAST → clear
 * journal. A caught failure rolls back to the pre-journal tree and restores the
 * prior ledger, then rethrows (exit 1). An injected crash leaves the journal
 * and staging in place so the next invocation recovers.
 *
 * `desiredLedger` is a full snapshot of every owned path's post-apply hash, so
 * a clean second run is a no-op and local edits are detectable thereafter.
 * The caller owns the lock (acquired before render) and its release.
 */
export async function runTransaction({
  stateDir,
  ops,
  desiredLedger,
  ownerPid,
  startedAt,
  output,
  env,
}) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  // Nothing drifted: refresh the installed-hash snapshot only if it changed, and
  // touch nothing else. This keeps a clean re-run a true no-op (idempotence).
  if (ops.length === 0) {
    const current = await readLedger(stateDir);
    if (stableStringify(current.entries) !== stableStringify(desiredLedger)) {
      await writeJsonAtomic(ledgerPath(stateDir), {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        updatedAt: startedAt,
        entries: desiredLedger,
      });
    }
    return { applied: 0, local: 0 };
  }

  const stagingDir = stagingDirFor(stateDir, ownerPid);
  const backupsRoot = backupsDir(stateDir);

  // Stage every file/tree op's rendered content onto the destination FS.
  await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  for (const op of ops) {
    if (op.kind === "mcp") continue;
    op.stagedPath = path.join(stagingDir, op.relTarget);
    await mkdir(path.dirname(op.stagedPath), { recursive: true });
    await copyPath(op.stageSource, op.stagedPath);
  }

  // Pre-scan existence and assign deterministic backup paths BEFORE journaling,
  // so a crash at any point after the journal is fully recoverable.
  await mkdir(backupsRoot, { recursive: true, mode: 0o700 });
  const txnBackupDir = path.join(backupsRoot, `txn-${ownerPid}-${startedAt.replace(/[:.]/g, "-")}`);
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index];
    op.isNew = !(await exists(op.target));
    op.backup = op.isNew ? null : path.join(txnBackupDir, `op-${index}`, path.basename(op.target));
  }

  const journal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    ownerPid,
    startedAt,
    stagingDir,
    ops: ops.map((op) => ({
      kind: op.kind,
      target: op.target,
      relTarget: op.relTarget,
      backup: op.backup,
      isNew: op.isNew,
    })),
  };

  let ledgerWritten = false;
  const previousLedgerRaw = await readFile(ledgerPath(stateDir), "utf8").catch(() => null);

  try {
    await writeJsonAtomic(journalPath(stateDir), journal);
    maybeFail("journal", env);
    maybeCrash("journal", env);

    for (const op of ops) {
      if (op.isNew) continue;
      await mkdir(path.dirname(op.backup), { recursive: true, mode: 0o700 });
      await copyPath(op.target, op.backup);
    }
    maybeFail("backup", env);
    maybeCrash("backup", env);

    for (const op of ops) {
      output.write(`[${op.label}] ${op.displayTarget}\n`);
      if (op.kind === "mcp") {
        await op.writeMcp();
      } else {
        await applyStagedPath(op);
      }
    }
    maybeFail("rename", env);
    maybeCrash("rename", env);

    await writeJsonAtomic(ledgerPath(stateDir), {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      updatedAt: startedAt,
      entries: desiredLedger,
    });
    ledgerWritten = true;
    maybeFail("ledger", env);
    maybeCrash("ledger", env);

    await removeJournal(stateDir);
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    return {
      applied: ops.length,
      local: ops.filter((op) => op.label === "LOCAL").length,
    };
  } catch (error) {
    if (error?.crash) {
      // Simulated hard-kill: leave journal + staging for startup recovery.
      throw error;
    }
    output.write(`[ROLLBACK] apply failed (${error.message}); restoring prior tree\n`);
    await restoreOps(journal.ops, { output, tag: "ROLLBACK" }).catch(() => {});
    if (ledgerWritten) {
      if (previousLedgerRaw === null) {
        await rm(ledgerPath(stateDir), { force: true }).catch(() => {});
      } else {
        await writeFile(ledgerPath(stateDir), previousLedgerRaw).catch(() => {});
      }
    }
    await removeJournal(stateDir);
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (error instanceof ApplyError) throw error;
    throw new ApplyError(`apply failed and the prior tree was restored: ${error.message}`, 1, {
      cause: error,
    });
  }
}

async function applyStagedPath(op) {
  await mkdir(path.dirname(op.target), { recursive: true });
  const stagedStat = await lstat(op.stagedPath);
  if (stagedStat.isDirectory()) {
    // A directory cannot be renamed onto an existing entry; clear it first.
    await rm(op.target, { recursive: true, force: true });
    await rename(op.stagedPath, op.target);
    return;
  }
  // A file rename atomically replaces an existing file, but not a directory or
  // other non-file target — remove those first (already backed up).
  let targetStat = null;
  try {
    targetStat = await lstat(op.target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (targetStat && !targetStat.isFile()) {
    await rm(op.target, { recursive: true, force: true });
  }
  await rename(op.stagedPath, op.target);
}
