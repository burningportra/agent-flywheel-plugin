import { describe, it, expect } from "vitest";
import { expandTemplate, getTemplateById, listTemplates, listBeadTemplates, TEMPLATE_INTEGRITY_WARNINGS, formatTemplatesForPrompt, } from "../bead-templates.js";
// Helper: a minimal valid input for each I8 template so render-correctness
// tests are readable in one place. Extra per-template placeholders live with
// the test that needs them.
const I8_MIN_INPUT = {
    TITLE: "Title line.",
    SCOPE: "Scope paragraph.",
    ACCEPTANCE: "Primary acceptance line.",
    TEST_PLAN: "Vitest covers the main path.",
    TARGET_FILE: "mcp-server/src/example.ts",
};
describe("bead-templates — module-load integrity", () => {
    it("TEMPLATE_INTEGRITY_WARNINGS is empty in a healthy module", () => {
        expect(TEMPLATE_INTEGRITY_WARNINGS).toEqual([]);
    });
    it("every (id, version) tuple is unique", () => {
        const tuples = listTemplates().map((t) => `${t.id}@${t.version}`);
        const unique = new Set(tuples);
        expect(unique.size).toBe(tuples.length);
    });
    it("listBeadTemplates is an alias for listTemplates", () => {
        // Stable ordering is important for snapshot consumers (prompts.ts).
        const a = listBeadTemplates().map((t) => `${t.id}@${t.version}`);
        const b = listTemplates().map((t) => `${t.id}@${t.version}`);
        expect(a).toEqual(b);
    });
    it("library has >= 7 templates (spec floor)", () => {
        expect(listTemplates().length).toBeGreaterThanOrEqual(7);
    });
    it("every placeholder used in descriptionTemplate is declared", () => {
        const pattern = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
        for (const t of listTemplates()) {
            const used = new Set(Array.from(t.descriptionTemplate.matchAll(pattern)).map((m) => m[1]));
            const declared = new Set(t.placeholders.map((p) => p.name));
            for (const name of used) {
                expect(declared.has(name), `${t.id}@${t.version}: ${name} declared?`).toBe(true);
            }
        }
    });
    it("every template declares >= 1 placeholder", () => {
        for (const t of listTemplates()) {
            expect(t.placeholders.length).toBeGreaterThan(0);
        }
    });
    it("formatTemplatesForPrompt mentions each (id, version) tuple", () => {
        const rendered = formatTemplatesForPrompt();
        for (const t of listTemplates()) {
            expect(rendered).toContain(`${t.id}@${t.version}`);
        }
    });
});
describe("getTemplateById", () => {
    it("returns the template when (id, version) matches", () => {
        const t = getTemplateById("foundation-with-fresh-eyes-gate", 1);
        expect(t).toBeDefined();
        expect(t?.id).toBe("foundation-with-fresh-eyes-gate");
        expect(t?.version).toBe(1);
    });
    it("returns undefined for unknown id", () => {
        expect(getTemplateById("no-such-template", 1)).toBeUndefined();
    });
    it("returns undefined for known id but wrong version", () => {
        expect(getTemplateById("foundation-with-fresh-eyes-gate", 99)).toBeUndefined();
    });
    it("returns highest version when version omitted", () => {
        const t = getTemplateById("foundation-with-fresh-eyes-gate");
        expect(t).toBeDefined();
        expect(t?.version).toBe(1);
    });
    it("returned template is a clone — mutations don't leak", () => {
        const a = getTemplateById("add-feature", 1);
        const b = getTemplateById("add-feature", 1);
        if (!a || !b)
            throw new Error("add-feature@1 must exist");
        a.placeholders.push({ name: "INJECTED", description: "", example: "", required: false });
        expect(b.placeholders.some((p) => p.name === "INJECTED")).toBe(false);
    });
});
describe("expandTemplate — error branches", () => {
    it("unknown id → template_not_found", () => {
        const result = expandTemplate("no-such-template", 1, { title: "x" });
        expect(result.success).toBe(false);
        if (result.success)
            return;
        expect(result.error).toBe("template_not_found");
        expect(result.detail).toContain("no-such-template");
    });
    it("unknown version → template_not_found", () => {
        const result = expandTemplate("add-feature", 42, I8_MIN_INPUT);
        expect(result.success).toBe(false);
        if (result.success)
            return;
        expect(result.error).toBe("template_not_found");
        expect(result.detail).toContain("add-feature@42");
    });
    it("missing required placeholder → template_placeholder_missing", () => {
        const result = expandTemplate("add-feature", 1, { TITLE: "Only title." });
        expect(result.success).toBe(false);
        if (result.success)
            return;
        expect(result.error).toBe("template_placeholder_missing");
        // detail names the missing placeholders
        expect(result.detail).toMatch(/SCOPE|ACCEPTANCE|TEST_PLAN|TARGET_FILE/);
    });
    it("carriage return in placeholder value → template_expansion_failed", () => {
        const result = expandTemplate("add-feature", 1, {
            ...I8_MIN_INPUT,
            TITLE: "broken\rtitle",
        });
        expect(result.success).toBe(false);
        if (result.success)
            return;
        expect(result.error).toBe("template_expansion_failed");
        expect(result.detail).toContain("TITLE");
    });
    it("null byte in placeholder value → template_expansion_failed", () => {
        const result = expandTemplate("add-feature", 1, {
            ...I8_MIN_INPUT,
            TITLE: "bad\0title",
        });
        expect(result.success).toBe(false);
        if (result.success)
            return;
        expect(result.error).toBe("template_expansion_failed");
    });
    it("drops undefined input values before missing-required check", () => {
        const result = expandTemplate("add-feature", 1, {
            ...I8_MIN_INPUT,
            TITLE: undefined,
        });
        expect(result.success).toBe(false);
        if (result.success)
            return;
        expect(result.error).toBe("template_placeholder_missing");
        expect(result.detail).toContain("TITLE");
    });
});
describe("expandTemplate — render correctness (one per I8 template)", () => {
    it("foundation-with-fresh-eyes-gate@1 renders", () => {
        const result = expandTemplate("foundation-with-fresh-eyes-gate", 1, {
            ...I8_MIN_INPUT,
            PARENT_WAVE_BEADS: "I8, I9",
        });
        expect(result.success).toBe(true);
        if (!result.success)
            return;
        expect(result.description).toContain("Title line.");
        expect(result.description).toContain("I8, I9");
        expect(result.description).toContain("mcp-server/src/example.ts");
        expect(result.description).toMatchSnapshot();
    });
    it("test-coverage@1 renders", () => {
        const result = expandTemplate("test-coverage", 1, {
            ...I8_MIN_INPUT,
            PARENT_WAVE_BEADS: "I8",
        });
        expect(result.success).toBe(true);
        if (!result.success)
            return;
        expect(result.description).toContain("Vitest covers the main path.");
        expect(result.description).toMatchSnapshot();
    });
    it("doc-update@1 renders", () => {
        const result = expandTemplate("doc-update", 1, {
            ...I8_MIN_INPUT,
            PARENT_WAVE_BEADS: "F1",
        });
        expect(result.success).toBe(true);
        if (!result.success)
            return;
        expect(result.description).toContain("F1");
        expect(result.description).toMatchSnapshot();
    });
    it("refactor-carve@1 renders", () => {
        const result = expandTemplate("refactor-carve", 1, {
            ...I8_MIN_INPUT,
            CARVED_DIR: "src/topstepx/",
        });
        expect(result.success).toBe(true);
        if (!result.success)
            return;
        expect(result.description).toContain("src/topstepx/");
        expect(result.description).toMatchSnapshot();
    });
    it("refactor-module@1 renders (legacy template)", () => {
        const result = expandTemplate("refactor-module", 1, {
            moduleName: "scan pipeline",
            refactorGoal: "separation of parsing from UI formatting",
            currentPain: "logic and rendering are tightly coupled",
            moduleFile: "src/scan.ts",
            testFile: "src/scan.test.ts",
        });
        expect(result.success).toBe(true);
        if (!result.success)
            return;
        expect(result.description).toContain("scan pipeline");
        expect(result.description).toMatchSnapshot();
    });
    it("inter-wave-fixup@1 renders (optional PARENT_WAVE_BEADS omitted)", () => {
        const result = expandTemplate("inter-wave-fixup", 1, I8_MIN_INPUT);
        expect(result.success).toBe(true);
        if (!result.success)
            return;
        expect(result.description).toContain("Title line.");
        expect(result.description).toMatchSnapshot();
    });
    it("new-mcp-tool@1 renders", () => {
        const result = expandTemplate("new-mcp-tool", 1, {
            ...I8_MIN_INPUT,
            TOOL_NAME: "flywheel_example_tool",
            TOOL_PURPOSE: "render something useful",
            TEST_FILE: "mcp-server/src/__tests__/tools/example.test.ts",
        });
        expect(result.success).toBe(true);
        if (!result.success)
            return;
        expect(result.description).toContain("flywheel_example_tool");
        expect(result.description).toMatchSnapshot();
    });
    it("new-skill@1 renders", () => {
        const result = expandTemplate("new-skill", 1, {
            ...I8_MIN_INPUT,
            SKILL_NAME: "flywheel-example",
            COMMAND_FILE: "commands/flywheel-example.md",
        });
        expect(result.success).toBe(true);
        if (!result.success)
            return;
        expect(result.description).toContain("flywheel-example");
        expect(result.description).toMatchSnapshot();
    });
    it("add-feature@1 renders", () => {
        const result = expandTemplate("add-feature", 1, I8_MIN_INPUT);
        expect(result.success).toBe(true);
        if (!result.success)
            return;
        expect(result.description).toContain("Title line.");
        expect(result.description).toContain("mcp-server/src/example.ts");
        expect(result.description).toMatchSnapshot();
    });
});
describe("expandTemplate — per-template placeholder coverage", () => {
    it("foundation-with-fresh-eyes-gate requires PARENT_WAVE_BEADS", () => {
        const result = expandTemplate("foundation-with-fresh-eyes-gate", 1, I8_MIN_INPUT);
        expect(result.success).toBe(false);
        if (result.success)
            return;
        expect(result.error).toBe("template_placeholder_missing");
        expect(result.detail).toContain("PARENT_WAVE_BEADS");
    });
    it("refactor-carve requires CARVED_DIR", () => {
        const result = expandTemplate("refactor-carve", 1, I8_MIN_INPUT);
        expect(result.success).toBe(false);
        if (result.success)
            return;
        expect(result.error).toBe("template_placeholder_missing");
        expect(result.detail).toContain("CARVED_DIR");
    });
    it("new-mcp-tool requires TOOL_NAME / TOOL_PURPOSE / TEST_FILE", () => {
        const result = expandTemplate("new-mcp-tool", 1, I8_MIN_INPUT);
        expect(result.success).toBe(false);
        if (result.success)
            return;
        expect(result.error).toBe("template_placeholder_missing");
        expect(result.detail).toMatch(/TOOL_NAME|TOOL_PURPOSE|TEST_FILE/);
    });
    it("new-skill requires SKILL_NAME / COMMAND_FILE", () => {
        const result = expandTemplate("new-skill", 1, I8_MIN_INPUT);
        expect(result.success).toBe(false);
        if (result.success)
            return;
        expect(result.error).toBe("template_placeholder_missing");
        expect(result.detail).toMatch(/SKILL_NAME|COMMAND_FILE/);
    });
    it("test-coverage / doc-update require PARENT_WAVE_BEADS", () => {
        for (const id of ["test-coverage", "doc-update"]) {
            const result = expandTemplate(id, 1, I8_MIN_INPUT);
            expect(result.success, `${id} should fail without PARENT_WAVE_BEADS`).toBe(false);
            if (result.success)
                continue;
            expect(result.error).toBe("template_placeholder_missing");
            expect(result.detail).toContain("PARENT_WAVE_BEADS");
        }
    });
});
//# sourceMappingURL=bead-templates.test.js.map