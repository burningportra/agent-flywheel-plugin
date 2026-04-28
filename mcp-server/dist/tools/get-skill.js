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
import { FlywheelError, classifyExecError, makeFlywheelErrorResult } from "../errors.js";
import { getSkill } from "../skills-bundle.js";
import { makeToolResult } from "./shared.js";
const GetSkillInputSchema = z.object({
    cwd: z.string(),
    name: z
        .string()
        .regex(/^[a-z0-9_-]+:[a-z0-9_-]+$/, "Use <plugin>:<skill-name> form"),
});
function renderSkillText(result) {
    const header = `# ${result.name}  [source: ${result.source}${result.staleWarn ? ", stale" : ""}]`;
    return `${header}\n\n${result.body}`;
}
export async function runGetSkill(ctx, args) {
    void ctx;
    const parsed = GetSkillInputSchema.safeParse(args);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return makeFlywheelErrorResult("flywheel_get_skill", "idle", {
            code: "invalid_input",
            message: `flywheel_get_skill: ${issue?.message ?? "invalid input"}`,
            retryable: false,
            hint: "Pass { cwd, name } where name matches /^[a-z0-9_-]+:[a-z0-9_-]+$/.",
            details: { field: issue?.path.join(".") },
        });
    }
    const { name } = parsed.data;
    try {
        const result = await getSkill(name, { repoRoot: ctx.cwd });
        const structured = {
            tool: "flywheel_get_skill",
            version: 1,
            status: "ok",
            phase: "idle",
            data: { kind: "skill", skill: result },
        };
        return makeToolResult(renderSkillText(result), structured);
    }
    catch (err) {
        if (err instanceof FlywheelError) {
            return makeFlywheelErrorResult("flywheel_get_skill", "idle", {
                code: err.code,
                message: err.message,
                retryable: err.retryable,
                hint: err.hint,
                cause: err.cause,
                details: err.details,
            });
        }
        const classified = classifyExecError(err);
        return makeFlywheelErrorResult("flywheel_get_skill", "idle", {
            code: classified.code,
            message: err instanceof Error ? err.message : String(err),
            retryable: classified.retryable,
            cause: classified.cause,
        });
    }
}
//# sourceMappingURL=get-skill.js.map