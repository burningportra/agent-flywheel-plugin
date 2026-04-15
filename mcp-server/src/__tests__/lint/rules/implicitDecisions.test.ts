import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../../lint/parser.js";
import { impl001, IMPLICIT_DECISION_PHRASES } from "../../../lint/rules/implicitDecisions.js";
import type { Finding, ParsedDocument, Rule, RuleContext } from "../../../lint/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures");

async function parseFixture(name: string): Promise<ParsedDocument> {
  const path = join(FIXTURES, name);
  return parse(readFileSync(path, "utf8"), path);
}

function ctxFor(doc: ParsedDocument): RuleContext {
  return { filePath: doc.filePath, source: doc.source };
}

async function run(rule: Rule, fixture: string): Promise<Finding[]> {
  const doc = await parseFixture(fixture);
  const result = await rule.check(doc, ctxFor(doc));
  return result;
}

describe("IMPL001 phrase dictionary", () => {
  it("exports at least 13 seed phrases", () => {
    expect(IMPLICIT_DECISION_PHRASES.length).toBeGreaterThanOrEqual(13);
  });
});

describe("IMPL001 (implicit-decision phrasing)", () => {
  it("flags 'wait for confirmation' in raw prose", async () => {
    const findings = await run(impl001, "impl001-raw.md");
    expect(findings.length).toBe(1);
    expect(findings[0]!.ruleId).toBe("IMPL001");
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message.toLowerCase()).toContain("wait for confirmation");
    expect(findings[0]!.line).toBeGreaterThan(0);
    expect(findings[0]!.column).toBeGreaterThan(0);
    expect(findings[0]!.hint).toContain("AskUserQuestion");
  });

  it("does not flag phrases inside a UR1 callout region", async () => {
    const findings = await run(impl001, "impl001-exempt-ur1.md");
    expect(findings).toEqual([]);
  });

  it("does not flag phrases followed by AskUserQuestion within 20 lines", async () => {
    const findings = await run(impl001, "impl001-exempt-followed.md");
    expect(findings).toEqual([]);
  });

  it("does not flag phrases inside backtick-quoted spans", async () => {
    const findings = await run(impl001, "impl001-exempt-backtick.md");
    expect(findings).toEqual([]);
  });

  it("flags multiple occurrences on the same line", async () => {
    const src = `# X\n\nFirst, ask the user, then ask the user again before doing it.\n`;
    const doc = await parse(src, "multi-on-line.md");
    const findings = await impl001.check(doc, { filePath: "multi-on-line.md", source: src });
    expect(findings.length).toBe(2);
    expect(findings[0]!.line).toBe(findings[1]!.line);
    expect(findings[0]!.column).toBeLessThan(findings[1]!.column);
  });

  it("matches regex-pattern phrase ('only do X if the user confirms')", async () => {
    const src = `# X\n\nOnly do this if the user confirms the action.\n`;
    const doc = await parse(src, "regex-phrase.md");
    const findings = await impl001.check(doc, { filePath: "regex-phrase.md", source: src });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => /only do .+ if the user confirms/i.test(f.message))).toBe(true);
  });

  it("flags phrase when AskUserQuestion is more than 20 lines away", async () => {
    const padding = Array.from({ length: 25 }, () => "filler line").join("\n");
    const src = `# X\n\nWe should wait for confirmation here.\n\n${padding}\n\n\`\`\`ts\nAskUserQuestion({ questions: [ { question: "q", header: "h", multiSelect: false, options: [ { label: "A", description: "a" }, { label: "B", description: "b" } ] } ] })\n\`\`\`\n`;
    const doc = await parse(src, "far-auq.md");
    const findings = await impl001.check(doc, { filePath: "far-auq.md", source: src });
    expect(findings.length).toBe(1);
  });

  it("is case-insensitive", async () => {
    const src = `# X\n\nWAIT FOR CONFIRMATION before continuing.\n`;
    const doc = await parse(src, "case-insensitive.md");
    const findings = await impl001.check(doc, { filePath: "case-insensitive.md", source: src });
    expect(findings.length).toBe(1);
    expect(findings[0]!.message).toContain("WAIT FOR CONFIRMATION");
  });
});
