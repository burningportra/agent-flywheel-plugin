/**
 * flywheel_get_skill — MCP tool handler (T13).
 *
 * Returns a skill's frontmatter + body in one round-trip. Backed by the
 * bundle loader in `../skills-bundle.ts`, which transparently falls back
 * to disk reads on integrity failure or when `FW_SKILL_BUNDLE=off`.
 *
 * READ-ONLY: never mutates state or checkpoint.
 */
import { z } from "zod";
import type { McpToolResult, ToolContext } from "../types.js";
declare const GetSkillInputSchema: z.ZodObject<{
    cwd: z.ZodString;
    name: z.ZodString;
}, z.core.$strip>;
export type GetSkillArgs = z.infer<typeof GetSkillInputSchema>;
export declare function runGetSkill(ctx: ToolContext, args: unknown): Promise<McpToolResult>;
export {};
//# sourceMappingURL=get-skill.d.ts.map