import type { Rule, RuleContext } from "../types.js";
/**
 * RESERVE001 — direct `agentMailRPC("file_reservation_paths")` calls must
 * route through `reserveOrFail()` in `mcp-server/src/agent-mail-helpers.ts`.
 *
 * Why this rule exists: AGENTS.md "Known issue" documents that agent-mail's
 * server-side enforcement is advisory — the second exclusive request returns
 * a response with both `granted` and `conflicts` populated. The `reserveOrFail`
 * helper (T4) codifies the mitigation. This rule prevents new direct call
 * sites from sneaking past code review.
 *
 * Cross-file rule: ignores its `Document` (a parsed SKILL.md) and walks
 * `<repoRoot>/mcp-server/src/**\/*.ts` itself. Receives `repoRoot` from
 * `ctx.repoRoot` (passed in `ruleContextExtras` by the CLI).
 *
 * Severity is `warn` initially per the duel-plan T5 rollout (promote to
 * `error` after one release cycle).
 */
export interface Reserve001Context extends RuleContext {
    repoRoot?: string;
    /** Override scan root (tests inject this to point at fixture trees). */
    srcRoot?: string;
    /** Override allowlist (tests inject this for fixture-based behaviour). */
    allowlist?: string[];
}
export declare const reserve001: Rule;
export default reserve001;
//# sourceMappingURL=reserve001.d.ts.map