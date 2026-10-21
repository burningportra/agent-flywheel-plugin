import type { ToolContext, McpToolResult, ReviewArgs } from '../types.js';
export declare const AUTOFIX_GATE_HINT = "Autofix refuses when the tree is dirty or the doctor is not green. Stash/commit local changes, run `flywheel_doctor`, then retry \u2014 or fall back to mode=\"interactive\".";
export declare const HEADLESS_EXIT_HINT = "Complete headless mode with action=\"report\", findingCount, and crashed. CI wrappers should treat a clean result as exit 0, or branch on error code \"review_headless_findings\" and use details.exitCode (1 = findings, 2 = reviewer crash).";
/**
 * flywheel_review — Submit implementation work for review.
 *
 * action="hit-me"    — Return parallel review agent task specs for CC to spawn
 * action="looks-good"— Mark bead done, advance to next or enter gates
 * action="skip"      — Skip this bead (mark deferred), move to next
 * action="report"    — Complete headless review with an aggregated CI signal
 */
export declare function runReview(ctx: ToolContext, args: ReviewArgs): Promise<McpToolResult>;
export declare const MAX_FRESH_EYES_ROUNDS = 5;
export declare const CLEAN_STREAK_TARGET = 2;
export interface ReviewIteration {
    round: number;
    cleanStreak: number;
    converged: boolean;
    lastFindingCount: number;
}
export type ModelFamily = 'claude' | 'pi' | 'gemini' | 'codex' | 'unknown';
//# sourceMappingURL=review.d.ts.map