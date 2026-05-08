import { z } from 'zod';
import { makeOkToolResult, makeToolError } from './shared.js';
export const ComplianceAuditArgsSchema = z.object({
    cwd: z.string().min(1),
    beadIds: z.array(z.string()),
    mode: z.enum(['single-bead', 'standard']).optional(),
    threshold: z.number().optional(),
    parallelism: z.number().optional(),
    skipEnv: z.string().optional(),
});
function complianceOutcome(status, startedAt) {
    return {
        kind: 'compliance_audit_outcome',
        status,
        passed: [],
        failed: [],
        passUtc: null,
        errors: {},
        durationMs: Date.now() - startedAt,
    };
}
export async function runComplianceAudit(ctx, rawArgs) {
    const startedAt = Date.now();
    const parsed = ComplianceAuditArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ');
        return makeToolError('flywheel_compliance_audit', ctx.state.phase ?? 'reviewing', 'invalid_input', `Error: invalid compliance audit arguments: ${issues}`, { hint: 'Pass { cwd, beadIds, mode?, threshold?, parallelism?, skipEnv? } per the tool inputSchema.' });
    }
    const args = parsed.data;
    // Empty wave — no-op success.
    if (args.beadIds.length === 0) {
        return makeOkToolResult('flywheel_compliance_audit', 'reviewing', 'No beads to audit.', complianceOutcome('ok', startedAt));
    }
    // Skip-env override (emergency unblock).
    const overrideEnv = args.skipEnv ?? process.env.FW_COMPLIANCE_OVERRIDE;
    if (overrideEnv && overrideEnv.length > 0) {
        return makeOkToolResult('flywheel_compliance_audit', 'reviewing', `Compliance audit skipped via FW_COMPLIANCE_OVERRIDE=${overrideEnv}.`, complianceOutcome('skipped', startedAt));
    }
    // TODO(Task 6): spawn skill, parse result.json
    // TODO(Task 7): side effects (br update, telemetry, CASS)
    throw new Error('not implemented - Task 6');
}
//# sourceMappingURL=compliance-audit.js.map