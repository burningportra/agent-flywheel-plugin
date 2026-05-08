/**
 * `flywheel_synthesize_rubric` MCP tool wrapper (T7 / claude-orchestrator-3g9).
 *
 * Calls `synthesizeRubric()` from `outcome-grading.ts` and packages the
 * result into the `version: 1` MCP envelope. Discriminator `kind`:
 *
 *   - `rubric_synthesized` — fresh synth (auto, regenerate, or initial run)
 *   - `rubric_preserved`   — existing edited/user rubric was kept (cache hit)
 *   - `rubric_edited`      — operator edit applied via `action: 'edit'`
 *   - `rubric_validated`   — `action: 'validate'` returned the current rubric
 *
 * Errors flow through `makeFlywheelErrorResult` so the SKILL.md
 * orchestrator branches on `data.error.code` (FlywheelErrorCode).
 */
import { z } from 'zod';
import { FlywheelError, makeFlywheelErrorResult, errMsg } from '../errors.js';
import { synthesizeRubric } from '../outcome-grading.js';
import { makeNextToolStep, makeToolResult } from './shared.js';
export const SynthesizeRubricInputSchema = z.object({
    cwd: z.string().min(1),
    planSlug: z.string().min(1).optional(),
    planPath: z.string().min(1).optional(),
    action: z
        .enum(['synthesize', 'validate', 'edit', 'regenerate'])
        .optional()
        .default('synthesize'),
    editIntent: z
        .object({
        kind: z.enum(['tighten', 'add', 'remove', 'custom']),
        text: z.string().min(1),
    })
        .optional(),
    force: z.boolean().optional(),
});
function classifyKind(action, result) {
    if (action === 'validate')
        return 'rubric_validated';
    if (action === 'edit')
        return 'rubric_edited';
    if (result.source === 'cached')
        return 'rubric_preserved';
    return 'rubric_synthesized';
}
export async function runSynthesizeRubric(ctx, rawArgs) {
    const parsedInput = SynthesizeRubricInputSchema.safeParse(rawArgs);
    if (!parsedInput.success) {
        const issues = parsedInput.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; ');
        return makeFlywheelErrorResult('flywheel_synthesize_rubric', ctx.state.phase, {
            code: 'invalid_input',
            message: `flywheel_synthesize_rubric: ${issues}`,
            hint: 'Pass { cwd, action?, planSlug?, planPath?, editIntent?, force? } per the tool inputSchema.',
        });
    }
    const args = parsedInput.data;
    if (args.action === 'edit' && !args.editIntent) {
        return makeFlywheelErrorResult('flywheel_synthesize_rubric', ctx.state.phase, {
            code: 'invalid_input',
            message: "flywheel_synthesize_rubric: action='edit' requires editIntent",
            hint: 'Pass editIntent: { kind, text } when action=edit; otherwise use synthesize / regenerate / validate.',
        });
    }
    const callArgs = {
        cwd: args.cwd,
        planSlug: args.planSlug,
        planPath: args.planPath,
        action: args.action,
        editIntent: args.editIntent,
        force: args.force,
    };
    try {
        const result = await synthesizeRubric(ctx, callArgs);
        const kind = classifyKind(args.action, result);
        const text = kind === 'rubric_validated'
            ? `Rubric at ${result.rubricPath} validated (${result.rubric.criteria.length} criteria, source ${result.rubric.source}).`
            : kind === 'rubric_preserved'
                ? `Rubric at ${result.rubricPath} preserved unchanged (source ${result.rubric.source}). Pass force=true / action=regenerate to overwrite.`
                : kind === 'rubric_edited'
                    ? `Rubric at ${result.rubricPath} updated via action=edit (${result.rubric.criteria.length} criteria, source ${result.rubric.source}).`
                    : `Rubric synthesised at ${result.rubricPath} (${result.rubric.criteria.length} criteria, source ${result.rubric.source}).`;
        const structured = {
            tool: 'flywheel_synthesize_rubric',
            version: 1,
            status: 'ok',
            data: {
                kind,
                rubricPath: result.rubricPath,
                rubric: result.rubric,
                source: result.source,
            },
            nextStep: makeNextToolStep('present_choices', 'Approve / Edit inline / Regenerate / Skip rubric — see Step 5.6 rubric gate.'),
        };
        return makeToolResult(text, structured);
    }
    catch (err) {
        if (err instanceof FlywheelError) {
            return makeFlywheelErrorResult('flywheel_synthesize_rubric', ctx.state.phase, {
                code: err.code,
                message: err.message,
                retryable: err.retryable,
                hint: err.hint,
                cause: err.cause,
                details: err.details,
            });
        }
        return makeFlywheelErrorResult('flywheel_synthesize_rubric', ctx.state.phase, {
            code: 'internal_error',
            message: 'flywheel_synthesize_rubric threw',
            cause: errMsg(err),
        });
    }
}
//# sourceMappingURL=synthesize-rubric.js.map