import type { ToolContext, McpToolResult, PlanArgs } from '../types.js';
export interface PreCodeResearchChecklist {
    architecture?: boolean;
    dependencies?: boolean;
    security?: boolean;
    performance?: boolean;
}
export type PotetoPlanArgs = PlanArgs & {
    /** Poteto mode: planning needs the interrogation and ADR documents first. */
    poteto?: boolean;
    /** Every area must be `true`; a missing area counts as not researched. */
    preCodeResearch?: PreCodeResearchChecklist;
};
/**
 * flywheel_plan — Generate a plan document for the selected goal.
 *
 * mode="standard": Returns a prompt for the agent to generate a single plan
 * mode="deep": Returns spawn configs for 3 parallel planning agents (correctness, robustness, ergonomics)
 *              If planContent is provided, uses it directly to create beads.
 * mode="duel":  Returns instructions to invoke /dueling-idea-wizards --mode=architecture for 2-agent
 *               adversarial planning (CC + COD/GMI cross-scoring). Synthesis lands at
 *               docs/plans/<date>-<slug>-duel.md and is registered via planFile on the next call.
 *
 * ambition is orthogonal to mode. "scoped" (default) plans the goal as asked; "ambitious" requires the
 * charter at docs/brainstorms/<slug>-<date>-ambition.md and injects it, with fixed ambitious-plan
 * requirements, into whichever generator the mode picks. planFile/planContent registration ignores it.
 */
export declare function runPlan(ctx: ToolContext, args: PotetoPlanArgs): Promise<McpToolResult>;
//# sourceMappingURL=plan.d.ts.map