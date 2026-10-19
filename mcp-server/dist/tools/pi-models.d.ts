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
    }> & z.core.$partial, z.ZodString>>;
    refresh: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
/**
 * `flywheel_pi_models` ranks the Vercel AI Gateway models a Pi lane can run
 * and returns AskUserQuestion payloads (`action: "list"`), then validates and
 * remembers the user's answers (`action: "choose"`).
 */
export declare function runPiModels(ctx: ToolContext, input: unknown): Promise<McpToolResult>;
//# sourceMappingURL=pi-models.d.ts.map