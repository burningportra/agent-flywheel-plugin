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
import type { McpToolResult, ToolContext } from '../types.js';
export declare const SynthesizeRubricInputSchema: z.ZodObject<{
    cwd: z.ZodString;
    planSlug: z.ZodOptional<z.ZodString>;
    planPath: z.ZodOptional<z.ZodString>;
    action: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        synthesize: "synthesize";
        validate: "validate";
        edit: "edit";
        regenerate: "regenerate";
    }>>>;
    editIntent: z.ZodOptional<z.ZodObject<{
        kind: z.ZodEnum<{
            custom: "custom";
            tighten: "tighten";
            add: "add";
            remove: "remove";
        }>;
        text: z.ZodString;
    }, z.core.$strip>>;
    force: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type SynthesizeRubricInput = z.infer<typeof SynthesizeRubricInputSchema>;
export declare function runSynthesizeRubric(ctx: ToolContext, rawArgs: unknown): Promise<McpToolResult>;
//# sourceMappingURL=synthesize-rubric.d.ts.map