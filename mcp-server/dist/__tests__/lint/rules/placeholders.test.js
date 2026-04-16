import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../../lint/parser.js";
import { place001 } from "../../../lint/rules/placeholders.js";
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures");
async function parseFixture(name) {
    const path = join(FIXTURES, name);
    return parse(readFileSync(path, "utf8"), path);
}
async function parseSource(source, filePath = "inline.md") {
    return parse(source, filePath);
}
async function runRule(doc) {
    const ctx = { filePath: doc.filePath, source: doc.source };
    return await place001.check(doc, ctx);
}
describe("PLACE001", () => {
    it("flags placeholder with no definition in enclosing step", async () => {
        const doc = await parseSource(["# Skill", "", "## Step 1", "", "Replace <USER_INPUT> with the value.", ""].join("\n"));
        const findings = await runRule(doc);
        expect(findings.length).toBe(1);
        const f = findings[0];
        expect(f.ruleId).toBe("PLACE001");
        expect(f.severity).toBe("warn");
        expect(f.message).toContain("<user_input>");
        expect(f.message).toContain("Step 1");
        expect(f.hint).toContain("user_input");
    });
    it("does not flag placeholder when **NAME** marker appears in same step body", async () => {
        const doc = await parseSource([
            "# Skill",
            "",
            "## Step 1",
            "",
            "Use <USER_INPUT> here.",
            "",
            "The **USER_INPUT** is what the user typed.",
            "",
        ].join("\n"));
        const findings = await runRule(doc);
        expect(findings).toEqual([]);
    });
    it("does not flag placeholder when defined as bullet '- **NAME**:'", async () => {
        const doc = await parseFixture("place001-defined.md");
        const findings = await runRule(doc);
        expect(findings).toEqual([]);
    });
    it("does not flag <bead-id> when assignment 'bead-id=' appears in fenced block", async () => {
        const doc = await parseSource([
            "# Skill",
            "",
            "## Step 1",
            "",
            "Pass the <bead-id> to the CLI.",
            "",
            "```",
            "br update bead-id=foo --status closed",
            "```",
            "",
        ].join("\n"));
        const findings = await runRule(doc);
        expect(findings).toEqual([]);
    });
    it("does not flag HTML allowlist tags like <br>, <em>, <strong>", async () => {
        const doc = await parseFixture("place001-html-tag.md");
        const findings = await runRule(doc);
        expect(findings).toEqual([]);
    });
    it("emits 'outside any step' message when placeholder appears with no preceding header", async () => {
        const doc = await parseFixture("place001-orphan.md");
        const findings = await runRule(doc);
        expect(findings.length).toBe(1);
        const f = findings[0];
        expect(f.ruleId).toBe("PLACE001");
        expect(f.message).toContain("outside any step");
        expect(f.message).toContain("<user_input>");
    });
    it("flags only undefined placeholders when multiple placeholders appear in same step", async () => {
        const doc = await parseSource([
            "# Skill",
            "",
            "## Step 1",
            "",
            "Use <USER_INPUT> and also <UNKNOWN_TAG>.",
            "",
            "- **USER_INPUT**: the text typed.",
            "",
        ].join("\n"));
        const findings = await runRule(doc);
        expect(findings.length).toBe(1);
        expect(findings[0].message).toContain("<unknown_tag>");
    });
});
//# sourceMappingURL=placeholders.test.js.map