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
 */
export interface FlywheelConfigConvergence {
    gate_advance_wave: boolean;
}
export interface FlywheelConfig {
    convergence: FlywheelConfigConvergence;
}
export declare const DEFAULT_CONFIG: FlywheelConfig;
export declare function loadFlywheelConfig(cwd: string): FlywheelConfig;
//# sourceMappingURL=flywheel-config.d.ts.map