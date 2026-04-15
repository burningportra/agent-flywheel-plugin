import { describe, it, expect } from "vitest";
import { format, JSON_SCHEMA_VERSION, RULESET_VERSION } from "../../../lint/reporters/json.js";
import { selectReporter } from "../../../lint/reporters/index.js";
import type { LintResult } from "../../../lint/types.js";

const sample: LintResult = {
  findings: [
    { ruleId: "AUQ002", severity: "warn", file: "b.md", line: 10, column: 1, message: "w" },
    { ruleId: "AUQ001", severity: "error", file: "a.md", line: 47, column: 7, message: "e", hint: "h" },
  ],
  internalErrors: [],
};

describe("json reporter", () => {
  it("empty findings → valid JSON with empty arrays", () => {
    const out = format({ findings: [], internalErrors: [] });
    const obj = JSON.parse(out);
    expect(obj.schemaVersion).toBe(1);
    expect(obj.findings).toEqual([]);
    expect(obj.summary).toEqual({ errors: 0, warnings: 0, infos: 0, internalErrors: 0 });
  });

  it("schemaVersion=1, rulesetVersion=1 per finding", () => {
    const obj = JSON.parse(format(sample));
    expect(obj.schemaVersion).toBe(JSON_SCHEMA_VERSION);
    expect(obj.rulesetVersion).toBe(RULESET_VERSION);
    for (const f of obj.findings) {
      expect(f.rulesetVersion).toBe(RULESET_VERSION);
    }
  });

  it("findings sorted by (file, line, col, ruleId)", () => {
    const obj = JSON.parse(format(sample));
    expect(obj.findings[0].file).toBe("a.md");
    expect(obj.findings[1].file).toBe("b.md");
  });

  it("deterministic across calls", () => {
    expect(format(sample)).toBe(format(sample));
  });

  it("omits optional fields when undefined", () => {
    const obj = JSON.parse(format(sample));
    expect("hint" in obj.findings[0]).toBe(true);
    expect("hint" in obj.findings[1]).toBe(false);
    expect("endLine" in obj.findings[0]).toBe(false);
  });
});

describe("selectReporter", () => {
  const origGha = process.env.GITHUB_ACTIONS;
  const origTty = (process.stdout as { isTTY?: boolean }).isTTY;

  it("GITHUB_ACTIONS=true → gha", () => {
    process.env.GITHUB_ACTIONS = "true";
    try {
      expect(selectReporter()).toBe("gha");
    } finally {
      if (origGha === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = origGha;
    }
  });

  it("non-TTY (no GHA) → compact", () => {
    delete process.env.GITHUB_ACTIONS;
    (process.stdout as { isTTY?: boolean }).isTTY = false;
    try {
      expect(selectReporter()).toBe("compact");
    } finally {
      (process.stdout as { isTTY?: boolean }).isTTY = origTty;
      if (origGha !== undefined) process.env.GITHUB_ACTIONS = origGha;
    }
  });

  it("TTY (no GHA) → pretty", () => {
    delete process.env.GITHUB_ACTIONS;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    try {
      expect(selectReporter()).toBe("pretty");
    } finally {
      (process.stdout as { isTTY?: boolean }).isTTY = origTty;
      if (origGha !== undefined) process.env.GITHUB_ACTIONS = origGha;
    }
  });
});
