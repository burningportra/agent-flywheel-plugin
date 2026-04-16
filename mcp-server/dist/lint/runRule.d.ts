import type { Document, Finding, Rule, RuleContext } from "./types.js";
export interface RunRuleResult {
    findings: Finding[];
    internalError?: {
        ruleId: string;
        message: string;
    };
}
export interface RunRuleOptions {
    /** Hard timeout in ms. Default 5000. */
    timeoutMs?: number;
    /** AbortSignal optionally forwarded. */
    signal?: AbortSignal;
}
/**
 * Run a single rule with isolation + timeout. Never throws.
 * - try/catch around rule.check(): caught errors become internalError.
 * - Promise.race with timeout: timeout becomes internalError.
 */
export declare function runRule(rule: Rule, doc: Document, ctx: RuleContext, opts?: RunRuleOptions): Promise<RunRuleResult>;
//# sourceMappingURL=runRule.d.ts.map