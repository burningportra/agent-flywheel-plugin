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
import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
const TOOL_TRANSLATIONS = {
    // Runtime primitives — identical surface in Codex.
    Bash: { kind: "passthrough" },
    Read: { kind: "passthrough" },
    Edit: { kind: "passthrough" },
    Write: { kind: "passthrough" },
    Grep: { kind: "passthrough" },
    Glob: { kind: "passthrough" },
    // Claude-only meta tools — documented as equivalents where Codex has them,
    // annotated otherwise so a Codex agent reading the emitted skill can still
    // follow the original intent.
    Skill: {
        kind: "equivalent",
        codex: "codex-skill-invoke",
        note: "Claude 'Skill' tool — invoke another skill by name.",
    },
    Task: {
        kind: "equivalent",
        codex: "codex-subagent",
        note: "Claude 'Task' tool — spawn a sub-agent for a scoped job.",
    },
    AskUserQuestion: {
        kind: "equivalent",
        codex: "codex-ask-user",
        note: "Claude 'AskUserQuestion' — structured user prompt with options.",
    },
    TodoWrite: {
        kind: "claude_only",
        note: "Claude-only todo tracker — Codex agents should track todos inline.",
    },
    WebFetch: {
        kind: "equivalent",
        codex: "codex-fetch",
        note: "Claude 'WebFetch' — URL retrieval.",
    },
    WebSearch: {
        kind: "equivalent",
        codex: "codex-search",
        note: "Claude 'WebSearch' — web query.",
    },
    NotebookEdit: {
        kind: "claude_only",
        note: "Claude-only Jupyter editor — no Codex equivalent.",
    },
};
/**
 * Translate a Claude-side allowed-tools entry into its Codex representation.
 * Unknown tool names pass through with a "equivalent" annotation — we prefer
 * surfacing unknown names over silently dropping them. Keeps emission
 * deterministic even as Claude's tool catalogue grows.
 */
export function translateTool(name) {
    const entry = TOOL_TRANSLATIONS[name];
    if (!entry) {
        return {
            original: name,
            codex: name,
            kind: "equivalent",
            note: `Unknown tool '${name}' — passed through verbatim; Codex runtime may not recognise it.`,
        };
    }
    switch (entry.kind) {
        case "passthrough":
            return { original: name, codex: name, kind: "passthrough" };
        case "equivalent":
            return {
                original: name,
                codex: entry.codex,
                kind: "equivalent",
                note: entry.note,
            };
        case "claude_only":
            return {
                original: name,
                codex: name,
                kind: "claude_only",
                note: entry.note,
            };
    }
}
// ─── Frontmatter parser ─────────────────────────────────────────
//
// Intentionally hand-rolled rather than pulling `gray-matter`: SKILL.md
// frontmatter is a small fixed subset (name, description, allowed-tools,
// argument-hint) and the round-trip test needs to match the hand-emitted
// shape byte-for-byte. Using a 3rd-party lib would drag in quoting rules we
// don't control.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
/**
 * Parse a SKILL.md file. Accepts the raw string; returns the structured
 * ParsedSkill. Throws on malformed frontmatter so emission aborts loudly
 * rather than silently truncating a skill.
 */
export function parseSkill(dirName, raw) {
    const match = FRONTMATTER_RE.exec(raw);
    if (!match) {
        throw new Error(`[emit/codex] ${dirName}/SKILL.md has no YAML frontmatter block.`);
    }
    const [, frontmatter, body] = match;
    const fm = parseFrontmatter(frontmatter);
    const name = fm.name;
    const description = fm.description;
    if (!name) {
        throw new Error(`[emit/codex] ${dirName}/SKILL.md frontmatter missing required 'name'.`);
    }
    if (!description) {
        throw new Error(`[emit/codex] ${dirName}/SKILL.md frontmatter missing required 'description'.`);
    }
    return {
        dirName,
        name,
        description,
        allowedTools: fm.allowedTools,
        argumentHint: fm.argumentHint,
        body,
        raw,
    };
}
function parseFrontmatter(text) {
    const out = {};
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.trim().startsWith("#"))
            continue;
        const keyMatch = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
        if (!keyMatch)
            continue;
        const key = keyMatch[1];
        const inline = keyMatch[2].trim();
        if (key === "name") {
            out.name = unquote(inline);
        }
        else if (key === "description") {
            out.description = unquote(inline);
        }
        else if (key === "argument-hint") {
            out.argumentHint = unquote(inline);
        }
        else if (key === "allowed-tools") {
            if (inline && !inline.startsWith("[")) {
                // inline single-value form: "allowed-tools: Bash"
                out.allowedTools = [unquote(inline)];
            }
            else if (inline.startsWith("[")) {
                // flow form: "allowed-tools: [Bash, Read]"
                out.allowedTools = parseFlowList(inline);
            }
            else {
                // block form — consume following `  - X` lines
                const items = [];
                while (i + 1 < lines.length) {
                    const next = lines[i + 1];
                    const m = /^\s+-\s*(.+)$/.exec(next);
                    if (!m)
                        break;
                    items.push(unquote(m[1].trim()));
                    i++;
                }
                out.allowedTools = items;
            }
        }
    }
    return out;
}
function unquote(s) {
    const trimmed = s.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
function parseFlowList(inline) {
    const inner = inline.replace(/^\[/, "").replace(/\]$/, "");
    return inner
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
}
// ─── Renderers ──────────────────────────────────────────────────
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
export function renderCodexSkillFile(skill) {
    const lines = [];
    lines.push(`# ${skill.name}`);
    lines.push("");
    lines.push(`> ${skill.description}`);
    lines.push("");
    if (skill.argumentHint) {
        lines.push(`**Argument hint:** \`${skill.argumentHint}\``);
        lines.push("");
    }
    if (skill.allowedTools && skill.allowedTools.length > 0) {
        lines.push("## Tools");
        lines.push("");
        for (const t of skill.allowedTools) {
            const tr = translateTool(t);
            const note = tr.note ? `  — ${tr.note}` : "";
            if (tr.kind === "passthrough") {
                lines.push(`- \`${tr.codex}\``);
            }
            else if (tr.kind === "equivalent") {
                lines.push(`- \`${tr.codex}\`  (equivalent: Claude \`${tr.original}\`${note})`);
            }
            else {
                lines.push(`- \`${tr.original}\`  (Claude-only${note})`);
            }
        }
        lines.push("");
    }
    lines.push("## Body");
    lines.push("");
    // Preserve body verbatim. Trim exactly one leading newline if present so
    // "## Body\n\n<body>" doesn't produce three blank lines from SKILL.md's
    // usual trailing-then-leading newline.
    const body = skill.body.replace(/^\r?\n/, "");
    lines.push(body);
    // Ensure trailing newline for POSIX-friendly files.
    const out = lines.join("\n");
    return out.endsWith("\n") ? out : out + "\n";
}
/**
 * Render the top-level AGENTS.md index. One `## <name>` section per skill with
 * description, argument-hint (if any), translated tool list, and a pointer to
 * the per-skill file.
 */
export function renderAgentsIndex(skills, opts = {}) {
    const subdir = opts.skillsSubdir ?? ".codex/skills";
    const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
    const lines = [];
    lines.push("# AGENTS.md");
    lines.push("");
    lines.push("Skills emitted from agent-flywheel (Claude Code source-of-truth).");
    lines.push("Each section below summarises one skill; full bodies live under `" +
        subdir +
        "/`.");
    lines.push("");
    for (const s of sorted) {
        lines.push(`## ${s.name}`);
        lines.push("");
        lines.push(`${s.description}`);
        lines.push("");
        if (s.argumentHint) {
            lines.push(`- Argument hint: \`${s.argumentHint}\``);
        }
        if (s.allowedTools && s.allowedTools.length > 0) {
            const translated = s.allowedTools.map((t) => {
                const tr = translateTool(t);
                if (tr.kind === "passthrough")
                    return `\`${tr.codex}\``;
                if (tr.kind === "equivalent")
                    return `\`${tr.codex}\` (eq. Claude \`${tr.original}\`)`;
                return `\`${tr.original}\` (Claude-only)`;
            });
            lines.push(`- Tools: ${translated.join(", ")}`);
        }
        lines.push(`- File: [\`${subdir}/${s.dirName}.md\`](${subdir}/${s.dirName}.md)`);
        lines.push("");
    }
    const out = lines.join("\n");
    return out.endsWith("\n") ? out : out + "\n";
}
/**
 * Parse a Codex-emitted per-skill file back into its content fields. Used by
 * the drift test: the round-trip must be byte-stable on `name`, `description`,
 * `argumentHint`, `allowedTools` (original names, not translated), and `body`.
 */
export function parseCodexSkillFile(text) {
    const lines = text.split(/\r?\n/);
    let i = 0;
    // Heading: "# <name>"
    while (i < lines.length && lines[i].trim() === "")
        i++;
    const headingMatch = /^#\s+(.+)$/.exec(lines[i] ?? "");
    if (!headingMatch) {
        throw new Error("[emit/codex] Round-trip parser: missing '# <name>' heading.");
    }
    const name = headingMatch[1].trim();
    i++;
    // Description: "> <desc>" (may be preceded by blank line)
    while (i < lines.length && lines[i].trim() === "")
        i++;
    const descMatch = /^>\s+(.+)$/.exec(lines[i] ?? "");
    if (!descMatch) {
        throw new Error("[emit/codex] Round-trip parser: missing '> <description>' line.");
    }
    const description = descMatch[1].trim();
    i++;
    let argumentHint;
    let allowedTools;
    // Optional argument hint line.
    while (i < lines.length && lines[i].trim() === "")
        i++;
    const hintMatch = /^\*\*Argument hint:\*\*\s+`([^`]+)`\s*$/.exec(lines[i] ?? "");
    if (hintMatch) {
        argumentHint = hintMatch[1];
        i++;
    }
    // Optional "## Tools" section.
    while (i < lines.length && lines[i].trim() === "")
        i++;
    if (lines[i]?.trim() === "## Tools") {
        i++;
        const tools = [];
        while (i < lines.length && lines[i].trim() !== "## Body") {
            const line = lines[i];
            // Match "- `name`" (passthrough),
            //       "- `codex` (equivalent: Claude `original` ...)",
            //       "- `original` (Claude-only ...)"
            const equivMatch = /^-\s+`[^`]+`\s+\(equivalent:\s+Claude\s+`([^`]+)`/.exec(line);
            const claudeOnlyMatch = /^-\s+`([^`]+)`\s+\(Claude-only/.exec(line);
            const passthroughMatch = /^-\s+`([^`]+)`\s*$/.exec(line);
            if (equivMatch) {
                tools.push(equivMatch[1]);
            }
            else if (claudeOnlyMatch) {
                tools.push(claudeOnlyMatch[1]);
            }
            else if (passthroughMatch) {
                tools.push(passthroughMatch[1]);
            }
            i++;
        }
        allowedTools = tools;
    }
    // "## Body" section — everything after this heading, stripped of the single
    // leading blank line emitted by the renderer.
    while (i < lines.length && lines[i].trim() !== "## Body")
        i++;
    if (i >= lines.length) {
        throw new Error("[emit/codex] Round-trip parser: missing '## Body' section.");
    }
    i++; // skip "## Body"
    // Drop exactly one leading blank line that the renderer inserts.
    if (i < lines.length && lines[i] === "")
        i++;
    const bodyLines = lines.slice(i);
    // Drop at most one trailing blank introduced by renderer's forced newline.
    let body = bodyLines.join("\n");
    if (body.endsWith("\n"))
        body = body.slice(0, -1);
    return { name, description, allowedTools, argumentHint, body };
}
/**
 * Walk `<pluginRoot>/skills/*`, parse each SKILL.md, and write AGENTS.md +
 * per-skill Codex files under `<targetDir>`.
 *
 * Caller is responsible for sanitising `targetDir` via `utils/path-safety`
 * *before* invoking — this function performs the actual filesystem writes and
 * trusts the path.
 */
export async function emitCodex(opts) {
    const { pluginRoot, targetDir } = opts;
    const skillsRoot = join(pluginRoot, "skills");
    const report = {
        agentsPath: join(targetDir, "AGENTS.md"),
        skillPaths: [],
        skipped: [],
    };
    let entries;
    try {
        entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    }
    catch (err) {
        throw new Error(`[emit/codex] Cannot read skills root '${skillsRoot}': ${err.message}`);
    }
    const parsed = [];
    for (const ent of entries) {
        if (!ent.isDirectory())
            continue;
        if (ent.name.startsWith("_"))
            continue; // skip _template, etc.
        const skillPath = join(skillsRoot, ent.name, "SKILL.md");
        let raw;
        try {
            raw = await fs.readFile(skillPath, "utf8");
        }
        catch {
            report.skipped.push({
                dir: ent.name,
                reason: "no SKILL.md",
            });
            continue;
        }
        try {
            parsed.push(parseSkill(ent.name, raw));
        }
        catch (err) {
            report.skipped.push({
                dir: ent.name,
                reason: err.message,
            });
        }
    }
    // Create output directories.
    const codexSkillsDir = join(targetDir, ".codex", "skills");
    await fs.mkdir(codexSkillsDir, { recursive: true });
    // Write per-skill files.
    for (const s of parsed) {
        const outPath = join(codexSkillsDir, `${s.dirName}.md`);
        await fs.writeFile(outPath, renderCodexSkillFile(s), "utf8");
        report.skillPaths.push(outPath);
    }
    // Write AGENTS.md index.
    const index = renderAgentsIndex(parsed, {
        skillsSubdir: relative(targetDir, codexSkillsDir),
    });
    await fs.writeFile(report.agentsPath, index, "utf8");
    return report;
}
//# sourceMappingURL=codex.js.map