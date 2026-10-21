#!/usr/bin/env node

/**
 * Safe-lexical body rewrites for the AGY mirror (bead agent-flywheel-plugin-dm1).
 *
 * Reuses the OpenCode renderer's proven root-token and slash-prefix transforms
 * (imported, not copied) and adds the AGY harness-vocabulary rewrites. Every
 * rule is narrow: only tool-call syntax and backtick-quoted exact tool names
 * are rewritten, prose is left alone, and flywheel_get_skill MCP names are
 * byte-preserved.
 */

import {
  assertMcpNamesPreserved,
  replacePluginRootTokens,
  rewriteSlashPrefixes,
} from "../opencode/transforms.mjs";

function mcpNameCounts(content) {
  const counts = new Map();
  const re = /\bflywheel_(?:flywheel_)?get_skill\s*\(\s*\{[^}]*?\bname\s*:\s*(["'])([^"']+)\1/g;
  for (const match of content.matchAll(re)) {
    counts.set(match[2], (counts.get(match[2]) ?? 0) + 1);
  }
  return counts;
}

/**
 * Weaker invariant for the final pass: the Skill() -> flywheel_get_skill
 * translation may ADD MCP calls, so assert only that no pre-existing name
 * was lost or altered (every before-count is still present after).
 */
function assertMcpNamesNotLost(before, after, sourcePath) {
  const beforeCounts = mcpNameCounts(before);
  const afterCounts = mcpNameCounts(after);
  for (const [name, count] of beforeCounts) {
    if ((afterCounts.get(name) ?? 0) < count) {
      throw new Error(
        `postcondition failed for ${sourcePath}: flywheel_get_skill name ${JSON.stringify(name)} was lost or altered`,
      );
    }
  }
}

export const AGY_TOOL_NAMES = Object.freeze({
  AskUserQuestion: "ask_question",
  Agent: "invoke_subagent",
  Task: "invoke_subagent",
  Bash: "run_command",
  Read: "read_file",
  Edit: "edit_file",
  Write: "write_file",
});

const TOOL_CALL_RE = new RegExp(
  `\\b(${Object.keys(AGY_TOOL_NAMES).join("|")})\\s*\\(`,
  "g",
);
const BACKTICK_TOOL_RE = new RegExp(
  `\`(${Object.keys(AGY_TOOL_NAMES).join("|")})\``,
  "g",
);
const NAMESPACED_SKILL_RE =
  /\bSkill\s*\(\s*(?:(?:skill|skill_name)\s*:\s*)?(["'])agent-flywheel:([A-Za-z0-9][A-Za-z0-9_-]*)\1(?:\s*,\s*args\s*:\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^)\r\n]*))?\s*\)/g;

export const AGY_TRANSFORMS = Object.freeze([
  Object.freeze({
    id: "a-plugin-root",
    postconditions: Object.freeze(["no ${CLAUDE_PLUGIN_ROOT} token remains"]),
  }),
  Object.freeze({
    id: "a-slash-prefix",
    postconditions: Object.freeze([
      "no /agent-flywheel: reference remains with its namespace",
      "flywheel_get_skill agent-flywheel: names are byte-preserved",
    ]),
  }),
  Object.freeze({
    id: "a-tool-calls",
    postconditions: Object.freeze([
      "AskUserQuestion( / Agent( / Task( / Bash( / Read( / Edit( / Write( call syntax is translated",
      "backtick-quoted exact tool names are translated",
    ]),
  }),
  Object.freeze({
    id: "a-skill-invoke",
    postconditions: Object.freeze([
      "namespaced Skill(skill: \"agent-flywheel:X\") calls become flywheel_get_skill({ name: \"agent-flywheel:X\" })",
      "non-namespaced Skill(...) calls are left for the rules glossary",
    ]),
  }),
]);

function assertNoClaudeToolCalls(content, sourcePath) {
  TOOL_CALL_RE.lastIndex = 0;
  if (TOOL_CALL_RE.test(content)) {
    throw new Error(
      `a-tool-calls postcondition failed for ${sourcePath}: a Claude tool call spelling remains`,
    );
  }
  TOOL_CALL_RE.lastIndex = 0;
}

/** Rewrite AGY tool vocabulary in call syntax and backtick-quoted names. */
export function rewriteToolNames(content) {
  if (typeof content !== "string") {
    throw new TypeError("content must be a string");
  }
  TOOL_CALL_RE.lastIndex = 0;
  let rendered = content.replace(
    TOOL_CALL_RE,
    (match, name) => `${AGY_TOOL_NAMES[name]}(`,
  );
  BACKTICK_TOOL_RE.lastIndex = 0;
  rendered = rendered.replace(
    BACKTICK_TOOL_RE,
    (match, name) => `\`${AGY_TOOL_NAMES[name]}\``,
  );
  return rendered;
}

/** Translate namespaced Claude Skill calls to flywheel_get_skill MCP calls. */
export function rewriteSkillInvocations(content) {
  if (typeof content !== "string") {
    throw new TypeError("content must be a string");
  }
  NAMESPACED_SKILL_RE.lastIndex = 0;
  const rendered = content.replace(
    NAMESPACED_SKILL_RE,
    (_match, _quote, name) => `flywheel_get_skill({ name: "agent-flywheel:${name}" })`,
  );
  NAMESPACED_SKILL_RE.lastIndex = 0;
  return rendered;
}

/**
 * Apply the full AGY body profile to one markdown document.
 * Throws on any postcondition failure so a bad rewrite never ships quietly.
 */
export function rewriteBody(content, { repoRoot, sourcePath = "<memory>" } = {}) {
  if (typeof content !== "string") {
    throw new TypeError("content must be a string");
  }
  if (typeof repoRoot !== "string" || !repoRoot.startsWith("/")) {
    throw new Error(`repoRoot must be an absolute path (got ${JSON.stringify(repoRoot)})`);
  }
  let rendered = replacePluginRootTokens(content, repoRoot);
  rendered = rewriteSlashPrefixes(rendered, sourcePath);
  assertMcpNamesPreserved(content, rendered, sourcePath);
  rendered = rewriteSkillInvocations(rendered);
  rendered = rewriteToolNames(rendered);
  assertNoClaudeToolCalls(rendered, sourcePath);
  assertMcpNamesNotLost(content, rendered, sourcePath);
  return rendered;
}

/** Apply the command profile: rewrite the body, then rebuild frontmatter. */
export function rewriteCommand(content, { repoRoot, name, sourcePath = "<memory>" } = {}) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let body = content;
  let description = name;
  if (frontmatter) {
    body = content.slice(frontmatter[0].length);
    const descLine = frontmatter[1]
      .split(/\r?\n/)
      .find((line) => /^description\s*:/.test(line));
    if (descLine) {
      const value = descLine.replace(/^description\s*:\s*/, "").trim();
      if (value) description = value;
    }
  }
  const header = `---\nname: cmd-${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n`;
  return header + rewriteBody(body, { repoRoot, sourcePath });
}
