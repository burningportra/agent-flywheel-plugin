import type { LintOptions, LintResult, ParsedDocument, Rule, RuleContext } from "./types.js";
import { parse } from "./parser.js";
import { runRule } from "./runRule.js";

export type {
  Finding,
  Rule,
  Severity,
  LintOptions,
  LintResult,
  Document,
  RuleContext,
  Span,
  ParsedDocument,
  AskUserQuestionCall,
  AuqQuestion,
  AuqOption,
  SlashRef,
  PlaceholderTag,
  DocumentHeader,
  FenceInfo,
} from "./types.js";
export { createLintLogger } from "./logger.js";
export type { LintLogger } from "./logger.js";
export { LintConfigSchema, type LintConfig } from "./config.js";
export {
  computeExitCode,
  EXIT_CLEAN,
  EXIT_FINDINGS,
  EXIT_INTERNAL,
  EXIT_INVALID_ARGS,
  EXIT_FILE_ERROR,
} from "./exitCodes.js";
export { runRule, type RunRuleResult, type RunRuleOptions } from "./runRule.js";

export interface ExtendedLintOptions extends LintOptions {
  source: string;
  /** Rules to run. Caller supplies these (T11 CLI wires the standard set). */
  rules?: Rule[];
  /** Per-rule timeout. Default 5000. */
  ruleTimeoutMs?: number;
  /** Extra context fields rules may need (e.g., skill registry for SLASH001). */
  ruleContextExtras?: Record<string, unknown>;
}

export async function lint(opts: ExtendedLintOptions): Promise<LintResult> {
  const parsed: ParsedDocument = await parse(opts.source, opts.filePath);
  const result: LintResult = {
    findings: parsed.parserFindings.slice(),
    internalErrors: [],
  };
  const ctx: RuleContext & Record<string, unknown> = {
    filePath: opts.filePath,
    source: opts.source,
    ...(opts.ruleContextExtras ?? {}),
  };
  for (const rule of opts.rules ?? []) {
    const rr = await runRule(rule, parsed, ctx, { timeoutMs: opts.ruleTimeoutMs });
    result.findings.push(...rr.findings);
    if (rr.internalError) result.internalErrors.push(rr.internalError);
  }
  return result;
}
