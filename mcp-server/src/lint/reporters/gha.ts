import type { LintResult, ReporterOptions, Severity } from "../types.js";
import { sortFindings, filterBySeverity } from "./index.js";

function commandFor(sev: Severity): string {
  if (sev === "error") return "error";
  if (sev === "warn") return "warning";
  return "notice";
}

function encode(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/,/g, "%2C");
}

export function format(result: LintResult, opts: ReporterOptions = {}): string {
  const findings = filterBySeverity(sortFindings(result.findings), opts.minSeverity);
  const lines = findings.map((f) => {
    const cmd = commandFor(f.severity);
    const title = encode(f.ruleId);
    const file = encode(f.file);
    const message = f.hint ? `${f.message}\n\nHint: ${f.hint}` : f.message;
    return `::${cmd} file=${file},line=${f.line},col=${f.column},title=${title}::${encode(message)}`;
  });
  for (const ie of result.internalErrors) {
    lines.push(`::error title=${encode(ie.ruleId)}::${encode(ie.message)}`);
  }
  return lines.join("\n");
}
