import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../../lint/parser.js";
import { slash001 } from "../../../lint/rules/slashReferences.js";
import type { SkillRegistry, SkillSource } from "../../../lint/skillRegistry.js";
import type { Finding, ParsedDocument } from "../../../lint/types.js";
import type { SlashReferencesContext } from "../../../lint/rules/slashReferences.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures");

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

function stubRegistry(names: string[]): SkillRegistry {
  const set = new Set(names.map((n) => (n.startsWith("/") ? n.slice(1) : n)));
  const arr = Array.from(set);
  return {
    size: arr.length,
    has(slashName: string): boolean {
      const n = slashName.startsWith("/") ? slashName.slice(1) : slashName;
      return set.has(n);
    },
    suggest(slashName: string, k = 3): string[] {
      const target = slashName.startsWith("/") ? slashName.slice(1) : slashName;
      return arr
        .map((n) => ({ n, d: levenshtein(target, n) }))
        .filter((x) => x.d <= 5)
        .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))
        .slice(0, k)
        .map((x) => x.n);
    },
    source(slashName: string): SkillSource | undefined {
      const n = slashName.startsWith("/") ? slashName.slice(1) : slashName;
      return set.has(n) ? "repo" : undefined;
    },
  };
}

async function parseFixture(name: string): Promise<ParsedDocument> {
  const path = join(FIXTURES, name);
  return parse(readFileSync(path, "utf8"), path);
}

async function parseSource(source: string, filePath = "inline.md"): Promise<ParsedDocument> {
  return parse(source, filePath);
}

async function runRule(doc: ParsedDocument, registry: SkillRegistry): Promise<Finding[]> {
  const ctx: SlashReferencesContext = {
    filePath: doc.filePath,
    source: doc.source,
    registry,
  };
  return await slash001.check(doc, ctx);
}

const REGISTRY = stubRegistry(["idea-wizard", "memory", "deploy", "ccc"]);

describe("SLASH001", () => {
  it("does not flag /idea-wizard when registered", async () => {
    const doc = await parseSource("Use /idea-wizard for brainstorms.\n");
    const findings = await runRule(doc, REGISTRY);
    expect(findings).toEqual([]);
  });

  it("flags typo /idea-wizrd with suggestion to /idea-wizard", async () => {
    const doc = await parseFixture("slash001-typo.md");
    const findings = await runRule(doc, REGISTRY);
    expect(findings.length).toBe(1);
    const f = findings[0]!;
    expect(f.ruleId).toBe("SLASH001");
    expect(f.severity).toBe("warn");
    expect(f.message).toContain("/idea-wizrd");
    expect(f.hint).toContain("/idea-wizard");
    expect(f.line).toBeGreaterThan(0);
    expect(f.column).toBeGreaterThan(0);
  });

  it("flags unknown skill with no near match using allowlist hint", async () => {
    const doc = await parseSource("Try /totally-unknown-skill-xyz now.\n");
    const findings = await runRule(doc, REGISTRY);
    expect(findings.length).toBe(1);
    const f = findings[0]!;
    expect(f.ruleId).toBe("SLASH001");
    expect(f.message).toContain("/totally-unknown-skill-xyz");
    expect(f.hint).toContain("knownExternalSlashes");
  });

  it("does not flag URLs like https://example.com/foo", async () => {
    const doc = await parseFixture("slash001-inside-url.md");
    const findings = await runRule(doc, REGISTRY);
    expect(findings).toEqual([]);
  });

  it("does not flag multi-slash paths like ~/.claude/plugins/foo", async () => {
    const doc = await parseFixture("slash001-multi-slash-path.md");
    const findings = await runRule(doc, REGISTRY);
    expect(findings).toEqual([]);
  });

  it("does not flag HTTP method paths like GET /api/users", async () => {
    const doc = await parseFixture("slash001-http-path.md");
    const findings = await runRule(doc, REGISTRY);
    expect(findings).toEqual([]);
  });

  it("flags /idea-wizrd inside an AskUserQuestion option description", async () => {
    const src = [
      "```ts",
      "AskUserQuestion({",
      "  questions: [",
      "    {",
      '      question: "Pick one",',
      '      header: "Choice",',
      "      options: [",
      '        { label: "Wizard", description: "Invoke /idea-wizrd to plan." },',
      '        { label: "Skip", description: "Do nothing." },',
      "      ],",
      "    },",
      "  ],",
      "})",
      "```",
      "",
    ].join("\n");
    const doc = await parseSource(src);
    const findings = await runRule(doc, REGISTRY);
    expect(findings.length).toBe(1);
    const f = findings[0]!;
    expect(f.ruleId).toBe("SLASH001");
    expect(f.message).toContain("/idea-wizrd");
    expect(f.hint).toContain("/idea-wizard");
  });

  it("returns no findings when registry is missing from context", async () => {
    const doc = await parseSource("Use /idea-wizrd here.\n");
    const findings = await slash001.check(doc, { filePath: doc.filePath, source: doc.source });
    expect(findings).toEqual([]);
  });
});
