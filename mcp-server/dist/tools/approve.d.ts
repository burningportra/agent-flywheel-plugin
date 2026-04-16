import type { ToolContext, McpToolResult, ApproveArgs } from '../types.js';
/**
 * flywheel_approve_beads — Review and approve bead graph before implementation.
 *
 * action="start"    — Approve beads and launch implementation
 * action="polish"   — Request another refinement round
 * action="reject"   — Reject and stop the flywheel
 * action="advanced" — Advanced refinement (requires advancedAction param)
 */
export declare function runApprove(ctx: ToolContext, args: ApproveArgs): Promise<McpToolResult>;
//# sourceMappingURL=approve.d.ts.map