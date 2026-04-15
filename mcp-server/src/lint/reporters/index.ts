import * as pretty from "./pretty.js";
import * as compact from "./compact.js";
import * as gha from "./gha.js";
import * as json from "./json.js";
import type { LintResult, Finding, ReporterOptions, Severity } from "../types.js";

export type ReporterName = "pretty" | "compact" | "gha" | "json";

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

export function selectReporter(): ReporterName {
  if (process.env.GITHUB_ACTIONS === "true") return "gha";
  if (process.stdout.isTTY) return "pretty";
  return "compact";
}

export function format(name: ReporterName, result: LintResult, opts: ReporterOptions = {}): string {
  switch (name) {
    case "pretty": return pretty.format(result, opts);
    case "compact": return compact.format(result, opts);
    case "gha": return gha.format(result, opts);
    case "json": return json.format(result, opts);
  }
}

export function sortFindings(findings: Finding[]): Finding[] {
  return findings.slice().sort((a, b) =>
    a.file.localeCompare(b.file)
    || a.line - b.line
    || a.column - b.column
    || a.ruleId.localeCompare(b.ruleId)
  );
}

export function filterBySeverity(findings: Finding[], minSeverity?: Severity): Finding[] {
  if (!minSeverity) return findings;
  const max = SEVERITY_RANK[minSeverity];
  return findings.filter((f) => SEVERITY_RANK[f.severity] <= max);
}
