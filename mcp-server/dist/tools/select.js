import { createLogger } from '../logger.js';
import { beadCreationPrompt, formatRepoProfile, makeChoiceOption, makeNextToolStep, makeToolError, makeToolResult } from './shared.js';
const log = createLogger('select');
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
export async function runSelect(ctx, args) {
    const { exec, state, saveState, cwd, signal } = ctx;
    if (!args.goal || !args.goal.trim()) {
        return makeToolError('flywheel_select', state.phase, 'invalid_input', 'Error: goal parameter is required and must be non-empty.', {
            hint: 'Pass a non-empty goal string describing the selected idea to implement.',
        });
    }
    state.selectedGoal = args.goal.trim();
    state.phase = 'planning';
    state.constraints = state.constraints || [];
    // ── v3.13.0 outcome-grading: cycle boundary reset ──
    // Capture the git HEAD as the cycle-start SHA. The `gradeOutcome` 4-tier
    // recovery ladder (state → checkpoint.gitHead → git-log-by-time → HEAD~50)
    // protects against missing values, so a probe failure here is non-fatal —
    // we leave `cycleStartSha` undefined and let the ladder fire at grade time.
    // Outcome-grading per-cycle fields are reset so a new goal never inherits
    // the prior cycle's rubric path, skip flag, or grading history.
    state.cycleStartSha = await captureCycleStartSha(exec, cwd, signal);
    state.outcomeRubricPath = undefined;
    state.outcomeGradingSkipped = undefined;
    state.outcomeGradingHistory = undefined;
    state.cycleEndTestOutput = undefined;
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
/**
 * Read `git rev-parse HEAD` from the project working tree. Returns the
 * trimmed sha on success, `undefined` on any failure (detached HEAD, no
 * commits, missing git, exec timeout). The grader's 4-tier fallback
 * ladder picks up the slack — see `gradeOutcome` (T6).
 */
async function captureCycleStartSha(exec, cwd, signal) {
    try {
        const res = await exec('git', ['rev-parse', 'HEAD'], { cwd, timeout: 5000, signal });
        if (res.code !== 0) {
            log.debug('cycleStartSha probe non-zero exit', { exitCode: res.code, stderr: res.stderr.trim() });
            return undefined;
        }
        const sha = res.stdout.trim();
        return sha.length > 0 ? sha : undefined;
    }
    catch (err) {
        log.debug('cycleStartSha probe threw', { err: err instanceof Error ? err.message : String(err) });
        return undefined;
    }
}
//# sourceMappingURL=select.js.map