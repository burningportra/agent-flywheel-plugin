import { pathToFileURL } from "node:url";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

interface BudgetEntry {
  id: string;
  group: "skill";
  source: string;
  chars: number;
  estimatedTokens: number;
}

interface PromptBudgetModule {
  measureText: (id: string, group: "skill", source: string, value: string) => BudgetEntry;
  compareEntries: (
    baseline: BudgetEntry[],
    current: BudgetEntry[],
    thresholdPercent?: number,
  ) => Array<{
    id: string;
    baselineChars: number;
    currentChars: number;
    growthPercent: number;
    reason: "grew" | "new-entry";
  }>;
}

let budget: PromptBudgetModule;

beforeAll(async () => {
  const scriptPath = path.resolve(__dirname, "..", "..", "..", "scripts", "prompt-budget.ts");
  budget = (await import(pathToFileURL(scriptPath).href)) as PromptBudgetModule;
});

describe("prompt budget measurement", () => {
  it("measures characters and labels chars divided by four as an estimate", () => {
    expect(budget.measureText("fixture", "skill", "fixture.md", "abcdefghij")).toEqual({
      id: "fixture",
      group: "skill",
      source: "fixture.md",
      chars: 10,
      estimatedTokens: 3,
    });
  });

  it("allows exactly 10% growth and rejects a 20% increase plus a new entry", () => {
    const baseline = [
      budget.measureText("exact-threshold", "skill", "a.md", "a".repeat(100)),
      budget.measureText("too-large", "skill", "b.md", "b".repeat(50)),
    ];
    const current = [
      budget.measureText("exact-threshold", "skill", "a.md", "a".repeat(110)),
      budget.measureText("too-large", "skill", "b.md", "b".repeat(60)),
      budget.measureText("new-entry", "skill", "c.md", "c".repeat(4)),
    ];

    const violations = budget.compareEntries(baseline, current);

    expect(violations.map((violation) => violation.id)).toEqual(["new-entry", "too-large"]);
    expect(violations[0]).toMatchObject({
      baselineChars: 0,
      currentChars: 4,
      reason: "new-entry",
    });
    expect(violations[1]).toMatchObject({
      baselineChars: 50,
      currentChars: 60,
      growthPercent: 20,
      reason: "grew",
    });
  });
});
