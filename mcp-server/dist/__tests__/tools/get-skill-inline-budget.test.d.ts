/**
 * Size guard for the `flywheel_get_skill({ name: "agent-flywheel:start" })`
 * result (bead agent-flywheel-plugin-8fg).
 *
 * Claude Code shows the model a tool result inline only while its text stays
 * under a persist threshold. Above it, Claude Code saves the result to a file,
 * prints "Output too large (<size>)", and hands the model a preview, so the
 * start screen spends 3 to 4 extra turns reading the skill back with Bash and
 * Read. Measured on 2026-10-19 (bead agent-flywheel-plugin-d7o): 45.7 KB of
 * structured JSON arrived inline at v3.24.0, and 55.7 KB was persisted, which
 * moved the median start from 34.6 s to 45.2 s and from 4 to 6 turns.
 *
 * The exact threshold, read from the Claude Code 2.1.307 binary: a result is
 * persisted when its text length exceeds `min(tool.maxResultSizeChars, 50000)`,
 * and MCP tools set `maxResultSizeChars: 1e5`, so the limit is 50,000
 * characters (JavaScript string length, not bytes). The GrowthBook flag
 * `tengu_velvet_ibis` can override it per tool.
 *
 * The budget is 48,000 characters: 2,000 below that limit, which covers the
 * `source`/`staleWarn`/`pluginVersion` fields varying between installs and
 * any small wrapper Claude Code adds, while leaving the start skill room to
 * grow. `prompt-budget` caps each change at 10% growth; this catches growth
 * that builds up over many changes.
 */
export {};
//# sourceMappingURL=get-skill-inline-budget.test.d.ts.map