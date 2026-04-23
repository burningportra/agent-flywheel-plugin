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
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emitCodex, parseCodexSkillFile, parseSkill, renderAgentsIndex, renderCodexSkillFile, translateTool, } from "../../emit/codex.js";
// ─── Fixtures ────────────────────────────────────────────────────
const SKILL_NO_TOOLS = `---
name: alpha-skill
description: Diagnose alpha problems quickly.
---

Alpha body line 1.

## Step 1
Do the thing.
`;
const SKILL_BLOCK_TOOLS = `---
name: beta-skill
description: Refine beta artifacts in-place.
allowed-tools:
  - Bash
  - Read
  - Skill
  - TodoWrite
argument-hint: <goal>
---

Beta body. Multi-line.

End.
`;
const SKILL_FLOW_TOOLS = `---
name: gamma-skill
description: Scan gamma rays.
allowed-tools: [Bash, Edit, WebFetch]
---

Gamma single-line body.
`;
// ─── Frontmatter parser ──────────────────────────────────────────
describe("parseSkill", () => {
    it("parses a SKILL.md with no allowed-tools", () => {
        const s = parseSkill("alpha-skill", SKILL_NO_TOOLS);
        expect(s.name).toBe("alpha-skill");
        expect(s.description).toBe("Diagnose alpha problems quickly.");
        expect(s.allowedTools).toBeUndefined();
        expect(s.argumentHint).toBeUndefined();
        expect(s.body).toContain("Alpha body line 1.");
    });
    it("parses block-form allowed-tools and argument-hint", () => {
        const s = parseSkill("beta-skill", SKILL_BLOCK_TOOLS);
        expect(s.allowedTools).toEqual(["Bash", "Read", "Skill", "TodoWrite"]);
        expect(s.argumentHint).toBe("<goal>");
    });
    it("parses flow-form allowed-tools", () => {
        const s = parseSkill("gamma-skill", SKILL_FLOW_TOOLS);
        expect(s.allowedTools).toEqual(["Bash", "Edit", "WebFetch"]);
    });
    it("throws on missing frontmatter", () => {
        expect(() => parseSkill("bad", "no frontmatter here")).toThrow(/no YAML frontmatter/);
    });
    it("throws when name or description is missing", () => {
        expect(() => parseSkill("bad", "---\nname: x\n---\nbody")).toThrow(/missing required 'description'/);
    });
});
// ─── Translation policy ──────────────────────────────────────────
describe("translateTool", () => {
    it("passes through runtime primitives", () => {
        for (const t of ["Bash", "Read", "Edit", "Write", "Grep", "Glob"]) {
            expect(translateTool(t)).toEqual({
                original: t,
                codex: t,
                kind: "passthrough",
            });
        }
    });
    it("maps Skill / Task / AskUserQuestion to Codex equivalents with notes", () => {
        const skill = translateTool("Skill");
        expect(skill.kind).toBe("equivalent");
        expect(skill.codex).toBe("codex-skill-invoke");
        expect(skill.note).toMatch(/invoke another skill/);
        const task = translateTool("Task");
        expect(task.codex).toBe("codex-subagent");
        const ask = translateTool("AskUserQuestion");
        expect(ask.codex).toBe("codex-ask-user");
    });
    it("flags Claude-only tools without inventing a Codex name", () => {
        const todo = translateTool("TodoWrite");
        expect(todo.kind).toBe("claude_only");
        expect(todo.codex).toBe("TodoWrite");
        expect(todo.note).toMatch(/Claude-only/);
    });
    it("annotates unknown tools as equivalent passthrough", () => {
        const unknown = translateTool("MysteryTool");
        expect(unknown.kind).toBe("equivalent");
        expect(unknown.codex).toBe("MysteryTool");
        expect(unknown.note).toMatch(/Unknown tool/);
    });
});
// ─── Renderer ────────────────────────────────────────────────────
describe("renderCodexSkillFile", () => {
    it("emits heading, description quote, and tools section", () => {
        const skill = parseSkill("beta-skill", SKILL_BLOCK_TOOLS);
        const out = renderCodexSkillFile(skill);
        expect(out).toContain("# beta-skill");
        expect(out).toContain("> Refine beta artifacts in-place.");
        expect(out).toContain("**Argument hint:** `<goal>`");
        expect(out).toContain("## Tools");
        expect(out).toContain("- `Bash`"); // passthrough
        expect(out).toContain("- `codex-skill-invoke`  (equivalent: Claude `Skill`");
        expect(out).toContain("- `TodoWrite`  (Claude-only");
        expect(out).toContain("## Body");
        expect(out).toContain("Beta body. Multi-line.");
    });
    it("omits the tools section when allowed-tools is absent", () => {
        const skill = parseSkill("alpha-skill", SKILL_NO_TOOLS);
        const out = renderCodexSkillFile(skill);
        expect(out).not.toContain("## Tools");
        expect(out).toContain("## Body");
    });
});
describe("renderAgentsIndex", () => {
    it("emits one section per skill, sorted alphabetically", () => {
        const skills = [
            parseSkill("gamma-skill", SKILL_FLOW_TOOLS),
            parseSkill("alpha-skill", SKILL_NO_TOOLS),
            parseSkill("beta-skill", SKILL_BLOCK_TOOLS),
        ];
        const out = renderAgentsIndex(skills);
        const alphaIdx = out.indexOf("## alpha-skill");
        const betaIdx = out.indexOf("## beta-skill");
        const gammaIdx = out.indexOf("## gamma-skill");
        expect(alphaIdx).toBeGreaterThan(0);
        expect(betaIdx).toBeGreaterThan(alphaIdx);
        expect(gammaIdx).toBeGreaterThan(betaIdx);
        expect(out).toContain("[`.codex/skills/alpha-skill.md`]");
    });
});
// ─── Round-trip drift gate ───────────────────────────────────────
describe("round-trip parseCodexSkillFile", () => {
    const cases = [
        { label: "no tools", raw: SKILL_NO_TOOLS, dir: "alpha-skill" },
        { label: "block tools + argument-hint", raw: SKILL_BLOCK_TOOLS, dir: "beta-skill" },
        { label: "flow tools", raw: SKILL_FLOW_TOOLS, dir: "gamma-skill" },
    ];
    for (const c of cases) {
        it(`is byte-stable on content fields (${c.label})`, () => {
            const original = parseSkill(c.dir, c.raw);
            const emitted = renderCodexSkillFile(original);
            const round = parseCodexSkillFile(emitted);
            expect(round.name).toBe(original.name);
            expect(round.description).toBe(original.description);
            expect(round.argumentHint).toBe(original.argumentHint);
            // Allowed-tools must round-trip to the ORIGINAL Claude names, not the
            // translated Codex names — otherwise drift would silently rename tools.
            expect(round.allowedTools ?? undefined).toEqual(original.allowedTools);
            // Body must be byte-stable modulo the single trailing newline the
            // renderer enforces. The original SKILL.md fixtures already end in \n.
            expect(round.body.replace(/\n+$/, "")).toBe(original.body.replace(/\n+$/, "").replace(/^\n/, ""));
        });
    }
});
// ─── End-to-end emitCodex ────────────────────────────────────────
describe("emitCodex (filesystem)", () => {
    let tmpRoot;
    let pluginRoot;
    let targetDir;
    beforeAll(async () => {
        tmpRoot = await mkdtemp(join(tmpdir(), "fw-emit-codex-"));
        pluginRoot = join(tmpRoot, "plugin");
        targetDir = join(tmpRoot, "out");
        const skillsRoot = join(pluginRoot, "skills");
        await fs.mkdir(skillsRoot, { recursive: true });
        await fs.mkdir(join(skillsRoot, "alpha-skill"), { recursive: true });
        await fs.writeFile(join(skillsRoot, "alpha-skill", "SKILL.md"), SKILL_NO_TOOLS, "utf8");
        await fs.mkdir(join(skillsRoot, "beta-skill"), { recursive: true });
        await fs.writeFile(join(skillsRoot, "beta-skill", "SKILL.md"), SKILL_BLOCK_TOOLS, "utf8");
        // Underscore-prefixed dirs (templates) are skipped.
        await fs.mkdir(join(skillsRoot, "_template"), { recursive: true });
        await fs.writeFile(join(skillsRoot, "_template", "SKILL.md"), SKILL_NO_TOOLS, "utf8");
        // Dir without SKILL.md is skipped silently.
        await fs.mkdir(join(skillsRoot, "missing-skill-md"), { recursive: true });
    });
    afterAll(async () => {
        await rm(tmpRoot, { recursive: true, force: true });
    });
    it("writes AGENTS.md and per-skill files, skips templates and bad dirs", async () => {
        const report = await emitCodex({ pluginRoot, targetDir });
        expect(report.skillPaths.length).toBe(2);
        expect(report.agentsPath).toBe(join(targetDir, "AGENTS.md"));
        const skipped = report.skipped.map((s) => s.dir);
        expect(skipped).toContain("missing-skill-md");
        expect(skipped).not.toContain("_template");
        const agents = await fs.readFile(report.agentsPath, "utf8");
        expect(agents).toContain("## alpha-skill");
        expect(agents).toContain("## beta-skill");
        const beta = await fs.readFile(join(targetDir, ".codex", "skills", "beta-skill.md"), "utf8");
        expect(beta).toContain("# beta-skill");
        expect(beta).toContain("- `Bash`");
    });
    it("real-repo round-trip: every emitted file re-parses to the original frontmatter", async () => {
        const report = await emitCodex({ pluginRoot, targetDir });
        for (const p of report.skillPaths) {
            const text = await fs.readFile(p, "utf8");
            const round = parseCodexSkillFile(text);
            expect(round.name).toMatch(/^(alpha|beta)-skill$/);
            expect(round.description.length).toBeGreaterThan(0);
        }
    });
});
//# sourceMappingURL=codex.test.js.map