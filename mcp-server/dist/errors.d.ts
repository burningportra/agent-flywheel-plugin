import { z } from 'zod';
import type { FlywheelToolName, FlywheelPhase } from './types.js';
export declare function registerTelemetryHook(hook: (code: string, ctx?: {
    hashable?: string;
}) => void): void;
export declare const FLYWHEEL_ERROR_CODES: readonly ["missing_prerequisite", "invalid_input", "not_found", "cli_failure", "cli_not_available", "parse_failure", "exec_timeout", "exec_aborted", "blocked_state", "concurrent_write", "agent_mail_unreachable", "deep_plan_all_failed", "empty_plan", "already_closed", "unsupported_action", "internal_error", "doctor_check_failed", "doctor_partial_report", "hotspot_parse_failure", "hotspot_bead_body_unparseable", "postmortem_empty_session", "postmortem_checkpoint_stale", "template_not_found", "template_placeholder_missing", "template_expansion_failed", "telemetry_store_failed", "wave_collision_detected", "review_mode_gate_failed", "review_headless_findings"];
export declare const FlywheelErrorCodeSchema: z.ZodEnum<{
    missing_prerequisite: "missing_prerequisite";
    invalid_input: "invalid_input";
    not_found: "not_found";
    cli_failure: "cli_failure";
    cli_not_available: "cli_not_available";
    parse_failure: "parse_failure";
    exec_timeout: "exec_timeout";
    exec_aborted: "exec_aborted";
    blocked_state: "blocked_state";
    concurrent_write: "concurrent_write";
    agent_mail_unreachable: "agent_mail_unreachable";
    deep_plan_all_failed: "deep_plan_all_failed";
    empty_plan: "empty_plan";
    already_closed: "already_closed";
    unsupported_action: "unsupported_action";
    internal_error: "internal_error";
    doctor_check_failed: "doctor_check_failed";
    doctor_partial_report: "doctor_partial_report";
    hotspot_parse_failure: "hotspot_parse_failure";
    hotspot_bead_body_unparseable: "hotspot_bead_body_unparseable";
    postmortem_empty_session: "postmortem_empty_session";
    postmortem_checkpoint_stale: "postmortem_checkpoint_stale";
    template_not_found: "template_not_found";
    template_placeholder_missing: "template_placeholder_missing";
    template_expansion_failed: "template_expansion_failed";
    telemetry_store_failed: "telemetry_store_failed";
    wave_collision_detected: "wave_collision_detected";
    review_mode_gate_failed: "review_mode_gate_failed";
    review_headless_findings: "review_headless_findings";
}>;
export type FlywheelErrorCode = z.infer<typeof FlywheelErrorCodeSchema>;
export declare const FlywheelToolErrorSchema: z.ZodObject<{
    code: z.ZodEnum<{
        missing_prerequisite: "missing_prerequisite";
        invalid_input: "invalid_input";
        not_found: "not_found";
        cli_failure: "cli_failure";
        cli_not_available: "cli_not_available";
        parse_failure: "parse_failure";
        exec_timeout: "exec_timeout";
        exec_aborted: "exec_aborted";
        blocked_state: "blocked_state";
        concurrent_write: "concurrent_write";
        agent_mail_unreachable: "agent_mail_unreachable";
        deep_plan_all_failed: "deep_plan_all_failed";
        empty_plan: "empty_plan";
        already_closed: "already_closed";
        unsupported_action: "unsupported_action";
        internal_error: "internal_error";
        doctor_check_failed: "doctor_check_failed";
        doctor_partial_report: "doctor_partial_report";
        hotspot_parse_failure: "hotspot_parse_failure";
        hotspot_bead_body_unparseable: "hotspot_bead_body_unparseable";
        postmortem_empty_session: "postmortem_empty_session";
        postmortem_checkpoint_stale: "postmortem_checkpoint_stale";
        template_not_found: "template_not_found";
        template_placeholder_missing: "template_placeholder_missing";
        template_expansion_failed: "template_expansion_failed";
        telemetry_store_failed: "telemetry_store_failed";
        wave_collision_detected: "wave_collision_detected";
        review_mode_gate_failed: "review_mode_gate_failed";
        review_headless_findings: "review_headless_findings";
    }>;
    message: z.ZodString;
    retryable: z.ZodOptional<z.ZodBoolean>;
    hint: z.ZodOptional<z.ZodString>;
    cause: z.ZodOptional<z.ZodString>;
    phase: z.ZodOptional<z.ZodString>;
    tool: z.ZodOptional<z.ZodString>;
    timestamp: z.ZodOptional<z.ZodString>;
    details: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export type FlywheelToolError = z.infer<typeof FlywheelToolErrorSchema>;
export declare const FlywheelStructuredErrorSchema: z.ZodObject<{
    tool: z.ZodString;
    version: z.ZodLiteral<1>;
    status: z.ZodLiteral<"error">;
    phase: z.ZodString;
    data: z.ZodObject<{
        kind: z.ZodLiteral<"error">;
        error: z.ZodObject<{
            code: z.ZodEnum<{
                missing_prerequisite: "missing_prerequisite";
                invalid_input: "invalid_input";
                not_found: "not_found";
                cli_failure: "cli_failure";
                cli_not_available: "cli_not_available";
                parse_failure: "parse_failure";
                exec_timeout: "exec_timeout";
                exec_aborted: "exec_aborted";
                blocked_state: "blocked_state";
                concurrent_write: "concurrent_write";
                agent_mail_unreachable: "agent_mail_unreachable";
                deep_plan_all_failed: "deep_plan_all_failed";
                empty_plan: "empty_plan";
                already_closed: "already_closed";
                unsupported_action: "unsupported_action";
                internal_error: "internal_error";
                doctor_check_failed: "doctor_check_failed";
                doctor_partial_report: "doctor_partial_report";
                hotspot_parse_failure: "hotspot_parse_failure";
                hotspot_bead_body_unparseable: "hotspot_bead_body_unparseable";
                postmortem_empty_session: "postmortem_empty_session";
                postmortem_checkpoint_stale: "postmortem_checkpoint_stale";
                template_not_found: "template_not_found";
                template_placeholder_missing: "template_placeholder_missing";
                template_expansion_failed: "template_expansion_failed";
                telemetry_store_failed: "telemetry_store_failed";
                wave_collision_detected: "wave_collision_detected";
                review_mode_gate_failed: "review_mode_gate_failed";
                review_headless_findings: "review_headless_findings";
            }>;
            message: z.ZodString;
            retryable: z.ZodOptional<z.ZodBoolean>;
            hint: z.ZodOptional<z.ZodString>;
            cause: z.ZodOptional<z.ZodString>;
            phase: z.ZodOptional<z.ZodString>;
            tool: z.ZodOptional<z.ZodString>;
            timestamp: z.ZodOptional<z.ZodString>;
            details: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>;
    }, z.core.$strip>;
}, z.core.$strip>;
export type FlywheelStructuredError = z.infer<typeof FlywheelStructuredErrorSchema>;
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
export declare const DEFAULT_RETRYABLE: Record<FlywheelErrorCode, boolean>;
export declare class FlywheelError extends Error {
    readonly code: FlywheelErrorCode;
    readonly retryable: boolean;
    readonly hint?: string;
    readonly cause?: string;
    readonly details?: Record<string, unknown>;
    constructor(input: {
        code: FlywheelErrorCode;
        message: string;
        retryable?: boolean;
        hint?: string;
        cause?: string;
        details?: Record<string, unknown>;
    });
    toJSON(): FlywheelToolError;
}
export declare function throwFlywheelError(input: {
    code: FlywheelErrorCode;
    message: string;
    retryable?: boolean;
    hint?: string;
    cause?: string;
    details?: Record<string, unknown>;
}): never;
/**
 * Redact absolute filesystem paths and cap length before embedding raw error
 * messages in MCP-visible structured output. Prevents local-path leakage via
 * FlywheelToolError.cause without losing signal value for debugging.
 */
export declare function sanitizeCause(raw: string, maxLen?: number): string;
export declare function classifyExecError(err: unknown): {
    code: 'exec_timeout' | 'exec_aborted' | 'cli_failure';
    retryable: boolean;
    cause: string;
};
export declare function makeFlywheelErrorResult(tool: FlywheelToolName, phase: FlywheelPhase, input: Omit<FlywheelToolError, 'timestamp' | 'tool' | 'phase'>): {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError: true;
    structuredContent: FlywheelStructuredError;
};
//# sourceMappingURL=errors.d.ts.map