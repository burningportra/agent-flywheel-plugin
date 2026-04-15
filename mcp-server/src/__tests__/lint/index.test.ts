import { describe, it, expect } from "vitest";
import { lint } from "../../lint/index.js";
import type { Finding, Rule } from "../../lint/types.js";

function mk(ruleId: string, line = 1): Finding {
  return { ruleId, severity: "error", file: "x.md", line, column: 1, message: "m" };
}

describe("lint()", () => {
  it("returns only parserFindings when no rules are supplied", async () => {
    const r = await lint({ filePath: "x.md", source: "# Hello\n\nworld\n" });
    expect(r.findings).toEqual([]);
    expect(r.internalErrors).toEqual([]);
  });

  it("runs supplied rules and accumulates findings", async () => {
    const rule: Rule = {
      id: "R1",
      description: "",
      severity: "error",
      check: () => [mk("R1", 1), mk("R1", 2)],
    };
    const r = await lint({
      filePath: "x.md",
      source: "# Hi\n",
      rules: [rule],
    });
    expect(r.findings.length).toBe(2);
    expect(r.findings.every((f) => f.ruleId === "R1")).toBe(true);
    expect(r.internalErrors).toEqual([]);
  });

  it("captures internalError for a rule that throws; other rules still run", async () => {
    const bad: Rule = {
      id: "BAD",
      description: "",
      severity: "error",
      check: () => {
        throw new Error("kaboom");
      },
    };
    const good: Rule = {
      id: "GOOD",
      description: "",
      severity: "error",
      check: () => [mk("GOOD", 7)],
    };
    const r = await lint({
      filePath: "x.md",
      source: "# Hi\n",
      rules: [bad, good],
    });
    expect(r.internalErrors.length).toBe(1);
    expect(r.internalErrors[0]!.ruleId).toBe("BAD");
    expect(r.internalErrors[0]!.message).toBe("kaboom");
    expect(r.findings.length).toBe(1);
    expect(r.findings[0]!.ruleId).toBe("GOOD");
  });

  it("propagates parserFindings (e.g., unclosed code fence) into result.findings", async () => {
    const r = await lint({
      filePath: "x.md",
      source: "# Title\n\n```ts\nnever closed\n",
    });
    expect(r.findings.some((f) => f.ruleId === "SKILL-010")).toBe(true);
  });

  it("honors per-rule timeout via ruleTimeoutMs", async () => {
    const slow: Rule = {
      id: "SLOW",
      description: "",
      severity: "error",
      check: () => new Promise<Finding[]>(() => {}),
    };
    const r = await lint({
      filePath: "x.md",
      source: "# Hi\n",
      rules: [slow],
      ruleTimeoutMs: 30,
    });
    expect(r.findings).toEqual([]);
    expect(r.internalErrors.length).toBe(1);
    expect(r.internalErrors[0]!.message).toMatch(/timeout/i);
  });

  it("merges ruleContextExtras into the RuleContext passed to rules", async () => {
    let captured: Record<string, unknown> | undefined;
    const rule: Rule = {
      id: "CTX",
      description: "",
      severity: "error",
      check: (_doc, c) => {
        captured = c as unknown as Record<string, unknown>;
        return [];
      },
    };
    await lint({
      filePath: "x.md",
      source: "# Hi\n",
      rules: [rule],
      ruleContextExtras: { skillRegistry: { foo: 1 } },
    });
    expect(captured).toBeDefined();
    expect(captured!.filePath).toBe("x.md");
    expect((captured!.skillRegistry as { foo: number }).foo).toBe(1);
  });
});
