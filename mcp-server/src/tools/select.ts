import type { ToolContext, McpToolResult } from '../types.js';
import { beadCreationPrompt, formatRepoProfile } from './shared.js';

interface SelectArgs {
  cwd: string;
  goal: string;
}

/**
 * orch_select — Set the selected goal and transition to planning phase.
 *
 * The calling Claude agent presents ideas to the user (via conversation),
 * then calls this tool with the user's chosen goal string.
 * Returns workflow choice instructions — the agent should ask the user
 * which workflow to use (plan-first, deep-plan, or direct-to-beads).
 */
export async function runSelect(ctx: ToolContext, args: SelectArgs): Promise<McpToolResult> {
  const { state, saveState, cwd } = ctx;

  if (!args.goal || !args.goal.trim()) {
    return {
      content: [{ type: 'text', text: 'Error: goal parameter is required and must be non-empty.' }],
      isError: true,
    };
  }

  state.selectedGoal = args.goal.trim();
  state.phase = 'planning';
  state.constraints = state.constraints || [];
  saveState(state);

  const repoContext = state.repoProfile ? formatRepoProfile(state.repoProfile) : '';
  const constraintsSummary = state.constraints.length > 0
    ? `\nConstraints: ${state.constraints.join(', ')}`
    : '';

  const text = `**Goal selected:** "${state.selectedGoal}"${constraintsSummary}

**NEXT: Choose a workflow and call the appropriate tool:**

### Option A: Plan first (recommended for complex goals)
Call \`orch_plan\` with \`mode="standard"\` to generate a single plan document, then \`orch_approve_beads\` to review it before creating beads.

### Option B: Deep plan (multi-model triangulation)
Call \`orch_plan\` with \`mode="deep"\` to spawn parallel planning agents (correctness, robustness, ergonomics), synthesize their outputs, then create beads from the result.

### Option C: Direct to beads (fastest)
Skip planning — create beads directly using \`br create\` and \`br dep add\`, then call \`orch_approve_beads\` for approval.

---

**Ask the user which workflow they prefer, then proceed.**

### Bead creation instructions (for Option C)
${beadCreationPrompt(state.selectedGoal, repoContext, state.constraints)}`;

  return { content: [{ type: 'text', text }] };
}
