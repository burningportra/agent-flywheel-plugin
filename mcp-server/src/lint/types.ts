export type Severity = "error" | "warn" | "info";

export interface Span {
  start: { line: number; column: number; offset?: number };
  end: { line: number; column: number; offset?: number };
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  hint?: string;
  /** Set by baseline subtraction; do not produce findings with rulesetVersion explicit upstream. */
  rulesetVersion?: number;
}

export interface RuleContext {
  filePath: string;
  source: string;
}

export interface Rule {
  id: string;
  description: string;
  severity: Severity;
  check(doc: Document, ctx: RuleContext): Finding[] | Promise<Finding[]>;
}

/** Document tree placeholder — populated by parser in T2. */
export interface Document {
  source: string;
  filePath: string;
  /** Other fields added by T2; keep open-ended for now. */
  [key: string]: unknown;
}

export interface LintOptions {
  filePath: string;
  rules?: Rule[];
  /** When true, use only manifest + repo-local skills (skip ~/.claude/plugins). */
  ci?: boolean;
}

export interface LintResult {
  findings: Finding[];
  /** Internal errors (rules that threw or timed out). Aggregated separately from findings. */
  internalErrors: Array<{ ruleId: string; message: string }>;
}
