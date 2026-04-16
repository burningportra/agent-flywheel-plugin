import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../../lint/parser.js";
import { auq001, auq002, auq003, auq004, auqRules } from "../../../lint/rules/askUserQuestion.js";
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures");
async function parseFixture(name) {
    const path = join(FIXTURES, name);
    return parse(readFileSync(path, "utf8"), path);
}
function ctxFor(doc) {
    return { filePath: doc.filePath, source: doc.source };
}
async function run(rule, fixture) {
    const doc = await parseFixture(fixture);
    const result = await rule.check(doc, ctxFor(doc));
    return result;
}
describe("auqRules", () => {
    it("exports all four rules in order", () => {
        expect(auqRules.map((r) => r.id)).toEqual(["AUQ001", "AUQ002", "AUQ003", "AUQ004"]);
    });
});
describe("AUQ001 (option count 2-4)", () => {
    it("flags 1-option question", async () => {
        const findings = await run(auq001, "auq001-too-few.md");
        expect(findings.length).toBe(1);
        expect(findings[0].ruleId).toBe("AUQ001");
        expect(findings[0].severity).toBe("error");
        expect(findings[0].message).toContain("1 options");
        expect(findings[0].message).toContain("2–4");
        expect(findings[0].line).toBeGreaterThan(0);
    });
    it("flags 5-option question", async () => {
        const findings = await run(auq001, "auq001-too-many.md");
        expect(findings.length).toBe(1);
        expect(findings[0].message).toContain("5 options");
    });
    it("passes 2-option question", async () => {
        const findings = await run(auq001, "auq003-header-missing.md");
        expect(findings).toEqual([]);
    });
    it("passes 4-option question", async () => {
        const src = `\`\`\`ts
AskUserQuestion({
  questions: [
    {
      question: "Q",
      header: "H",
      multiSelect: false,
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
        { label: "C", description: "c" },
        { label: "D", description: "d" }
      ]
    }
  ]
})
\`\`\``;
        const doc = await parse(src, "inline-4opt.md");
        const findings = await auq001.check(doc, { filePath: "inline-4opt.md", source: src });
        expect(findings).toEqual([]);
    });
});
describe("AUQ002 (options need description, no bare strings)", () => {
    it("flags missing description", async () => {
        const findings = await run(auq002, "auq002-missing-desc.md");
        expect(findings.length).toBe(1);
        expect(findings[0].ruleId).toBe("AUQ002");
        expect(findings[0].severity).toBe("error");
        expect(findings[0].message).toContain('"B"');
        expect(findings[0].message).toContain("description");
    });
    it("flags bare string", async () => {
        const findings = await run(auq002, "auq002-bare-string.md");
        expect(findings.length).toBe(1);
        expect(findings[0].message).toContain("bare string");
        expect(findings[0].message).toContain('"BareString"');
    });
    it("passes well-formed options", async () => {
        const findings = await run(auq002, "auq003-header-missing.md");
        expect(findings).toEqual([]);
    });
});
describe("AUQ003 (header present and ≤12 graphemes)", () => {
    it("flags missing header", async () => {
        const findings = await run(auq003, "auq003-header-missing.md");
        expect(findings.length).toBe(1);
        expect(findings[0].ruleId).toBe("AUQ003");
        expect(findings[0].message).toContain("missing");
    });
    it("flags 13-char header", async () => {
        const findings = await run(auq003, "auq003-header-too-long.md");
        expect(findings.length).toBe(1);
        expect(findings[0].message).toContain("13 chars");
        expect(findings[0].message).toContain("ThirteenChars");
    });
    it("passes 12-char header", async () => {
        const src = `\`\`\`ts
AskUserQuestion({
  questions: [
    {
      question: "Q",
      header: "TwelveCharss",
      multiSelect: false,
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" }
      ]
    }
  ]
})
\`\`\``;
        const doc = await parse(src, "inline-12.md");
        const findings = await auq003.check(doc, { filePath: "inline-12.md", source: src });
        expect(findings).toEqual([]);
    });
    it("passes emoji header counted via Array.from (11 graphemes)", async () => {
        const findings = await run(auq003, "auq003-header-emoji.md");
        expect(findings).toEqual([]);
    });
});
describe("AUQ004 (multiSelect explicit)", () => {
    it("flags missing multiSelect as warn", async () => {
        const findings = await run(auq004, "auq004-implicit.md");
        expect(findings.length).toBe(1);
        expect(findings[0].ruleId).toBe("AUQ004");
        expect(findings[0].severity).toBe("warn");
        expect(findings[0].message).toContain("multiSelect");
    });
    it("passes when multiSelect: false is explicit", async () => {
        const findings = await run(auq004, "auq003-header-missing.md");
        expect(findings).toEqual([]);
    });
    it("passes when multiSelect: true is explicit", async () => {
        const src = `\`\`\`ts
AskUserQuestion({
  questions: [
    {
      question: "Q",
      header: "H",
      multiSelect: true,
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" }
      ]
    }
  ]
})
\`\`\``;
        const doc = await parse(src, "inline-ms-true.md");
        const findings = await auq004.check(doc, { filePath: "inline-ms-true.md", source: src });
        expect(findings).toEqual([]);
    });
});
describe("multi-question AUQ", () => {
    it("one bad question doesn't suppress findings on others", async () => {
        const src = `\`\`\`ts
AskUserQuestion({
  questions: [
    {
      question: "Good",
      header: "Good",
      multiSelect: false,
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" }
      ]
    },
    {
      question: "Bad too long header",
      header: "ThirteenChars",
      multiSelect: false,
      options: [
        { label: "X", description: "x" },
        { label: "Y", description: "y" }
      ]
    },
    {
      question: "Bad single option",
      header: "Bad",
      multiSelect: false,
      options: [
        { label: "Only", description: "only" }
      ]
    }
  ]
})
\`\`\``;
        const doc = await parse(src, "multi-q.md");
        const ctx = { filePath: "multi-q.md", source: src };
        const findings001 = await auq001.check(doc, ctx);
        const findings003 = await auq003.check(doc, ctx);
        expect(findings001.length).toBe(1);
        expect(findings001[0].message).toContain("1 options");
        expect(findings003.length).toBe(1);
        expect(findings003[0].message).toContain("ThirteenChars");
    });
});
describe("parse error AUQ", () => {
    it("emits no findings when call.parseError is true", async () => {
        const src = "```ts\nAskUserQuestion(\n```\n";
        const doc = await parse(src, "broken.md");
        const hasParseError = doc.askUserQuestionCalls.some((c) => c.parseError);
        expect(hasParseError).toBe(true);
        const ctx = { filePath: "broken.md", source: src };
        expect(await auq001.check(doc, ctx)).toEqual([]);
        expect(await auq002.check(doc, ctx)).toEqual([]);
        expect(await auq003.check(doc, ctx)).toEqual([]);
        expect(await auq004.check(doc, ctx)).toEqual([]);
    });
});
//# sourceMappingURL=askUserQuestion.test.js.map