import type { ToolContext, McpToolResult, ReviewArgs } from '../types.js';
/**
 * flywheel_review — Submit implementation work for review.
 *
 * action="hit-me"    — Return parallel review agent task specs for CC to spawn
 * action="looks-good"— Mark bead done, advance to next or enter gates
 * action="skip"      — Skip this bead (mark deferred), move to next
 */
export declare function runReview(ctx: ToolContext, args: ReviewArgs): Promise<McpToolResult>;
//# sourceMappingURL=review.d.ts.map