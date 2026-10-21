/**
 * bv-runner: thin wrapper around `bv --robot-*` graph-analysis flags.
 *
 * Every call carries an explicit `timeout` (default 5s) and propagates the
 * caller's `AbortSignal`, per the degraded-mode contract: when `bv` is
 * missing, exits non-zero, or emits unparsable output, the result is
 * `{ available: false, warning }` — never a throw — so callers can enrich
 * responses best-effort and keep working.
 */
import type { ExecFn } from './exec.js';
export type BvRobotMode = 'triage' | 'next' | 'plan' | 'insights';
export interface BvRobotResult {
    available: boolean;
    data: unknown;
    raw?: string;
    warning?: string;
}
export interface BvRobotOpts {
    timeout?: number;
    signal?: AbortSignal;
}
/** Default per-call budget for `bv --robot-*` (ms). */
export declare const BV_ROBOT_TIMEOUT_MS = 5000;
export declare function runBvRobot(exec: ExecFn, cwd: string, mode: BvRobotMode, opts?: BvRobotOpts): Promise<BvRobotResult>;
//# sourceMappingURL=bv-runner.d.ts.map