import { beadCreationPrompt, formatRepoProfile, makeChoiceOption, makeNextToolStep, makeToolError, makeToolResult } from './shared.js';
/**
 * flywheel_select — Set the selected goal and transition to planning phase.
 *
 * The calling Claude agent presents ideas to the user (via conversation),
 * then calls this tool with the user's chosen goal string.
 * Returns workflow choice instructions — the agent should ask the user
 * which workflow to use (plan-first, deep-plan, or direct-to-beads).
 */
export async function runSelect(ctx, args) {
    const { state, saveState, cwd } = ctx;
    if (!args.goal || !args.goal.trim()) {
        return makeToolError('flywheel_select', state.phase, 'invalid_input', 'Error: goal parameter is required and must be non-empty.');
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
Call \`flywheel_plan\` with \`mode="standard"\` to generate a single plan document, then \`flywheel_approve_beads\` to review it before creating beads.

### Option B: Deep plan (multi-model triangulation)
Call \`flywheel_plan\` with \`mode="deep"\` to spawn parallel planning agents (correctness, robustness, ergonomics), synthesize their outputs, then create beads from the result.

### Option C: Direct to beads (fastest)
Skip planning — create beads directly using \`br create\` and \`br dep add\`, then call \`flywheel_approve_beads\` for approval.

---

**Ask the user which workflow they prefer, then proceed.**

### Bead creation instructions (for Option C)
${beadCreationPrompt(state.selectedGoal, repoContext, state.constraints)}`;
    return makeToolResult(text, {
        tool: 'flywheel_select',
        version: 1,
        status: 'ok',
        phase: state.phase,
        goal: state.selectedGoal,
        nextStep: makeNextToolStep('present_choices', 'Choose a workflow for the selected goal.', {
            options: [
                makeChoiceOption('plan-first', 'Plan first', {
                    description: 'Generate a single plan document with flywheel_plan mode="standard".',
                    tool: 'flywheel_plan',
                    args: { mode: 'standard' },
                }),
                makeChoiceOption('deep-plan', 'Deep plan', {
                    description: 'Generate parallel planning perspectives with flywheel_plan mode="deep".',
                    tool: 'flywheel_plan',
                    args: { mode: 'deep' },
                }),
                makeChoiceOption('direct-to-beads', 'Direct to beads', {
                    description: 'Skip planning and create beads directly with br create / br dep add.',
                }),
            ],
        }),
        data: {
            kind: 'goal_selected',
            goal: state.selectedGoal,
            constraints: state.constraints,
            workflowOptions: ['plan-first', 'deep-plan', 'direct-to-beads'],
            hasRepoProfile: state.repoProfile !== undefined,
        },
    });
}
//# sourceMappingURL=select.js.map