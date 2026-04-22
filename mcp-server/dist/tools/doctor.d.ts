/**
 * flywheel_doctor check engine — PURE (no server registration here; see I4).
 *
 * Executes a fixed battery of health checks in parallel via
 * `Promise.allSettled`, with:
 *   - per-check timeout (default 2s)
 *   - global sweep budget (default 10s) via AbortSignal short-circuit
 *   - concurrent-child-process cap (default 6) via a lightweight semaphore
 *
 * Individual check failures NEVER throw from `runDoctorChecks` — they become
 * `red` / `yellow` entries in the returned `DoctorReport`. The tool-level
 * envelope is built by the I4 registration wrapper.
 */
import { type ExecFn } from '../exec.js';
import type { DoctorCheck, DoctorCheckSeverity, DoctorReport } from '../types.js';
/** Canonical check names. Exported for test assertions. */
export declare const DOCTOR_CHECK_NAMES: readonly ["mcp_connectivity", "agent_mail_liveness", "br_binary", "bv_binary", "ntm_binary", "cm_binary", "node_version", "git_status", "dist_drift", "orphaned_worktrees", "checkpoint_validity"];
export type DoctorCheckName = (typeof DOCTOR_CHECK_NAMES)[number];
export interface DoctorOptions {
    /** Override per-check timeout (ms). */
    perCheckTimeoutMs?: number;
    /** Override total sweep budget (ms). */
    totalBudgetMs?: number;
    /** Override max concurrency. */
    maxConcurrency?: number;
    /** Override ExecFn (tests). Defaults to `makeExec(cwd)`. */
    exec?: ExecFn;
    /** Override clock for deterministic elapsed/timestamp (tests). */
    now?: () => number;
}
/**
 * Run all 11 health checks in parallel. Never throws.
 *
 * If `signal` fires before any check completes, the returned report has
 * `partial: true`, empty `checks`, `overall: 'red'`, `elapsedMs: 0`.
 */
export declare function runDoctorChecks(cwd: string, signal?: AbortSignal, options?: DoctorOptions): Promise<DoctorReport>;
/**
 * Reduce a list of checks to a single overall severity.
 * - red if any check is red
 * - yellow if any check is yellow (and none red)
 * - green otherwise (including empty list — but empty-list callers usually
 *   set partial:true and override to red themselves)
 */
export declare function computeOverallSeverity(checks: DoctorCheck[]): DoctorCheckSeverity;
//# sourceMappingURL=doctor.d.ts.map