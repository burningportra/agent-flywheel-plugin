import { z } from 'zod';
import { type RescuePacket } from '../codex-handoff.js';
import { type FlywheelErrorCode } from '../errors.js';
import type { McpToolResult, ToolContext } from '../types.js';
declare const TOOL_NAME: "flywheel_rescue";
export declare const RescueInputSchema: z.ZodObject<{
    cwd: z.ZodString;
    phase: z.ZodEnum<{
        plan: "plan";
        impl: "impl";
        review: "review";
    }>;
    beadId: z.ZodOptional<z.ZodString>;
    errorEnvelope: z.ZodOptional<z.ZodObject<{
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
            remediation_unavailable: "remediation_unavailable";
            remediation_requires_confirm: "remediation_requires_confirm";
            remediation_failed: "remediation_failed";
            remediate_already_running: "remediate_already_running";
            bundle_integrity_failed: "bundle_integrity_failed";
            bundle_stale: "bundle_stale";
            viewer_port_in_use: "viewer_port_in_use";
            attestation_missing: "attestation_missing";
            attestation_invalid: "attestation_invalid";
            rubric_synth_invalid: "rubric_synth_invalid";
            rubric_missing: "rubric_missing";
            grader_timeout: "grader_timeout";
            verdict_invalid: "verdict_invalid";
            grader_unavailable: "grader_unavailable";
            cycle_start_sha_unset: "cycle_start_sha_unset";
            outcome_iteration_capped: "outcome_iteration_capped";
            concurrent_grade: "concurrent_grade";
            compliance_false_closed: "compliance_false_closed";
            poteto_prerequisite_missing: "poteto_prerequisite_missing";
            pre_code_research_incomplete: "pre_code_research_incomplete";
            verification_missing: "verification_missing";
            verification_failed: "verification_failed";
            verification_sha_drift: "verification_sha_drift";
        }>;
        message: z.ZodOptional<z.ZodString>;
        hint: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    notes: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type RescueArgs = z.infer<typeof RescueInputSchema>;
export interface RescueToolData {
    packet: RescuePacket;
    codexPrompt: string;
    memoryLine: string;
}
export interface RescueSuccessEnvelope {
    tool: typeof TOOL_NAME;
    version: 1;
    status: 'ok';
    phase: string;
    data: RescueToolData;
}
export interface RescueErrorEnvelope {
    tool: typeof TOOL_NAME;
    version: 1;
    status: 'error';
    phase: string;
    data: {
        kind: 'error';
        error: {
            code: FlywheelErrorCode;
            message: string;
            retryable: boolean;
            hint: string;
            try_this: string;
            cause?: string;
            details?: Record<string, unknown>;
            timestamp: string;
        };
    };
}
type RescueToolResult = McpToolResult<RescueSuccessEnvelope | RescueErrorEnvelope>;
export declare function runRescue(ctx: ToolContext, input: unknown): Promise<RescueToolResult>;
export {};
//# sourceMappingURL=rescue.d.ts.map