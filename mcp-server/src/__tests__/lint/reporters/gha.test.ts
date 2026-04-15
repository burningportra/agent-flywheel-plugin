import { describe, it, expect } from "vitest";
import { format } from "../../../lint/reporters/gha.js";
import type { LintResult } from "../../../lint/types.js";

describe("gha reporter", () => {
  it("empty findings → empty output", () => {
    expect(format({ findings: [], internalErrors: [] })).toBe("");
  });

  it("emits sorted ::error/::warning/::notice commands", () => {
    const out = format({
      findings: [
        { ruleId: "AUQ002", severity: "warn", file: "b.md", line: 1, column: 1, message: "w" },
        { ruleId: "AUQ001", severity: "error", file: "a.md", line: 47, column: 7, message: "e" },
        { ruleId: "AUQ003", severity: "info", file: "c.md", line: 1, column: 1, message: "i" },
      ],
      internalErrors: [],
    });
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^::error file=a\.md,line=47,col=7,title=AUQ001::e$/);
    expect(lines[1]).toMatch(/^::warning file=b\.md,line=1,col=1,title=AUQ002::w$/);
    expect(lines[2]).toMatch(/^::notice file=c\.md,line=1,col=1,title=AUQ003::i$/);
  });

  it("escapes commas, newlines, percents", () => {
    const out = format({
      findings: [{
        ruleId: "X",
        severity: "error",
        file: "a,b.md",
        line: 1,
        column: 1,
        message: "line1\nline2,end 100%",
      }],
      internalErrors: [],
    });
    expect(out).toContain("file=a%2Cb.md");
    expect(out).toContain("line1%0Aline2%2Cend 100%25");
    expect(out).not.toContain("\n");
  });

  it("appends hint as %0A%0AHint: ...", () => {
    const out = format({
      findings: [{
        ruleId: "X",
        severity: "error",
        file: "a.md",
        line: 1,
        column: 1,
        message: "msg",
        hint: "do this",
      }],
      internalErrors: [],
    });
    expect(out).toContain("msg%0A%0AHint: do this");
  });
});
