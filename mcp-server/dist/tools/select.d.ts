import type { ToolContext, McpToolResult, SelectArgs } from '../types.js';
/**
 * flywheel_select — Set the selected goal and transition to planning phase.
 *
 * The calling Claude agent presents ideas to the user (via conversation),
 * then calls this tool with the user's chosen goal string.
 * Returns workflow choice instructions — the agent should ask the user
 * which workflow to use (plan-first, deep-plan, or direct-to-beads).
 *
 * v3.13.0 (T13 / claude-orchestrator-3l7): captures `state.cycleStartSha`
 * (used by `gradeOutcome`'s 4-tier fallback ladder) and resets the
 * per-cycle outcome-grading fields so a new goal does not inherit a stale
 * rubric path, skip-flag, or grading history.
 */
export declare function runSelect(ctx: ToolContext, args: SelectArgs): Promise<McpToolResult>;
//# sourceMappingURL=select.d.ts.map