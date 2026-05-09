/**
 * Minimal loader for `flywheel.config.yaml` at the repo root.
 *
 * Only the fields B-AC2 introduces are read here. We intentionally do NOT add a
 * YAML dependency — the file is expected to be hand-edited and small, and a
 * deliberately tiny parser keeps the install footprint flat (Phase 12 §12.5
 * "no optional deps" trap-avoidance bullet).
 *
 * Schema (v1):
 *
 *   convergence:
 *     gate_advance_wave: true   # default true
 *
 * R-008 (agent-ergonomics audit pass 4) — strict-key validation with
 * Levenshtein-1 typo suggestions. Currently warn-only (collect warnings
 * on the result; callers decide how to surface them). The deprecation
 * path is: v3.x warns, v4.0 fails. This is the warn-only stage.
 */
export interface FlywheelConfigConvergence {
    gate_advance_wave: boolean;
}
export interface FlywheelConfig {
    convergence: FlywheelConfigConvergence;
}
/**
 * R-008 — single warning surfaced from the loader. Each reports a
 * structural problem in the YAML that did not block the load (the
 * fields we recognized still loaded with their defaults).
 */
export interface FlywheelConfigWarning {
    kind: 'unknown_key' | 'wrong_type' | 'unparseable_yaml';
    /** dotted path to the offending key, e.g. "convergence.gate_advance_wav" */
    path: string;
    message: string;
    /** present for unknown_key when a Levenshtein-1 match exists */
    suggestion?: string;
}
export interface FlywheelConfigResult {
    config: FlywheelConfig;
    warnings: FlywheelConfigWarning[];
    /** absolute path that was attempted (whether or not it existed) */
    source: string;
}
export declare const DEFAULT_CONFIG: FlywheelConfig;
/**
 * R-008 — return the closest known key within Levenshtein distance 1, or
 * undefined if nothing is close enough. Used to suggest "did you mean".
 */
export declare function suggestKey(unknown: string, known: readonly string[]): string | undefined;
/**
 * R-008 — full loader returning config + warnings + source. The
 * `loadFlywheelConfig` thin wrapper preserves the existing single-value
 * return type for callers that don't care about warnings.
 */
export declare function loadFlywheelConfigWithWarnings(cwd: string): FlywheelConfigResult;
export declare function loadFlywheelConfig(cwd: string): FlywheelConfig;
//# sourceMappingURL=flywheel-config.d.ts.map