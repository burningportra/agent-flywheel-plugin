import type { LintResult, ReporterOptions, Finding, Severity } from "../types.js";
import { sortFindings, filterBySeverity } from "./index.js";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

function colorFor(sev: Severity): string {
  if (sev === "error") return ANSI.red;
  if (sev === "warn") return ANSI.yellow;
  return ANSI.cyan;
}

function labelFor(sev: Severity): string {
  if (sev === "error") return "error";
  if (sev === "warn") return "warn";
  return "info";
}

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function format(result: LintResult, opts: ReporterOptions = {}): string {
  const findings = filterBySeverity(sortFindings(result.findings), opts.minSeverity);

  if (findings.length === 0 && result.internalErrors.length === 0) {
    return "";
  }

  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = groups.get(f.file);
    if (list) list.push(f);
    else groups.set(f.file, [f]);
  }

  const maxLoc = findings.reduce((m, f) => Math.max(m, `${f.line}:${f.column}`.length), 0);
  const maxLabel = findings.reduce((m, f) => Math.max(m, labelFor(f.severity).length), 0);
  const maxRule = findings.reduce((m, f) => Math.max(m, f.ruleId.length), 0);

  const lines: string[] = [];
  for (const [file, group] of groups) {
    lines.push(`${ANSI.bold}${file}${ANSI.reset}`);
    for (const f of group) {
      const loc = `${f.line}:${f.column}`.padStart(maxLoc);
      const sev = `${colorFor(f.severity)}${labelFor(f.severity).padEnd(maxLabel)}${ANSI.reset}`;
      const rule = f.ruleId.padEnd(maxRule);
      let line = `  ${loc}  ${sev}  ${rule}  ${f.message}`;
      if (f.hint) {
        line += `\n${" ".repeat(maxLoc + 4 + maxLabel + 2 + maxRule + 2)}${ANSI.dim}Hint: ${f.hint}${ANSI.reset}`;
      }
      lines.push(line);
    }
    lines.push("");
  }

  let errors = 0, warnings = 0, infos = 0;
  for (const f of findings) {
    if (f.severity === "error") errors++;
    else if (f.severity === "warn") warnings++;
    else infos++;
  }
  const summaryParts: string[] = [];
  if (errors > 0) summaryParts.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
  if (warnings > 0) summaryParts.push(`${warnings} ${warnings === 1 ? "warning" : "warnings"}`);
  if (infos > 0) summaryParts.push(`${infos} ${infos === 1 ? "info" : "infos"}`);
  if (summaryParts.length > 0) {
    lines.push(summaryParts.join(", "));
  }

  if (result.internalErrors.length > 0) {
    lines.push("");
    lines.push(`${ANSI.bold}Internal errors:${ANSI.reset}`);
    for (const ie of result.internalErrors) {
      lines.push(`  ${colorFor("error")}${ie.ruleId}${ANSI.reset}: ${ie.message}`);
    }
  }

  const out = lines.join("\n");
  return opts.noColor ? strip(out) : out;
}
