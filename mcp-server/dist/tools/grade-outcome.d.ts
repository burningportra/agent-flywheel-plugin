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
import type { McpToolResult, ToolContext } from '../types.js';
export declare const GradeOutcomeInputSchema: z.ZodObject<{
    cwd: z.ZodString;
    planSlug: z.ZodOptional<z.ZodString>;
    force: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type GradeOutcomeInput = z.infer<typeof GradeOutcomeInputSchema>;
export declare function runGradeOutcome(ctx: ToolContext, rawArgs: unknown): Promise<McpToolResult>;
//# sourceMappingURL=grade-outcome.d.ts.map