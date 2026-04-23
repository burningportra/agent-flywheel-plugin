/**
 * Checkpoint persistence for crash recovery.
 *
 * Writes flywheel state to `<cwd>/.pi-flywheel/checkpoint.json`
 * using atomic write-rename semantics. All I/O is non-throwing —
 * failures degrade gracefully to current session-log-only behavior.
 */
import { createHash } from "crypto";
import { execSync } from "child_process";
import { createLogger } from "./logger.js";
import { VERSION } from "./version.js";
const log = createLogger("checkpoint");
import { existsSync, mkdirSync, readFileSync, writeFileSync, } from "fs";
import { join } from "path";
import { guardedRename, guardedUnlink, isFlywheelManagedPath, } from "./utils/fs-safety.js";
import { normalizeText } from "./utils/text-normalize.js";
// ─── Constants ────────────────────────────────────────────────
export const CHECKPOINT_DIR = ".pi-flywheel";
export const CHECKPOINT_FILE = "checkpoint.json";
export const CHECKPOINT_TMP = "checkpoint.json.tmp";
export const CHECKPOINT_CORRUPT = "checkpoint.json.corrupt";
/** Staleness threshold in milliseconds (24 hours). */
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
// ─── Helpers ──────────────────────────────────────────────────
function checkpointDir(cwd) {
    return join(cwd, CHECKPOINT_DIR);
}
function checkpointPath(cwd) {
    return join(cwd, CHECKPOINT_DIR, CHECKPOINT_FILE);
}
function checkpointTmpPath(cwd) {
    return join(cwd, CHECKPOINT_DIR, CHECKPOINT_TMP);
}
function checkpointCorruptPath(cwd) {
    return join(cwd, CHECKPOINT_DIR, CHECKPOINT_CORRUPT);
}
/** Compute SHA-256 hash of JSON.stringify(state). */
export function computeStateHash(state) {
    return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
/** Try to get the current git HEAD hash. Returns undefined on failure. */
function getGitHead(cwd) {
    try {
        return execSync("git rev-parse HEAD", { cwd, stdio: "pipe" })
            .toString()
            .trim();
    }
    catch (err) {
        log.warn("git HEAD detection failed", { code: "cli_failure", cause: err instanceof Error ? err.message : String(err) });
        return undefined;
    }
}
/**
 * Validate a parsed checkpoint envelope against all integrity rules.
 * Pure function — no I/O.
 */
export function validateCheckpoint(envelope) {
    if (typeof envelope !== "object" || envelope === null) {
        return { valid: false, reason: "checkpoint is not an object" };
    }
    const e = envelope;
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
    // Migration: accept old orchestratorVersion field during transition from v2.x
    const version = e.flywheelVersion ?? e.orchestratorVersion;
    if (typeof version !== "string") {
        return { valid: false, reason: "missing flywheelVersion" };
    }
    if (typeof e.state !== "object" || e.state === null) {
        return { valid: false, reason: "missing or invalid state" };
    }
    if (typeof e.stateHash !== "string") {
        return { valid: false, reason: "missing stateHash" };
    }
    // Verify hash integrity
    const computed = computeStateHash(e.state);
    if (computed !== e.stateHash) {
        return {
            valid: false,
            reason: "stateHash mismatch — state may be tampered or corrupted",
        };
    }
    // Verify state has a valid phase
    const state = e.state;
    if (typeof state.phase !== "string") {
        return { valid: false, reason: "state.phase is not a string" };
    }
    // Collect non-fatal warnings
    const warnings = [];
    if (version !== VERSION) {
        warnings.push(`Checkpoint was written by v${String(version)}, current is v${VERSION}`);
    }
    return warnings.length > 0 ? { valid: true, warnings } : { valid: true };
}
// ─── Write ────────────────────────────────────────────────────
// Per-cwd write mutex — serializes concurrent writes via Promise chaining.
const writeLocks = new Map();
/**
 * Atomically write a checkpoint to disk.
 * Uses write-to-tmp + rename for crash safety.
 * Returns true if write succeeded, false otherwise.
 * Never throws.
 */
function writeCheckpointInner(cwd, state) {
    try {
        const dir = checkpointDir(cwd);
        mkdirSync(dir, { recursive: true });
        const envelope = {
            schemaVersion: 1,
            writtenAt: new Date().toISOString(),
            flywheelVersion: VERSION,
            gitHead: getGitHead(cwd),
            state,
            stateHash: computeStateHash(state),
        };
        const json = JSON.stringify(envelope, null, 2);
        const tmpFile = checkpointTmpPath(cwd);
        const mainFile = checkpointPath(cwd);
        // Atomic write: tmp → rename (ownership-guarded; both paths must be
        // inside the flywheel-managed `.pi-flywheel/` root).
        writeFileSync(tmpFile, json, "utf8");
        const r = guardedRename(tmpFile, mainFile, cwd);
        if (!r.ok) {
            log.warn("checkpoint rename refused by guard", {
                code: "cli_failure",
                cause: r.detail ?? r.reason,
            });
            return false;
        }
        return true;
    }
    catch (err) {
        log.warn("checkpoint write failed", { err: err instanceof Error ? err.message : String(err) });
        return false;
    }
}
/**
 * Serialize checkpoint writes per cwd via Promise chaining.
 * Concurrent callers for the same cwd are queued; a failed write
 * resolves to false without blocking subsequent writes.
 */
export async function writeCheckpoint(cwd, state) {
    const prev = writeLocks.get(cwd) ?? Promise.resolve(true);
    const next = prev.then(() => writeCheckpointInner(cwd, state)).catch(() => false);
    writeLocks.set(cwd, next);
    return next;
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
export function readCheckpoint(cwd) {
    const mainFile = checkpointPath(cwd);
    if (!existsSync(mainFile)) {
        // Clean up orphaned tmp files while we're here
        cleanupOrphanedTmp(cwd);
        return null;
    }
    try {
        const raw = normalizeText(readFileSync(mainFile, "utf8"));
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (err) {
            log.warn("corrupt checkpoint JSON", { code: "parse_failure", cause: err instanceof Error ? err.message : String(err) });
            moveToCorrupt(cwd, mainFile);
            return null;
        }
        const validation = validateCheckpoint(parsed);
        if (!validation.valid) {
            log.warn("checkpoint validation failed", { reason: validation.reason });
            moveToCorrupt(cwd, mainFile);
            return null;
        }
        const envelope = parsed;
        const warnings = validation.warnings ? [...validation.warnings] : [];
        // Check staleness
        const age = Date.now() - Date.parse(envelope.writtenAt);
        if (age > STALE_THRESHOLD_MS) {
            const hours = Math.floor(age / (60 * 60 * 1000));
            warnings.push(`checkpoint is stale (${hours}h old) — session state may be outdated`);
        }
        return { envelope, warnings };
    }
    catch (err) {
        log.warn("checkpoint read failed", { err: err instanceof Error ? err.message : String(err) });
        return null;
    }
}
// ─── Clear ────────────────────────────────────────────────────
/**
 * Delete the checkpoint file. Idempotent — no error if file doesn't exist.
 * Never throws.
 */
export function clearCheckpoint(cwd) {
    try {
        const mainFile = checkpointPath(cwd);
        const r = guardedUnlink(mainFile, cwd);
        if (!r.ok) {
            log.warn("checkpoint clear refused by guard", {
                code: "cli_failure",
                cause: r.detail ?? r.reason,
            });
        }
        // Also clean up any orphaned tmp
        cleanupOrphanedTmp(cwd);
    }
    catch (err) {
        log.warn("checkpoint clear failed", { err: err instanceof Error ? err.message : String(err) });
    }
}
// ─── Internal helpers ─────────────────────────────────────────
function moveToCorrupt(cwd, filePath) {
    // Defence-in-depth: if anything upstream has handed us a filePath that
    // isn't actually in .pi-flywheel/, refuse all destructive action rather
    // than renaming a user-owned file into a .corrupt sibling.
    if (!isFlywheelManagedPath(filePath, cwd)) {
        log.warn("moveToCorrupt refused by guard", {
            code: "cli_failure",
            cause: `filePath '${filePath}' outside flywheel-managed dirs`,
        });
        return;
    }
    try {
        const corruptPath = checkpointCorruptPath(cwd);
        const r = guardedRename(filePath, corruptPath, cwd);
        if (r.ok) {
            log.warn("corrupt checkpoint moved", { dest: CHECKPOINT_CORRUPT });
            return;
        }
        log.warn("checkpoint rename refused, attempting delete", {
            code: "cli_failure",
            cause: r.detail ?? r.reason,
        });
    }
    catch (err) {
        log.warn("checkpoint rename failed, attempting delete", { code: "cli_failure", cause: err instanceof Error ? err.message : String(err) });
    }
    const del = guardedUnlink(filePath, cwd);
    if (!del.ok) {
        log.warn("checkpoint delete also refused", {
            code: "cli_failure",
            cause: del.detail ?? del.reason,
        });
    }
}
/** Remove orphaned .tmp files left from crashes during write. */
export function cleanupOrphanedTmp(cwd) {
    try {
        const tmpFile = checkpointTmpPath(cwd);
        const r = guardedUnlink(tmpFile, cwd);
        if (!r.ok) {
            log.warn("orphaned tmp cleanup refused by guard", {
                code: "cli_failure",
                cause: r.detail ?? r.reason,
            });
        }
    }
    catch (err) {
        log.warn("orphaned tmp cleanup failed", { code: "cli_failure", cause: err instanceof Error ? err.message : String(err) });
    }
}
//# sourceMappingURL=checkpoint.js.map