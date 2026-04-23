/**
 * emit/codex — single-target Codex format emitter for agent-flywheel skills.
 *
 * Bead `agent-flywheel-plugin-zbx` (P1 codex-parity). Walks `skills/<name>/SKILL.md`,
 * reads the frontmatter + body, and writes:
 *
 *   <targetDir>/AGENTS.md               — index of all skills, one summary block each
 *   <targetDir>/.codex/skills/<name>.md — per-skill file, body preserved verbatim
 *
 * Scope is deliberately narrow:
 *   - Codex is the ONLY target. No multi-target registry, no adapter interface.
 *   - Skill source files are never modified; this is a read-and-emit pipeline.
 *   - Tool-list translation is a fixed map from Claude Code names to Codex-native
 *     equivalents; Claude-only tools are documented as "equivalent: X" so a
 *     Codex agent can still see what the original skill wanted to use.
 *
 * Ref: docs/research/compound-engineering-apply.md — Phase 7 "What NOT to copy"
 * stance is softened for this single target only.
 */
export interface ParsedSkill {
    /** Directory name (canonical identifier). */
    dirName: string;
    /** Frontmatter `name` field (should match dirName). */
    name: string;
    /** One-line description from frontmatter. */
    description: string;
    /** Optional allowed-tools array from frontmatter. */
    allowedTools: string[] | undefined;
    /** Optional argument-hint from frontmatter. */
    argumentHint: string | undefined;
    /** Body markdown, verbatim (no leading/trailing newline normalisation). */
    body: string;
    /** Original raw file contents — used for byte-stable round-trip assertions. */
    raw: string;
}
type ToolTranslation = {
    kind: "passthrough";
} | {
    kind: "equivalent";
    codex: string;
    note?: string;
} | {
    kind: "claude_only";
    note: string;
};
export interface TranslatedTool {
    /** Original Claude-side tool name. */
    original: string;
    /** Effective Codex name (may equal original for passthrough tools). */
    codex: string;
    /** Translation class. */
    kind: ToolTranslation["kind"];
    /** Optional human-readable note explaining the mapping. */
    note?: string;
}
/**
 * Translate a Claude-side allowed-tools entry into its Codex representation.
 * Unknown tool names pass through with a "equivalent" annotation — we prefer
 * surfacing unknown names over silently dropping them. Keeps emission
 * deterministic even as Claude's tool catalogue grows.
 */
export declare function translateTool(name: string): TranslatedTool;
/**
 * Parse a SKILL.md file. Accepts the raw string; returns the structured
 * ParsedSkill. Throws on malformed frontmatter so emission aborts loudly
 * rather than silently truncating a skill.
 */
export declare function parseSkill(dirName: string, raw: string): ParsedSkill;
/**
 * Render a per-skill Codex file. The format is:
 *
 *     # <name>
 *
 *     > <description>
 *
 *     ## Tools
 *     - <codex-name>  (from Claude '<original>' — <note>)
 *     ...
 *
 *     ## Body
 *     <markdown body, verbatim>
 *
 * The "## Body" fence keeps the Claude-side markdown isolated so the round-trip
 * test can extract it byte-stably without ambiguity.
 */
export declare function renderCodexSkillFile(skill: ParsedSkill): string;
/**
 * Render the top-level AGENTS.md index. One `## <name>` section per skill with
 * description, argument-hint (if any), translated tool list, and a pointer to
 * the per-skill file.
 */
export declare function renderAgentsIndex(skills: ParsedSkill[], opts?: {
    skillsSubdir?: string;
}): string;
export interface RoundTrippedSkill {
    name: string;
    description: string;
    allowedTools: string[] | undefined;
    argumentHint: string | undefined;
    body: string;
}
/**
 * Parse a Codex-emitted per-skill file back into its content fields. Used by
 * the drift test: the round-trip must be byte-stable on `name`, `description`,
 * `argumentHint`, `allowedTools` (original names, not translated), and `body`.
 */
export declare function parseCodexSkillFile(text: string): RoundTrippedSkill;
export interface EmitCodexOptions {
    /** Absolute path to the plugin root (contains `skills/`). */
    pluginRoot: string;
    /** Absolute path to the directory that will receive AGENTS.md + .codex/. */
    targetDir: string;
}
export interface EmitCodexReport {
    /** Absolute AGENTS.md path. */
    agentsPath: string;
    /** Absolute per-skill file paths written. */
    skillPaths: string[];
    /** Skill dir names skipped (no SKILL.md) or that errored. */
    skipped: Array<{
        dir: string;
        reason: string;
    }>;
}
/**
 * Walk `<pluginRoot>/skills/*`, parse each SKILL.md, and write AGENTS.md +
 * per-skill Codex files under `<targetDir>`.
 *
 * Caller is responsible for sanitising `targetDir` via `utils/path-safety`
 * *before* invoking — this function performs the actual filesystem writes and
 * trusts the path.
 */
export declare function emitCodex(opts: EmitCodexOptions): Promise<EmitCodexReport>;
export {};
//# sourceMappingURL=codex.d.ts.map