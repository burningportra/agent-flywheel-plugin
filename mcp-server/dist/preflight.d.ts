/**
 * T4.1 — Pre-flight banner renderer for `/agent-flywheel:start` Step 0c.
 *
 * Surfaces missing-deps inline above the start menu so a first-run operator
 * doesn't bounce off a cryptic downstream error. The banner only renders when
 * one of the 6 critical checks below is non-green; otherwise returns null and
 * Step 0c skips the AskUserQuestion gate entirely.
 */
import type { DoctorReportLike } from "./setup-detector.js";
/**
 * Which doctor checks gate Step 0c. Order is the render order so the banner
 * is stable across runs.
 */
export declare const PREFLIGHT_CHECK_NAMES: readonly ["br_binary", "bv_binary", "cm_binary", "agent_mail_liveness", "mcp_connectivity", "projects_base_misconfig"];
export type PreflightCheckName = (typeof PREFLIGHT_CHECK_NAMES)[number];
/**
 * Structural subset of a doctor check the banner needs. `tryThis` is the
 * preferred field; `hint` is the v3.15 fallback for handlers that didn't
 * migrate yet; a third fallback points the operator at `/flywheel-doctor`.
 */
export type PreflightCheck = {
    name: string;
    severity: "green" | "yellow" | "red";
    message?: string;
    tryThis?: string;
    hint?: string;
};
export type PreflightInput = {
    checks: PreflightCheck[];
};
/**
 * Renders the pre-flight banner block. Returns `null` when no critical
 * check is non-green — Step 0c treats null as "skip the gate."
 */
export declare function renderPreflightBanner(report: PreflightInput | DoctorReportLike): string | null;
//# sourceMappingURL=preflight.d.ts.map