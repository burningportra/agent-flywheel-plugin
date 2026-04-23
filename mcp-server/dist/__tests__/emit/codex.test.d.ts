/**
 * emit/codex tests — bead `agent-flywheel-plugin-zbx`.
 *
 * Coverage:
 *   - Frontmatter parsing across the three SKILL.md shapes (no allowed-tools,
 *     block list, flow list).
 *   - Tool-translation policy (passthrough / equivalent / Claude-only).
 *   - Renderer output shape (heading, description quote, tools section).
 *   - Round-trip: SKILL.md → renderCodexSkillFile → parseCodexSkillFile must
 *     be byte-stable on `name`, `description`, `argumentHint`, `allowedTools`
 *     (original Claude names), and `body`.
 *   - End-to-end emitCodex against a tmp `skills/` tree.
 */
export {};
//# sourceMappingURL=codex.test.d.ts.map