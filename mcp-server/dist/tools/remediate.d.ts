import { z } from 'zod';
import type { ExecFn } from '../exec.js';
import { type DoctorCheckName } from './doctor.js';
import { makeFlywheelErrorResult } from '../errors.js';
export declare const RemediateInputSchema: z.ZodObject<{
    cwd: z.ZodString;
    checkName: z.ZodEnum<{
        orphan_tender_daemons: "orphan_tender_daemons";
        mcp_connectivity: "mcp_connectivity";
        agent_mail_liveness: "agent_mail_liveness";
        br_binary: "br_binary";
        bv_binary: "bv_binary";
        ntm_binary: "ntm_binary";
        cm_binary: "cm_binary";
        node_version: "node_version";
        git_status: "git_status";
        dist_drift: "dist_drift";
        orphaned_worktrees: "orphaned_worktrees";
        checkpoint_validity: "checkpoint_validity";
        claude_cli: "claude_cli";
        codex_cli: "codex_cli";
        gemini_cli: "gemini_cli";
        swarm_model_ratio: "swarm_model_ratio";
        codex_config_compat: "codex_config_compat";
        rescues_last_30d: "rescues_last_30d";
        npm_marketplace_version_drift: "npm_marketplace_version_drift";
    }>;
    autoConfirm: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    mode: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        dry_run: "dry_run";
        execute: "execute";
    }>>>;
}, z.core.$strip>;
export type RemediateInput = z.infer<typeof RemediateInputSchema>;
export interface RemediationPlan {
    description: string;
    steps: string[];
    mutating: boolean;
    reversible: boolean;
}
export interface RemediationResult {
    check: DoctorCheckName;
    mode: 'dry_run' | 'execute';
    plan: RemediationPlan;
    executed: boolean;
    stepsRun: number;
    verifiedGreen: boolean;
    stdout?: string;
    stderr?: string;
    durationMs: number;
}
export interface HandlerCtx {
    cwd: string;
    exec: ExecFn;
    signal: AbortSignal;
}
export interface RemediationHandler {
    description: string;
    mutating: boolean;
    reversible: boolean;
    buildPlan(ctx: HandlerCtx): Promise<RemediationPlan>;
    execute(ctx: HandlerCtx): Promise<{
        stepsRun: number;
        stdout?: string;
        stderr?: string;
    }>;
    verifyProbe(ctx: HandlerCtx): Promise<boolean>;
}
/**
 * Per-check registry. `null` means "no automated remediation"; T7 will
 * populate the 5 actual handlers (cli_not_available, dist_drift,
 * orphaned_worktrees, checkpoint_validity, codex_config_compat).
 *
 * Listing every DoctorCheckName explicitly gives compile-time exhaustiveness:
 * adding a new check name to DOCTOR_CHECK_NAMES forces a TS error here.
 */
export declare const REMEDIATION_REGISTRY: Record<DoctorCheckName, RemediationHandler | null>;
export declare function assertExhaustive(_: never): never;
/**
 * Dispatcher entry point for `flywheel_remediate`. Caller (server.ts, T8) is
 * responsible for top-level try/catch around invalid_input from Zod.
 */
export declare function runRemediate(args: RemediateInput, exec: ExecFn, signal: AbortSignal): Promise<RemediationResult | ReturnType<typeof makeFlywheelErrorResult>>;
//# sourceMappingURL=remediate.d.ts.map