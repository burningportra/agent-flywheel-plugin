import { describe, it, expect } from "vitest";
import type { Finding, LintResult } from "../../lint/index.js";

describe("types", () => {
  it("Finding shape compiles with required fields only", () => {
    const f: Finding = {
      ruleId: "X",
      severity: "error",
      file: "a.md",
      line: 1,
      column: 1,
      message: "m",
    };
    expect(f.ruleId).toBe("X");
  });
  it("LintResult shape has findings + internalErrors arrays", () => {
    const r: LintResult = { findings: [], internalErrors: [] };
    expect(Array.isArray(r.findings)).toBe(true);
    expect(Array.isArray(r.internalErrors)).toBe(true);
  });
});
