import type { LintOptions, LintResult } from "./types.js";

export type {
  Finding,
  Rule,
  Severity,
  LintOptions,
  LintResult,
  Document,
  RuleContext,
  Span,
} from "./types.js";
export { createLintLogger } from "./logger.js";
export type { LintLogger } from "./logger.js";
export { LintConfigSchema, type LintConfig } from "./config.js";

/**
 * Lint a SKILL.md source. Stub for T1 — populated by T2 (parser) + T4-T7 (rules) + T9 (rule isolation).
 */
export async function lint(_source: string, _opts: LintOptions): Promise<LintResult> {
  return { findings: [], internalErrors: [] };
}

/**
 * Hermetic helper for rule-author tests. Returns findings synchronously (rule isolation in T9 will make this async).
 */
export function lintString(
  _source: string,
  _filename: string,
  _opts: Partial<LintOptions> = {},
): never {
  throw new Error("not implemented; T2 + T4-T7 will populate via lint()");
}
