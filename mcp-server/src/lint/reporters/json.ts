import type { LintResult, ReporterOptions } from "../types.js";
import { sortFindings, filterBySeverity } from "./index.js";

export const JSON_SCHEMA_VERSION = 1;
export const RULESET_VERSION = 1;

export function format(result: LintResult, opts: ReporterOptions = {}): string {
  const sorted = filterBySeverity(sortFindings(result.findings), opts.minSeverity);
  return JSON.stringify({
    schemaVersion: JSON_SCHEMA_VERSION,
    rulesetVersion: RULESET_VERSION,
    summary: {
      errors: sorted.filter((f) => f.severity === "error").length,
      warnings: sorted.filter((f) => f.severity === "warn").length,
      infos: sorted.filter((f) => f.severity === "info").length,
      internalErrors: result.internalErrors.length,
    },
    findings: sorted.map((f) => ({
      ruleId: f.ruleId,
      rulesetVersion: RULESET_VERSION,
      severity: f.severity,
      file: f.file,
      line: f.line,
      column: f.column,
      ...(f.endLine !== undefined ? { endLine: f.endLine } : {}),
      ...(f.endColumn !== undefined ? { endColumn: f.endColumn } : {}),
      message: f.message,
      ...(f.hint !== undefined ? { hint: f.hint } : {}),
    })),
    internalErrors: result.internalErrors
      .slice()
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.message.localeCompare(b.message)),
  }, null, 2);
}
