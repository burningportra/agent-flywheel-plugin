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
import type { DoctorCheck, DoctorCheckSeverity, DoctorReport, ErrorCodeTelemetry } from '../types.js';
/** Canonical check names. Exported for test assertions. */
export declare const DOCTOR_CHECK_NAMES: readonly ["mcp_connectivity", "agent_mail_liveness", "br_binary", "bv_binary", "ntm_binary", "cm_binary", "node_version", "git_status", "dist_drift", "orphaned_worktrees", "checkpoint_validity", "claude_cli", "codex_cli", "gemini_cli", "swarm_model_ratio", "codex_config_compat", "rescues_last_30d"];
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
    /** Override path to ~/.codex/config.toml (tests). Pass a fixture path or
     * `null` to skip reading. Defaults to `~/.codex/config.toml`. */
    codexConfigPath?: string | null;
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
/**
 * 16. `rescues_last_30d` — synthesised count of `/codex:rescue` handoff
 * events recorded in CASS over the last 30 days. The rescue branches in
 * `_planning.md` Phase 0.6, `_implement.md` stall section, and `_review.md`
 * Step 8.5 persist each handoff via `flywheel_memory(operation="store",
 * content=formatRescueEventForMemory(packet))` — that formatter emits the
 * canonical prefix `flywheel-rescue` which we count here.
 *
 * Severity:
 *   - green when 0–4 rescues in the window (normal operating volume).
 *   - yellow when 5–14 (frequent stalls — investigate hotspots).
 *   - red when 15+ (severe — indicates Claude lane degradation).
 *   - yellow if `cm` CLI is absent (cannot count, observability degraded).
 *
 * Read-only: only invokes `cm context`. Never mutates CASS.
 */
/**
 * Pure parser for ~/.codex/config.toml. Looks for the top-level `model`
 * key and reports its raw value (TOML-stripped quotes). Returns null if
 * the key is absent, commented out, or only set inside a [section].
 *
 * Intentionally simple — we only care about `model = "..."` at the root
 * level above the first `[section]` header. A real TOML parser would be
 * overkill for one key.
 *
 * Exported for test access only.
 */
export declare function parseCodexConfigTopLevelModel(content: string): string | null;
export declare function isCodexIncompatibleModel(model: string): boolean;
export declare function countLocalTelemetryRescuesWithin30Days(telemetry: ErrorCodeTelemetry, nowMs: number): number;
/**
 * Count `flywheel-rescue` entries in a `cm context --json` payload whose
 * embedded `ts=` ISO timestamp falls within the last 30 days. Pure (no
 * I/O) and defensive — ignores unparseable rows rather than throwing.
 *
 * Exported for test access.
 */
export declare function countRescueEntriesWithin30Days(raw: string, nowMs: number): number;
//# sourceMappingURL=doctor.d.ts.map