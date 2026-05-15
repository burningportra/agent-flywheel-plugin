import { z } from 'zod';
import { DOCTOR_CHECK_NAMES } from './doctor.js';
import { errMsg, makeFlywheelErrorResult, sanitizeCause, classifyExecError } from '../errors.js';
import { acquireRemediateLock, releaseRemediateLock } from '../mutex.js';
import { distDriftHandler } from './remediations/dist_drift.js';
import { mcpConnectivityHandler } from './remediations/mcp_connectivity.js';
import { agentMailLivenessHandler } from './remediations/agent_mail_liveness.js';
import { orphanedWorktreesHandler } from './remediations/orphaned_worktrees.js';
import { checkpointValidityHandler } from './remediations/checkpoint_validity.js';
import { projectsBaseMisconfigHandler } from './remediations/projects_base_misconfig.js';
import { orphanTenderDaemonsHandler } from './remediations/orphan_tender_daemons.js';
import { codexConfigCompatHandler } from './remediations/codex_config_compat.js';
import { brBinaryHandler, bvBinaryHandler, ntmBinaryHandler, cmBinaryHandler, } from './remediations/cli_binary.js';
const OUTPUT_CAP_BYTES = 4 * 1024;
export const RemediateInputSchema = z.object({
    cwd: z.string().min(1),
    checkName: z.enum(DOCTOR_CHECK_NAMES),
    autoConfirm: z.boolean().optional().default(false),
    mode: z.enum(['dry_run', 'execute']).optional().default('dry_run'),
});
/**
 * Per-check registry. `null` means "no automated remediation"; T7 will
 * populate the 5 actual handlers (cli_not_available, dist_drift,
 * orphaned_worktrees, checkpoint_validity, codex_config_compat).
 *
 * Listing every DoctorCheckName explicitly gives compile-time exhaustiveness:
 * adding a new check name to DOCTOR_CHECK_NAMES forces a TS error here.
 */
export const REMEDIATION_REGISTRY = {
    mcp_connectivity: mcpConnectivityHandler,
    agent_mail_liveness: agentMailLivenessHandler,
    br_binary: brBinaryHandler,
    bv_binary: bvBinaryHandler,
    ntm_binary: ntmBinaryHandler,
    cm_binary: cmBinaryHandler,
    node_version: null,
    git_status: null,
    dist_drift: distDriftHandler,
    orphaned_worktrees: orphanedWorktreesHandler,
    checkpoint_validity: checkpointValidityHandler,
    claude_cli: null,
    codex_cli: null,
    gemini_cli: null,
    swarm_model_ratio: null,
    // claude-orchestrator-3s58 — comment out top-level `model = "gpt-5*"` /
    // `"o4-mini*"` line in ~/.codex/config.toml so the codex-companion
    // app-server falls through to its built-in default on ChatGPT-account
    // auth. Mutating, reversible (timestamped .bak.<ts> sibling).
    codex_config_compat: codexConfigCompatHandler,
    // claude-orchestrator-37n6 (v3.17.0) — gemini CLI version is user-managed;
    // no automated remediation. B15 (claude-orchestrator-2wcd) pre-flight gate
    // consults the doctor row and skips `--gmi` panes when this is yellow.
    gemini_model_compat: null,
    rescues_last_30d: null,
    npm_marketplace_version_drift: null,
    // T6.2 (v3.16.0 noob-onboarding) — escalates SIGTERM → 1s grace → SIGKILL
    // for each orphan tender-daemon PID surfaced by the n3a probe. Still
    // destructive (process state is lost), so the dispatcher requires
    // autoConfirm:true in execute mode. Skip route remains the SKILL.md hint.
    orphan_tender_daemons: orphanTenderDaemonsHandler,
    // B-AC2 — convergence state corruption is operator-driven recovery: regen the
    // ring buffer or delete the file. Auto-remediation could mask scoreVersion
    // drift across releases (the very thing the score_version_mismatch error
    // exists to surface).
    convergence_state_validity: null,
    // T12 — outcome rubric repair routes through the operator-driven Step 5.6
    // rubric gate (Re-edit / Regenerate / Skip). Auto-rewrite would silently
    // overwrite operator edits (`source: 'edited'`); the doctor hint already
    // points at the right gate.
    outcome_rubric_validity: null,
    // T6.1 (v3.16.0 noob-onboarding) — `ntm` is installed and configured with
    // a projects_base, but `<projects_base>/<basename(cwd)>` is missing. The
    // handler reads the projects_base from `ntm config show` then issues a
    // single `ln -s`. Reversible (a symlink that can be removed).
    projects_base_misconfig: projectsBaseMisconfigHandler,
};
export function assertExhaustive(_) {
    throw new Error('Non-exhaustive registry');
}
function truncate(s) {
    if (s == null)
        return undefined;
    const buf = Buffer.from(s, 'utf8');
    if (buf.byteLength <= OUTPUT_CAP_BYTES)
        return s;
    return `${buf.subarray(0, OUTPUT_CAP_BYTES - 1).toString('utf8')}…`;
}
/**
 * Dispatcher entry point for `flywheel_remediate`. Caller (server.ts, T8) is
 * responsible for top-level try/catch around invalid_input from Zod.
 */
export async function runRemediate(args, exec, signal) {
    const phase = 'doctor';
    const handler = REMEDIATION_REGISTRY[args.checkName];
    if (handler == null) {
        return makeFlywheelErrorResult('flywheel_remediate', phase, {
            code: 'remediation_unavailable',
            message: `No automated remediation registered for check '${args.checkName}'.`,
            details: { checkName: args.checkName },
        });
    }
    const lockPath = await acquireRemediateLock(args.cwd, args.checkName);
    if (lockPath == null) {
        return makeFlywheelErrorResult('flywheel_remediate', phase, {
            code: 'remediate_already_running',
            message: `Another remediation for '${args.checkName}' is already in flight.`,
            details: { checkName: args.checkName },
        });
    }
    const start = Date.now();
    const ctx = { cwd: args.cwd, exec, signal };
    try {
        let plan;
        try {
            plan = await handler.buildPlan(ctx);
        }
        catch (err) {
            return makeFlywheelErrorResult('flywheel_remediate', phase, {
                code: 'remediation_failed',
                message: `Failed to build remediation plan for '${args.checkName}'.`,
                cause: errMsg(err),
                details: { checkName: args.checkName, stage: 'buildPlan' },
            });
        }
        if (args.mode === 'dry_run') {
            return {
                check: args.checkName,
                mode: 'dry_run',
                plan,
                executed: false,
                stepsRun: 0,
                verifiedGreen: false,
                durationMs: Date.now() - start,
            };
        }
        if (plan.mutating && !args.autoConfirm) {
            return makeFlywheelErrorResult('flywheel_remediate', phase, {
                code: 'remediation_requires_confirm',
                message: `Mutating remediation for '${args.checkName}' refused without autoConfirm:true.`,
                details: { checkName: args.checkName, mutating: true, reversible: plan.reversible },
            });
        }
        let executed;
        try {
            executed = await handler.execute(ctx);
        }
        catch (err) {
            const classified = err instanceof Error ? classifyExecError(err) : null;
            return makeFlywheelErrorResult('flywheel_remediate', phase, {
                code: 'remediation_failed',
                message: `Remediation handler for '${args.checkName}' failed during execute.`,
                cause: classified?.cause ?? sanitizeCause(errMsg(err)),
                details: { checkName: args.checkName, stage: 'execute' },
            });
        }
        let verifiedGreen = false;
        try {
            verifiedGreen = await handler.verifyProbe(ctx);
        }
        catch {
            verifiedGreen = false;
        }
        return {
            check: args.checkName,
            mode: 'execute',
            plan,
            executed: true,
            stepsRun: executed.stepsRun,
            verifiedGreen,
            ...(executed.stdout != null && { stdout: truncate(executed.stdout) }),
            ...(executed.stderr != null && { stderr: truncate(executed.stderr) }),
            durationMs: Date.now() - start,
        };
    }
    finally {
        await releaseRemediateLock(args.checkName, lockPath);
    }
}
//# sourceMappingURL=remediate.js.map