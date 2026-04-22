import type { FlywheelErrorCode } from './errors.js';
import type { ErrorCodeTelemetry } from './types.js';
export interface TelemetryOptions {
    /** Base directory; spool lives at <cwd>/.pi-flywheel/error-counts.json */
    cwd: string;
    /** Defaults to new Date().toISOString() */
    sessionStartIso?: string;
    /** Ring buffer size; default 100 */
    maxEvents?: number;
    /** Top-N tracking; default 20 */
    maxCodes?: number;
}
/**
 * Record an error code into the in-memory aggregator.
 * Fire-and-forget: never throws. No-op when called re-entrantly.
 */
export declare function recordErrorCode(code: FlywheelErrorCode, ctx?: {
    hashable?: string;
}, opts?: TelemetryOptions): void;
/**
 * Flush the in-memory aggregator to .pi-flywheel/error-counts.json.
 * Merges with existing spool (dual-session support).
 * Returns false on store failure (never throws).
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