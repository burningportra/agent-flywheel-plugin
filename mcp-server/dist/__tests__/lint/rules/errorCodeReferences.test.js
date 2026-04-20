import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../../lint/parser.js";
import { err001 } from "../../../lint/rules/errorCodeReferences.js";
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
    return await err001.check(doc, ctx);
}
describe("ERR001", () => {
    it("flags string-matching patterns for known tool errors", async () => {
        const doc = await parseFixture("err001-string-match.md");
        const findings = await runRule(doc);
        expect(findings.length).toBe(2);
        expect(findings[0].ruleId).toBe("ERR001");
        expect(findings[0].severity).toBe("warn");
        expect(findings[0].message).toContain("missing_prerequisite");
        expect(findings[1].message).toContain("not_found");
    });
    it("does not flag structured code branches", async () => {
        const doc = await parseSource([
            "```ts",
            "const code = result.structuredContent?.data?.error?.code;",
            'if (code === "missing_prerequisite") await bootstrapGoal();',
            "```",
            "",
        ].join("\n"));
        const findings = await runRule(doc);
        expect(findings).toEqual([]);
    });
    it("does not flag plain mentions without legacy match logic", async () => {
        const doc = await parseSource("This flow can return `already_closed` in post-close audits.\n", "plain-mention.md");
        const findings = await runRule(doc);
        expect(findings).toEqual([]);
    });
});
//# sourceMappingURL=errorCodeReferences.test.js.map