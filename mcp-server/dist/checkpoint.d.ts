/**
 * Checkpoint persistence for crash recovery.
 *
 * Writes flywheel state to `<cwd>/.pi-flywheel/checkpoint.json`
 * using atomic write-rename semantics. All I/O is non-throwing —
 * failures degrade gracefully to current session-log-only behavior.
 */
import type { CheckpointEnvelope, FlywheelState } from "./types.js";
export declare const CHECKPOINT_DIR = ".pi-flywheel";
export declare const CHECKPOINT_FILE = "checkpoint.json";
export declare const CHECKPOINT_TMP = "checkpoint.json.tmp";
export declare const CHECKPOINT_CORRUPT = "checkpoint.json.corrupt";
/** Compute SHA-256 hash of JSON.stringify(state). */
export declare function computeStateHash(state: FlywheelState): string;
export type ValidationResult = {
    valid: true;
    warnings?: string[];
} | {
    valid: false;
    reason: string;
};
/**
 * Validate a parsed checkpoint envelope against all integrity rules.
 * Pure function — no I/O.
 */
export declare function validateCheckpoint(envelope: unknown): ValidationResult;
/**
 * Serialize checkpoint writes per cwd via Promise chaining.
 * Concurrent callers for the same cwd are queued; a failed write
 * resolves to false without blocking subsequent writes.
 */
export declare function writeCheckpoint(cwd: string, state: FlywheelState): Promise<boolean>;
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
export declare function readCheckpoint(cwd: string): ReadCheckpointResult | null;
/**
 * Delete the checkpoint file. Idempotent — no error if file doesn't exist.
 * Never throws.
 */
export declare function clearCheckpoint(cwd: string): void;
/** Remove orphaned .tmp files left from crashes during write. */
export declare function cleanupOrphanedTmp(cwd: string): void;
//# sourceMappingURL=checkpoint.d.ts.map