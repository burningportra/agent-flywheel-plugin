export declare const FLYWHEEL_ERROR_CODES: readonly ["missing_prerequisite", "invalid_input", "not_found", "cli_failure", "cli_not_available", "parse_failure", "exec_timeout", "exec_aborted", "blocked_state", "concurrent_write", "agent_mail_unreachable", "deep_plan_all_failed", "empty_plan", "already_closed", "unsupported_action", "internal_error", "doctor_check_failed", "doctor_partial_report", "hotspot_parse_failure", "hotspot_bead_body_unparseable", "postmortem_empty_session", "postmortem_checkpoint_stale", "template_not_found", "template_placeholder_missing", "template_expansion_failed", "telemetry_store_failed", "wave_collision_detected", "review_mode_gate_failed", "review_headless_findings", "remediation_unavailable", "remediation_requires_confirm", "remediation_failed", "remediate_already_running", "bundle_integrity_failed", "bundle_stale", "viewer_port_in_use", "attestation_missing", "attestation_invalid", "rubric_synth_invalid", "rubric_missing", "grader_timeout", "verdict_invalid", "grader_unavailable", "cycle_start_sha_unset", "outcome_iteration_capped", "concurrent_grade", "compliance_false_closed", "poteto_prerequisite_missing", "pre_code_research_incomplete", "verification_missing", "verification_failed", "verification_sha_drift"];
export type FlywheelErrorCode = (typeof FLYWHEEL_ERROR_CODES)[number];
/**
 * T1.2 (v3.16.0 noob-onboarding) — type-level enforcement that every
 * FlywheelErrorCode carries both a narrative `hint` and an imperative,
 * paste-ready `tryThis`. The data itself lives in `errors-try-this.ts`
 * as `ERROR_META: Record<FlywheelErrorCode, ErrorMeta>`; a missing key
 * (compile-time) or empty string (runtime test + verify-error-meta.js
 * build gate) fails the build.
 *
 * Field naming: snake_case (`try_this`) is preserved on the wire
 * envelope (`FlywheelToolError`); camelCase (`tryThis`) is the internal shape
 * that `errors-try-this.ts` uses to derive `ERROR_META`.
 */
export type ErrorMeta = {
    readonly hint: string;
    readonly tryThis: string;
};
/** The wire shape `FlywheelError.toJSON()` returns; `FlywheelToolErrorSchema` in errors.ts validates it. */
export interface FlywheelErrorJson {
    code: FlywheelErrorCode;
    message: string;
    retryable?: boolean;
    hint?: string;
    try_this?: string;
    cause?: string;
    details?: Record<string, unknown>;
}
/**
 * Default actionable hint per error code.
 *
 * Acts as a safety net so every FlywheelError carries a non-empty,
 * remediation-oriented hint even if the call site forgets to pass one.
 * Call sites SHOULD still pass a contextual hint when they have more
 * specific information (e.g. the exact CLI invocation that failed) —
 * the per-call hint always wins. The contract enforced by
 * error-contract.test.ts: each value must be a sentence > 30 chars and
 * MUST NOT echo the code name (`hint !== code`).
 *
 * Added in agent-flywheel-plugin-9p3 to give the iteration test a
 * single source of truth to assert against, parallel to
 * DEFAULT_RETRYABLE.
 */
export declare const DEFAULT_HINTS: Record<FlywheelErrorCode, string>;
/**
 * R-007 — default `try_this` per error code. Imperative, paste-ready.
 *
 * Where DEFAULT_HINTS describes what went wrong, DEFAULT_TRY_THIS tells
 * the agent the exact next call/command to make. Call sites SHOULD pass
 * a more specific try_this when they have one (e.g. naming the exact
 * field, the rejected enum value, the sample corrected invocation) —
 * the per-call value wins.
 *
 * Contract (enforced by error-contract.test.ts and capabilities snapshot):
 *   - every entry MUST be present (TypeScript Record enforces)
 *   - every entry MUST start with an imperative verb (Run, Call, Set, etc.)
 *   - every entry MUST be > 30 chars
 *   - every entry MUST NOT echo the code name verbatim
 */
export declare const DEFAULT_TRY_THIS: Record<FlywheelErrorCode, string>;
export declare const DEFAULT_RETRYABLE: Record<FlywheelErrorCode, boolean>;
export declare class FlywheelError extends Error {
    readonly code: FlywheelErrorCode;
    readonly retryable: boolean;
    readonly hint?: string;
    /** R-007 — paste-ready next-step. Defaulted from DEFAULT_TRY_THIS. */
    readonly try_this?: string;
    readonly cause?: string;
    readonly details?: Record<string, unknown>;
    constructor(input: {
        code: FlywheelErrorCode;
        message: string;
        retryable?: boolean;
        hint?: string;
        try_this?: string;
        cause?: string;
        details?: Record<string, unknown>;
    });
    toJSON(): FlywheelErrorJson;
}
export declare function throwFlywheelError(input: {
    code: FlywheelErrorCode;
    message: string;
    retryable?: boolean;
    hint?: string;
    try_this?: string;
    cause?: string;
    details?: Record<string, unknown>;
}): never;
/**
 * Coerce an `unknown` caught error to its message string. Equivalent to the
 * inline `err instanceof Error ? err.message : String(err)` pattern but keeps
 * call sites readable. Pure, total over `unknown`, never throws.
 */
export declare function errMsg(err: unknown): string;
//# sourceMappingURL=errors-core.d.ts.map