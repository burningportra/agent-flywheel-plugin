/**
 * `flywheel_grade_outcome` MCP tool wrapper (T8 / claude-orchestrator-not).
 *
 * Calls `gradeOutcome()` from `outcome-grading.ts` and packages the result
 * into the `version: 1` MCP envelope with discriminator `kind`:
 *
 *   - `grader_verdict`             — verdict computed and persisted
 *   - `grading_skipped`            — operator skipped at plan-approve gate
 *   - `grading_capped`             — verdict status was coerced to
 *                                    `max_iterations_reached` server-side
 *   - `grading_persistence_failed` — verdict in-memory; disk write failed
 *
 * Timeout / unavailable / verdict-parse failures route through
 * `makeFlywheelErrorResult` with the matching FlywheelErrorCode.
 */

import { z } from 'zod';

import { FlywheelError, makeFlywheelErrorResult, errMsg } from '../errors.js';
import {
  gradeOutcome,
  isGradeSkipped,
  type GraderVerdict,
  type GradeOutcomeArgs,
} from '../outcome-grading.js';
import type { McpToolResult, ToolContext } from '../types.js';
import { makeNextToolStep, makeToolResult } from './shared.js';

export const GradeOutcomeInputSchema = z.object({
  cwd: z.string().min(1),
  planSlug: z.string().min(1).optional(),
  force: z.boolean().optional(),
});

export type GradeOutcomeInput = z.infer<typeof GradeOutcomeInputSchema>;

type GradeVerdictKind = 'grader_verdict' | 'grading_capped' | 'grading_persistence_failed';

interface GradeStructured {
  tool: 'flywheel_grade_outcome';
  version: 1;
  status: 'ok';
  data:
    | {
        kind: 'grader_verdict' | 'grading_capped' | 'grading_persistence_failed';
        verdict: GraderVerdict;
      }
    | {
        kind: 'grading_skipped';
        reason: 'operator-skipped-at-plan-approve';
      };
  nextStep?: ReturnType<typeof makeNextToolStep>;
}

function classifyVerdictKind(verdict: GraderVerdict): GradeVerdictKind {
  if (verdict.persistence === 'failed') return 'grading_persistence_failed';
  if (verdict.status === 'max_iterations_reached') return 'grading_capped';
  return 'grader_verdict';
}

function summariseVerdict(verdict: GraderVerdict): string {
  const unmet = verdict.perCriterion.filter((c) => c.status === 'unmet').length;
  const partial = verdict.perCriterion.filter((c) => c.status === 'partial').length;
  return `Outcome grade: ${verdict.status} @ iter ${verdict.iteration} (${unmet} unmet, ${partial} partial). Grader: ${verdict.modelUsed} in ${verdict.durationMs}ms.`;
}

export async function runGradeOutcome(
  ctx: ToolContext,
  rawArgs: unknown,
): Promise<McpToolResult> {
  const parsedInput = GradeOutcomeInputSchema.safeParse(rawArgs);
  if (!parsedInput.success) {
    const issues = parsedInput.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return makeFlywheelErrorResult('flywheel_grade_outcome' as never, ctx.state.phase, {
      code: 'invalid_input',
      message: `flywheel_grade_outcome: ${issues}`,
      hint: 'Pass { cwd, planSlug?, force? } per the tool inputSchema.',
    });
  }
  const args = parsedInput.data;
  const callArgs: GradeOutcomeArgs = {
    cwd: args.cwd,
    planSlug: args.planSlug,
    force: args.force,
  };
  try {
    const result = await gradeOutcome(ctx, callArgs);
    if (isGradeSkipped(result)) {
      const structured: GradeStructured = {
        tool: 'flywheel_grade_outcome',
        version: 1,
        status: 'ok',
        data: { kind: 'grading_skipped', reason: result.reason },
        nextStep: makeNextToolStep(
          'none',
          'Outcome grading skipped for this cycle by operator choice; continue Step 9.5 normally.',
        ),
      };
      return makeToolResult(
        'Outcome grading skipped for this cycle by operator choice at plan approval.',
        structured,
      );
    }
    const verdict = result;
    const kind = classifyVerdictKind(verdict);
    const summary = summariseVerdict(verdict);
    const structured: GradeStructured = {
      tool: 'flywheel_grade_outcome',
      version: 1,
      status: 'ok',
      data: { kind, verdict },
      nextStep: makeNextToolStep(
        'present_choices',
        kind === 'grading_capped'
          ? 'Iteration cap reached — present Accept anyway / Abort menu (no Iterate).'
          : 'Branch on verdict.status — Iterate / Accept / Abort per Step 9.5.',
      ),
    };
    return makeToolResult(summary, structured);
  } catch (err) {
    if (err instanceof FlywheelError) {
      return makeFlywheelErrorResult('flywheel_grade_outcome' as never, ctx.state.phase, {
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        hint: err.hint,
        cause: err.cause,
        details: err.details,
      });
    }
    return makeFlywheelErrorResult('flywheel_grade_outcome' as never, ctx.state.phase, {
      code: 'internal_error',
      message: 'flywheel_grade_outcome threw',
      cause: errMsg(err),
    });
  }
}
