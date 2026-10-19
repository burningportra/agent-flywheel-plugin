import { z } from 'zod';
import type { McpToolResult, ToolContext } from '../types.js';
export declare const PiModelsInputSchema: z.ZodObject<{
    cwd: z.ZodString;
    action: z.ZodDefault<z.ZodEnum<{
        list: "list";
        choose: "choose";
    }>>;
    roles: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        robustness: "robustness";
        ergonomics: "ergonomics";
        implementer: "implementer";
    }>>>;
    picks: z.ZodOptional<z.ZodRecord<z.ZodEnum<{
        robustness: "robustness";
        ergonomics: "ergonomics";
        implementer: "implementer";
    }> & z.core.$partial, z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>>;
    refresh: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
/**
 * `flywheel_pi_models` finds the models a Pi lane can run on the user's own
 * logins and on the Vercel AI Gateway, ranks them per role (frontier for the
 * deep-plan planners, balanced for implementers), and returns AskUserQuestion
 * payloads (`action: "list"`). `action: "choose"` validates and remembers the
 * answers.
 */
export declare function runPiModels(ctx: ToolContext, input: unknown): Promise<McpToolResult>;
//# sourceMappingURL=pi-models.d.ts.map