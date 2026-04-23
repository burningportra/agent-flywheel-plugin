import type { ToolContext, McpToolResult, ReviewArgs } from '../types.js';
export declare const AUTOFIX_GATE_HINT = "Autofix refuses when the tree is dirty or the doctor is not green. Stash/commit local changes, run `flywheel_doctor`, then retry \u2014 or fall back to mode=\"interactive\".";
export declare const HEADLESS_EXIT_HINT = "Headless mode returns error code \"review_headless_findings\" with details.findingCount when reviewers surface non-zero issues. CI wrappers should branch on structuredContent?.data?.error?.code and use details.exitCode (1 = findings, 2 = reviewer crash).";
/**
 * flywheel_review — Submit implementation work for review.
 *
 * action="hit-me"    — Return parallel review agent task specs for CC to spawn
 * action="looks-good"— Mark bead done, advance to next or enter gates
 * action="skip"      — Skip this bead (mark deferred), move to next
 */
export declare function runReview(ctx: ToolContext, args: ReviewArgs): Promise<McpToolResult>;
//# sourceMappingURL=review.d.ts.map