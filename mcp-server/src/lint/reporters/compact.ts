import type { LintResult, ReporterOptions, Severity } from "../types.js";
import { sortFindings, filterBySeverity } from "./index.js";

function labelFor(sev: Severity): string {
  if (sev === "error") return "error";
  if (sev === "warn") return "warning";
  return "info";
}

export function format(result: LintResult, opts: ReporterOptions = {}): string {
  const findings = filterBySeverity(sortFindings(result.findings), opts.minSeverity);
  const lines = findings.map((f) =>
    `${f.file}:${f.line}:${f.column}: ${labelFor(f.severity)} ${f.ruleId}: ${f.message}`
  );
  for (const ie of result.internalErrors) {
    lines.push(`<internal>:0:0: error ${ie.ruleId}: ${ie.message}`);
  }
  return lines.join("\n");
}
