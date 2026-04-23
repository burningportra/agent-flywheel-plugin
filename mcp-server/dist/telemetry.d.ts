import type { FlywheelErrorCode } from './errors.js';
import type { ErrorCodeTelemetry } from './types.js';
export interface TelemetryOptions {
    /** Base directory; spool lives at <cwd>/.pi-flywheel/error-counts.json */
    cwd: string;
    /** Defaults to new Date().toISOString() */
    sessionStartIso?: string;
    /**
     * GLOBAL ring-buffer cap across all codes (NOT per-code). v3.4.1 P1-2.
     * Default 100. The aggregator evicts oldest entries from the largest
     * bucket when the total exceeds this bound.
     */
    maxEvents?: number;
    /** Top-N tracking; default 20 */
    maxCodes?: number;
}
/**
 * Record an error code into the in-memory aggregator.
 * Fire-and-forget: never throws. No-op when called re-entrantly.
 *
 * Memory-footprint bound (v3.4.1 P1-2): after appending the new entry, this
 * function enforces a GLOBAL cap of `maxEvents` total ring entries across all
 * buckets (not per-bucket). When the global count exceeds the cap, the oldest
 * entries are evicted from the largest bucket. Counts (`bucket.count`) are
 * preserved — only the ring history is bounded.
 */
export declare function recordErrorCode(code: FlywheelErrorCode, ctx?: {
    hashable?: string;
}, opts?: TelemetryOptions): void;
/**
 * Flush the in-memory aggregator to .pi-flywheel/error-counts.json.
 * Merges with existing spool (dual-session support).
 * Returns false on store failure (never throws).
 *
 * v3.4.1 P1-3: the read→merge→rename critical section is held under an
 * O_EXCL sentinel (`error-counts.lock`) on the FINAL spool path, so two
 * concurrent flushes serialize and counts sum correctly. The previous
 * implementation O_EXCL'd only the .tmp filename, which prevented two
 * processes from writing the same tmp simultaneously but did NOT prevent
 * two read-merge-rename cycles from racing and clobbering each other.
 */
export declare function flushTelemetry(opts: TelemetryOptions): Promise<boolean>;
/**
 * Read the current spool from disk.
 * Returns null if file is absent or unparseable.
 * Tolerates unknown codes (forward-compat contract).
 */
export declare function readTelemetry(opts: TelemetryOptions): Promise<ErrorCodeTelemetry | null>;
/**
 * Reset the module-level aggregator and session start.
 * Exported for test use only — do not call from production code.
 *
 * @internal
 */
export declare function _resetTelemetryForTest(): void;
//# sourceMappingURL=telemetry.d.ts.map