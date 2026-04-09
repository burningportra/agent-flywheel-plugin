/**
 * Checkpoint persistence for crash recovery.
 *
 * Writes orchestrator state to `<cwd>/.pi-orchestrator/checkpoint.json`
 * using atomic write-rename semantics. All I/O is non-throwing —
 * failures degrade gracefully to current session-log-only behavior.
 */

import { createHash } from "crypto";
import { execSync } from "child_process";
import { createLogger } from "./logger.js";
import { VERSION } from "./version.js";

const log = createLogger("checkpoint");
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import type { CheckpointEnvelope, OrchestratorState } from "./types.js";

// ─── Constants ────────────────────────────────────────────────

export const CHECKPOINT_DIR = ".pi-orchestrator";
export const CHECKPOINT_FILE = "checkpoint.json";
export const CHECKPOINT_TMP = "checkpoint.json.tmp";
export const CHECKPOINT_CORRUPT = "checkpoint.json.corrupt";

/** Staleness threshold in milliseconds (24 hours). */
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// ─── Helpers ──────────────────────────────────────────────────

function checkpointDir(cwd: string): string {
  return join(cwd, CHECKPOINT_DIR);
}

function checkpointPath(cwd: string): string {
  return join(cwd, CHECKPOINT_DIR, CHECKPOINT_FILE);
}

function checkpointTmpPath(cwd: string): string {
  return join(cwd, CHECKPOINT_DIR, CHECKPOINT_TMP);
}

function checkpointCorruptPath(cwd: string): string {
  return join(cwd, CHECKPOINT_DIR, CHECKPOINT_CORRUPT);
}

/** Compute SHA-256 hash of JSON.stringify(state). */
export function computeStateHash(state: OrchestratorState): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

/** Try to get the current git HEAD hash. Returns undefined on failure. */
function getGitHead(cwd: string): string | undefined {
  try {
    return execSync("git rev-parse HEAD", { cwd, stdio: "pipe" })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

// ─── Validation ───────────────────────────────────────────────

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Validate a parsed checkpoint envelope against all integrity rules.
 * Pure function — no I/O.
 */
export function validateCheckpoint(envelope: unknown): ValidationResult {
  if (typeof envelope !== "object" || envelope === null) {
    return { valid: false, reason: "checkpoint is not an object" };
  }

  const e = envelope as Record<string, unknown>;

  if (e.schemaVersion !== 1) {
    return {
      valid: false,
      reason: `unknown schemaVersion: ${String(e.schemaVersion)}`,
    };
  }

  if (typeof e.writtenAt !== "string") {
    return { valid: false, reason: "missing or invalid writtenAt" };
  }

  if (isNaN(Date.parse(e.writtenAt))) {
    return { valid: false, reason: "writtenAt is not a valid ISO date" };
  }

  if (typeof e.orchestratorVersion !== "string") {
    return { valid: false, reason: "missing orchestratorVersion" };
  }

  if (typeof e.state !== "object" || e.state === null) {
    return { valid: false, reason: "missing or invalid state" };
  }

  if (typeof e.stateHash !== "string") {
    return { valid: false, reason: "missing stateHash" };
  }

  // Verify hash integrity
  const computed = computeStateHash(e.state as OrchestratorState);
  if (computed !== e.stateHash) {
    return {
      valid: false,
      reason: "stateHash mismatch — state may be tampered or corrupted",
    };
  }

  // Verify state has a valid phase
  const state = e.state as Record<string, unknown>;
  if (typeof state.phase !== "string") {
    return { valid: false, reason: "state.phase is not a string" };
  }

  return { valid: true };
}

// ─── Write ────────────────────────────────────────────────────

// Per-cwd write mutex — serializes concurrent writes via Promise chaining.
const writeLocks = new Map<string, Promise<boolean>>();

/**
 * Atomically write a checkpoint to disk.
 * Uses write-to-tmp + rename for crash safety.
 * Returns true if write succeeded, false otherwise.
 * Never throws.
 */
function writeCheckpointInner(
  cwd: string,
  state: OrchestratorState
): boolean {
  try {
    const dir = checkpointDir(cwd);
    mkdirSync(dir, { recursive: true });

    const envelope: CheckpointEnvelope = {
      schemaVersion: 1,
      writtenAt: new Date().toISOString(),
      orchestratorVersion: VERSION,
      gitHead: getGitHead(cwd),
      state,
      stateHash: computeStateHash(state),
    };

    const json = JSON.stringify(envelope, null, 2);
    const tmpFile = checkpointTmpPath(cwd);
    const mainFile = checkpointPath(cwd);

    // Atomic write: tmp → rename
    writeFileSync(tmpFile, json, "utf8");
    renameSync(tmpFile, mainFile);

    return true;
  } catch (err) {
    log.warn("checkpoint write failed", { err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Serialize checkpoint writes per cwd via Promise chaining.
 * Concurrent callers for the same cwd are queued; a failed write
 * resolves to false without blocking subsequent writes.
 */
export async function writeCheckpoint(
  cwd: string,
  state: OrchestratorState
): Promise<boolean> {
  const prev = writeLocks.get(cwd) ?? Promise.resolve(true);
  const next = prev.then(() => writeCheckpointInner(cwd, state)).catch(() => false);
  writeLocks.set(cwd, next);
  return next;
}

// ─── Read ─────────────────────────────────────────────────────

export interface ReadCheckpointResult {
  envelope: CheckpointEnvelope;
  warnings: string[];
}

/**
 * Read and validate a checkpoint from disk.
 * Returns the validated envelope with warnings, or null if:
 * - File doesn't exist
 * - File is corrupt (moved to .corrupt)
 * - Schema version is unknown
 * - Hash mismatch
 * Never throws.
 */
export function readCheckpoint(cwd: string): ReadCheckpointResult | null {
  const mainFile = checkpointPath(cwd);

  if (!existsSync(mainFile)) {
    // Clean up orphaned tmp files while we're here
    cleanupOrphanedTmp(cwd);
    return null;
  }

  try {
    const raw = readFileSync(mainFile, "utf8");
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt JSON — move to .corrupt
      moveToCorrupt(cwd, mainFile);
      return null;
    }

    const validation = validateCheckpoint(parsed);
    if (!validation.valid) {
      log.warn("checkpoint validation failed", { reason: validation.reason });
      moveToCorrupt(cwd, mainFile);
      return null;
    }

    const envelope = parsed as CheckpointEnvelope;
    const warnings: string[] = [];

    // Check staleness
    const age = Date.now() - Date.parse(envelope.writtenAt);
    if (age > STALE_THRESHOLD_MS) {
      const hours = Math.floor(age / (60 * 60 * 1000));
      warnings.push(
        `checkpoint is stale (${hours}h old) — session state may be outdated`
      );
    }

    return { envelope, warnings };
  } catch (err) {
    log.warn("checkpoint read failed", { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ─── Clear ────────────────────────────────────────────────────

/**
 * Delete the checkpoint file. Idempotent — no error if file doesn't exist.
 * Never throws.
 */
export function clearCheckpoint(cwd: string): void {
  try {
    const mainFile = checkpointPath(cwd);
    if (existsSync(mainFile)) {
      unlinkSync(mainFile);
    }
    // Also clean up any orphaned tmp
    cleanupOrphanedTmp(cwd);
  } catch (err) {
    log.warn("checkpoint clear failed", { err: err instanceof Error ? err.message : String(err) });
  }
}

// ─── Internal helpers ─────────────────────────────────────────

function moveToCorrupt(cwd: string, filePath: string): void {
  try {
    const corruptPath = checkpointCorruptPath(cwd);
    renameSync(filePath, corruptPath);
    log.warn("corrupt checkpoint moved", { dest: CHECKPOINT_CORRUPT });
  } catch {
    // If we can't even rename, just try to delete
    try {
      unlinkSync(filePath);
    } catch {
      // Give up silently
    }
  }
}

/** Remove orphaned .tmp files left from crashes during write. */
export function cleanupOrphanedTmp(cwd: string): void {
  try {
    const tmpFile = checkpointTmpPath(cwd);
    if (existsSync(tmpFile)) {
      unlinkSync(tmpFile);
    }
  } catch {
    // Silently ignore
  }
}
