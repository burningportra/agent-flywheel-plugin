import type { LintResult, ReporterOptions } from "../types.js";
import { severityLabel, visibleFindings } from "./index.js";

export function format(result: LintResult, opts: ReporterOptions = {}): string {
  const findings = visibleFindings(result, opts);
  const lines = findings.map((f) =>
    `${f.file}:${f.line}:${f.column}: ${severityLabel(f.severity, "warning")} ${f.ruleId}: ${f.message}`
  );
  for (const ie of result.internalErrors) {
    lines.push(`<internal>:0:0: error ${ie.ruleId}: ${ie.message}`);
  }
  return lines.join("\n");
}
