/**
 * Deterministic, safe-lexical transforms used by the OpenCode renderer.
 *
 * Every transform is intentionally narrow. They translate only syntax with an
 * unambiguous Claude-plugin meaning and leave semantic compatibility work to
 * the stale-reference pass owned by a later bead.
 */

const ROOT_TOKEN_RE = /\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g;
const SLASH_PREFIX_RE = /\/agent-flywheel:([A-Za-z0-9][A-Za-z0-9_-]*)/g;
const MCP_NAME_CALL_RE =
  /\bflywheel_(?:flywheel_)?get_skill\s*\(\s*\{[^}]*?\bname\s*:\s*(["'])([^"']+)\1/g;
const NAMESPACED_SKILL_RE =
  /\bSkill\s*\(\s*(?:(?:skill|skill_name)\s*:\s*)?(["'])agent-flywheel:([A-Za-z0-9][A-Za-z0-9_-]*)\1(?:\s*,\s*args\s*:\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^)\r\n]*))?\s*\)/g;

export const TRANSFORMS = Object.freeze([
  Object.freeze({
    id: "t-plugin-root",
    scope: "skills/** and commands/*.md",
    preconditions: Object.freeze(["input is UTF-8 text", "repoRoot is an absolute path"]),
    postconditions: Object.freeze(["no CLAUDE_PLUGIN_ROOT token remains"]),
  }),
  Object.freeze({
    id: "t-slash-prefix",
    scope: "skills/** and commands/*.md",
    preconditions: Object.freeze(["only references with a leading slash are eligible"]),
    postconditions: Object.freeze([
      "no /agent-flywheel: reference remains",
      "flywheel_get_skill agent-flywheel: names are byte-preserved",
    ]),
  }),
  Object.freeze({
    id: "t-skill-invoke",
    scope: "skills/** and commands/*.md",
    preconditions: Object.freeze(["only namespaced Claude Skill calls are eligible"]),
    postconditions: Object.freeze(["eligible calls use OpenCode skill(name: \"X\") syntax"]),
  }),
  Object.freeze({
    id: "t-frontmatter",
    scope: "commands/*.md frontmatter",
    preconditions: Object.freeze(["argument-hint is removed only from leading YAML frontmatter"]),
    postconditions: Object.freeze(["frontmatter contains no argument-hint key"]),
  }),
  Object.freeze({
    id: "t-plugin-root-template",
    scope: "plugins/agent-flywheel.js",
    preconditions: Object.freeze([
      "template contains the typed root sentinel or a legacy FLYWHEEL_ROOT assignment",
    ]),
    postconditions: Object.freeze([
      "root is emitted as a JSON string literal",
      "no root sentinel or legacy root assignment remains",
    ]),
  }),
  Object.freeze({
    id: "t-mcp-command",
    scope: ".claude-plugin/plugin.json mcpServers.agent-flywheel",
    preconditions: Object.freeze(["server command is a string", "server args is a string array"]),
    postconditions: Object.freeze([
      "OpenCode command is an argv array",
      "no CLAUDE_PLUGIN_ROOT token remains",
    ]),
  }),
]);

function requireText(value, label) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
}

function requireAbsoluteRoot(repoRoot) {
  requireText(repoRoot, "repoRoot");
  if (!repoRoot.startsWith("/")) {
    throw new Error(`repoRoot must be absolute (got ${JSON.stringify(repoRoot)})`);
  }
}

function replaceRootTokensRaw(content, repoRoot) {
  ROOT_TOKEN_RE.lastIndex = 0;
  return content.replace(ROOT_TOKEN_RE, () => repoRoot);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function escapeInsideDoubleQuotes(value) {
  return value.replace(/[\\"$`]/g, "\\$&");
}

function escapeInsideSingleQuotes(value) {
  return value.replaceAll("'", `'"'"'`);
}

function mcpNames(content) {
  MCP_NAME_CALL_RE.lastIndex = 0;
  return [...content.matchAll(MCP_NAME_CALL_RE)].map((match) => match[2]);
}

/** Assert that a transform did not alter any flywheel_get_skill name value. */
export function assertMcpNamesPreserved(before, after, sourcePath = "<memory>") {
  requireText(before, "before");
  requireText(after, "after");
  const expected = mcpNames(before);
  const actual = mcpNames(after);
  const invalid = expected.find((name) => !name.startsWith("agent-flywheel:"));
  if (invalid) {
    throw new Error(
      `t-slash-prefix precondition failed for ${sourcePath}: flywheel_get_skill name ${JSON.stringify(invalid)} is not namespaced`,
    );
  }
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    throw new Error(
      `t-slash-prefix postcondition failed for ${sourcePath}: flywheel_get_skill names changed ` +
        `from ${JSON.stringify(expected)} to ${JSON.stringify(actual)}`,
    );
  }
  for (const name of expected) {
    if (name.startsWith("agent-flywheel:") && !actual.includes(name)) {
      throw new Error(
        `t-slash-prefix postcondition failed for ${sourcePath}: ${JSON.stringify(name)} was not preserved`,
      );
    }
  }
}

/** Replace braced and unbraced Claude plugin-root tokens with the render root. */
export function replacePluginRootTokens(content, repoRoot) {
  requireText(content, "content");
  requireAbsoluteRoot(repoRoot);
  ROOT_TOKEN_RE.lastIndex = 0;
  const rendered = content.replace(ROOT_TOKEN_RE, (_match, offset) => {
    const previous = content[offset - 1];
    if (previous === '"') return escapeInsideDoubleQuotes(repoRoot);
    if (previous === "'") return escapeInsideSingleQuotes(repoRoot);
    return shellQuote(repoRoot);
  });
  ROOT_TOKEN_RE.lastIndex = 0;
  if (ROOT_TOKEN_RE.test(rendered)) {
    throw new Error("t-plugin-root postcondition failed: root token remains");
  }
  return rendered;
}

/** Rewrite only namespaced slash-command references carrying a leading slash. */
export function rewriteSlashPrefixes(content, sourcePath = "<memory>") {
  requireText(content, "content");
  const before = content;
  SLASH_PREFIX_RE.lastIndex = 0;
  const after = content.replace(SLASH_PREFIX_RE, (_match, name) => `/${name}`);
  SLASH_PREFIX_RE.lastIndex = 0;
  if (SLASH_PREFIX_RE.test(after)) {
    throw new Error(`t-slash-prefix postcondition failed for ${sourcePath}: namespace remains`);
  }
  assertMcpNamesPreserved(before, after, sourcePath);
  return after;
}

/** Translate the three supported namespaced Claude Skill call spellings. */
export function rewriteSkillInvocations(content) {
  requireText(content, "content");
  NAMESPACED_SKILL_RE.lastIndex = 0;
  const rendered = content.replace(
    NAMESPACED_SKILL_RE,
    (_match, _quote, name) => `skill(name: "${name}")`,
  );
  NAMESPACED_SKILL_RE.lastIndex = 0;
  if (NAMESPACED_SKILL_RE.test(rendered)) {
    throw new Error("t-skill-invoke postcondition failed: namespaced Claude Skill call remains");
  }
  return rendered;
}

/** Remove argument-hint only from the document's leading YAML frontmatter. */
export function dropArgumentHintFromFrontmatter(content) {
  requireText(content, "content");
  const frontmatter = content.match(/^(---)(\r?\n)([\s\S]*?)(\r?\n---)(?=\r?\n|$)/);
  if (!frontmatter) return content;

  const newline = frontmatter[2];
  const filtered = frontmatter[3]
    .split(/\r?\n/)
    .filter((line) => !/^argument-hint\s*:/.test(line));
  const renderedHeader = `${frontmatter[1]}${newline}${filtered.join(newline)}${frontmatter[4]}`;
  const rendered = renderedHeader + content.slice(frontmatter[0].length);
  const renderedFrontmatter = rendered.match(/^(---)(\r?\n)([\s\S]*?)(\r?\n---)(?=\r?\n|$)/);
  if (renderedFrontmatter?.[3].split(/\r?\n/).some((line) => /^argument-hint\s*:/.test(line))) {
    throw new Error("t-frontmatter postcondition failed: argument-hint remains");
  }
  return rendered;
}

/**
 * Replace the executable plugin-root sentinel with a typed JSON literal.
 * A legacy checked-in template is accepted only when it exposes the root via
 * a FLYWHEEL_ROOT/FLYWHEEL_REPO_ROOT const assignment; arbitrary path-shaped
 * strings are never guessed or rewritten.
 */
export function renderPluginRootTemplate(content, repoRoot) {
  requireText(content, "content");
  requireAbsoluteRoot(repoRoot);
  const literal = JSON.stringify(repoRoot);
  const sentinelRe = /\/\*__FLYWHEEL_REPO_ROOT__\*\/\s*(?:""|'')/g;
  const legacyRe =
    /(\bconst\s+FLYWHEEL_(?:REPO_)?ROOT\s*=\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/;

  let replacements = 0;
  let rendered = content.replace(sentinelRe, () => {
    replacements += 1;
    return literal;
  });
  if (replacements === 0 && legacyRe.test(rendered)) {
    rendered = rendered.replace(legacyRe, (_match, prefix) => `${prefix}${literal}`);
    replacements = 1;
  }
  if (replacements !== 1) {
    throw new Error(
      `t-plugin-root-template precondition failed: expected exactly one executable root marker, found ${replacements}`,
    );
  }
  if (/__FLYWHEEL_REPO_ROOT__/.test(rendered)) {
    throw new Error("t-plugin-root-template postcondition failed: root sentinel remains");
  }
  const assignmentRe = /\bconst\s+FLYWHEEL_(?:REPO_)?ROOT\s*=\s*([^\r\n;]+)/;
  const assignment = rendered.match(assignmentRe);
  if (assignment && assignment[1].trim() !== literal) {
    throw new Error("t-plugin-root-template postcondition failed: root assignment is not the typed literal");
  }
  return rendered;
}

/** Derive OpenCode's local MCP entry from the Claude plugin manifest. */
export function deriveMcpEntry(pluginManifest, repoRoot) {
  requireAbsoluteRoot(repoRoot);
  const serverName = pluginManifest?.name;
  if (typeof serverName !== "string" || serverName.length === 0) {
    throw new Error("t-mcp-command precondition failed: plugin manifest name is missing");
  }
  const server = pluginManifest?.mcpServers?.[serverName];
  if (!server || typeof server !== "object") {
    throw new Error(`t-mcp-command precondition failed: mcpServers.${serverName} is missing`);
  }
  if (typeof server.command !== "string" || !Array.isArray(server.args)) {
    throw new Error("t-mcp-command precondition failed: command must be a string and args must be an array");
  }
  if (server.args.some((arg) => typeof arg !== "string")) {
    throw new Error("t-mcp-command precondition failed: every server arg must be a string");
  }
  const command = [server.command, ...server.args].map((part) =>
    replaceRootTokensRaw(part, repoRoot),
  );
  if (command.some((part) => /\$\{?CLAUDE_PLUGIN_ROOT\}?/.test(part))) {
    throw new Error("t-mcp-command postcondition failed: CLAUDE_PLUGIN_ROOT remains");
  }
  return { type: "local", command, enabled: true };
}

/** Apply the manifest-selected transform profile to one UTF-8 artifact. */
export function applyTransformProfile(content, options) {
  const { profile, repoRoot, sourcePath = "<memory>" } = options ?? {};
  requireText(content, "content");
  if (profile === "command-override") {
    assertMcpNamesPreserved(content, content, sourcePath);
    return content;
  }
  if (profile === "plugin") return renderPluginRootTemplate(content, repoRoot);
  if (profile !== "skill" && profile !== "command") {
    throw new Error(`unknown transform profile ${JSON.stringify(profile)} for ${sourcePath}`);
  }

  const before = content;
  let rendered = replacePluginRootTokens(content, repoRoot);
  rendered = rewriteSlashPrefixes(rendered, sourcePath);
  rendered = rewriteSkillInvocations(rendered);
  if (profile === "command") rendered = dropArgumentHintFromFrontmatter(rendered);

  if (/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/.test(rendered)) {
    throw new Error(`t-plugin-root postcondition failed for ${sourcePath}: root token remains`);
  }
  assertMcpNamesPreserved(before, rendered, sourcePath);
  return rendered;
}
