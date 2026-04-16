import type { LintOptions, LintResult, Rule } from "./types.js";
export type { Finding, Rule, Severity, LintOptions, LintResult, Document, RuleContext, Span, ParsedDocument, AskUserQuestionCall, AuqQuestion, AuqOption, SlashRef, PlaceholderTag, DocumentHeader, FenceInfo, } from "./types.js";
export { createLintLogger } from "./logger.js";
export type { LintLogger } from "./logger.js";
export { LintConfigSchema, type LintConfig } from "./config.js";
export { computeExitCode, EXIT_CLEAN, EXIT_FINDINGS, EXIT_INTERNAL, EXIT_INVALID_ARGS, EXIT_FILE_ERROR, } from "./exitCodes.js";
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
export declare function lint(opts: ExtendedLintOptions): Promise<LintResult>;
//# sourceMappingURL=index.d.ts.map