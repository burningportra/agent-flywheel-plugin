import type { ToolContext, McpToolResult, PlanArgs } from '../types.js';
/**
 * flywheel_plan — Generate a plan document for the selected goal.
 *
 * mode="standard": Returns a prompt for the agent to generate a single plan
 * mode="deep": Returns spawn configs for 3 parallel planning agents (correctness, robustness, ergonomics)
 *              If planContent is provided, uses it directly to create beads.
 */
export declare function runPlan(ctx: ToolContext, args: PlanArgs): Promise<McpToolResult>;
//# sourceMappingURL=plan.d.ts.map