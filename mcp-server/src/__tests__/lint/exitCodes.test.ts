import { describe, it, expect } from "vitest";
import {
  computeExitCode,
  EXIT_CLEAN,
  EXIT_FINDINGS,
  EXIT_INTERNAL,
  EXIT_INVALID_ARGS,
  EXIT_FILE_ERROR,
} from "../../lint/exitCodes.js";
import type { Finding, LintResult } from "../../lint/types.js";

function f(severity: Finding["severity"]): Finding {
  return { ruleId: "X", severity, file: "x.md", line: 1, column: 1, message: "m" };
}

describe("computeExitCode", () => {
  it("EXIT_CLEAN (0) for empty result", () => {
    const r: LintResult = { findings: [], internalErrors: [] };
    expect(computeExitCode(r)).toBe(EXIT_CLEAN);
    expect(EXIT_CLEAN).toBe(0);
  });

  it("EXIT_FINDINGS (1) for a single error finding", () => {
    const r: LintResult = { findings: [f("error")], internalErrors: [] };
    expect(computeExitCode(r)).toBe(EXIT_FINDINGS);
    expect(EXIT_FINDINGS).toBe(1);
  });

  it("EXIT_CLEAN (0) for warn-only findings (warnings don't fail CI)", () => {
    const r: LintResult = { findings: [f("warn"), f("info")], internalErrors: [] };
    expect(computeExitCode(r)).toBe(EXIT_CLEAN);
  });

  it("EXIT_INTERNAL (2) for internalError", () => {
    const r: LintResult = {
      findings: [],
      internalErrors: [{ ruleId: "R", message: "boom" }],
    };
    expect(computeExitCode(r)).toBe(EXIT_INTERNAL);
    expect(EXIT_INTERNAL).toBe(2);
  });

  it("EXIT_INTERNAL takes precedence over EXIT_FINDINGS", () => {
    const r: LintResult = {
      findings: [f("error"), f("error")],
      internalErrors: [{ ruleId: "R", message: "boom" }],
    };
    expect(computeExitCode(r)).toBe(EXIT_INTERNAL);
  });

  it("constants for invalid args + file error are stable values", () => {
    expect(EXIT_INVALID_ARGS).toBe(3);
    expect(EXIT_FILE_ERROR).toBe(4);
  });
});
