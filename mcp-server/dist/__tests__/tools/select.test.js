import { describe, it, expect } from 'vitest';
import { runSelect } from '../../tools/select.js';
import { createMockExec, makeState } from '../helpers/mocks.js';
// ─── Helpers ──────────────────────────────────────────────────
function makeRepoProfile(overrides = {}) {
    return {
        name: 'myrepo',
        languages: ['TypeScript'],
        frameworks: [],
        structure: '',
        entrypoints: [],
        recentCommits: [],
        hasTests: true,
        hasDocs: false,
        hasCI: false,
        todos: [],
        keyFiles: {},
        ...overrides,
    };
}
function makeCtx(stateOverrides = {}) {
    const exec = createMockExec();
    const state = makeState({ repoProfile: makeRepoProfile(), ...stateOverrides });
    const saved = [];
    const ctx = {
        exec,
        cwd: '/fake/cwd',
        state,
        saveState: (s) => { saved.push(structuredClone(s)); },
        clearState: () => { },
    };
    return { ctx, state, saved };
}
// ─── Tests ────────────────────────────────────────────────────
describe('runSelect', () => {
    it('sets state.selectedGoal to the provided goal', async () => {
        const { ctx, state } = makeCtx();
        await runSelect(ctx, { cwd: '/fake/cwd', goal: 'Add rate limiting' });
        expect(state.selectedGoal).toBe('Add rate limiting');
    });
    it('trims whitespace from goal', async () => {
        const { ctx, state } = makeCtx();
        await runSelect(ctx, { cwd: '/fake/cwd', goal: '  Add rate limiting  ' });
        expect(state.selectedGoal).toBe('Add rate limiting');
    });
    it('transitions phase to planning', async () => {
        const { ctx, state } = makeCtx();
        await runSelect(ctx, { cwd: '/fake/cwd', goal: 'Add rate limiting' });
        expect(state.phase).toBe('planning');
    });
    it('calls saveState with updated state', async () => {
        const { ctx, saved } = makeCtx();
        await runSelect(ctx, { cwd: '/fake/cwd', goal: 'Improve performance' });
        expect(saved.length).toBe(1);
        expect(saved[0].selectedGoal).toBe('Improve performance');
        expect(saved[0].phase).toBe('planning');
    });
    it('initializes constraints to empty array if not set', async () => {
        const { ctx, state } = makeCtx();
        // The default makeState already has constraints: [], but test the ||= path
        state.constraints = undefined;
        await runSelect(ctx, { cwd: '/fake/cwd', goal: 'Add logging' });
        expect(state.constraints).toEqual([]);
    });
    it('preserves existing constraints', async () => {
        const { ctx, state } = makeCtx({ constraints: ['no breaking changes', 'must support Node 18'] });
        await runSelect(ctx, { cwd: '/fake/cwd', goal: 'Refactor auth' });
        expect(state.constraints).toEqual(['no breaking changes', 'must support Node 18']);
    });
    it('returns workflow options in text output', async () => {
        const { ctx } = makeCtx();
        const result = await runSelect(ctx, { cwd: '/fake/cwd', goal: 'Add tests' });
        const text = result.content[0].text;
        expect(text).toContain('Option A');
        expect(text).toContain('Option B');
        expect(text).toContain('Option C');
        expect(text).toContain('flywheel_plan');
    });
    it('includes the goal in the response text', async () => {
        const { ctx } = makeCtx();
        const result = await runSelect(ctx, { cwd: '/fake/cwd', goal: 'Implement caching layer' });
        expect(result.content[0].text).toContain('Implement caching layer');
    });
    it('includes constraints in response when present', async () => {
        const { ctx } = makeCtx({ constraints: ['must use Redis'] });
        const result = await runSelect(ctx, { cwd: '/fake/cwd', goal: 'Add caching' });
        expect(result.content[0].text).toContain('must use Redis');
    });
    it('includes repo profile info in response when repoProfile exists', async () => {
        const { ctx } = makeCtx();
        const result = await runSelect(ctx, { cwd: '/fake/cwd', goal: 'Improve DX' });
        const text = result.content[0].text;
        expect(text).toContain('myrepo');
        expect(text).toContain('TypeScript');
    });
    it('returns error when goal is empty string', async () => {
        const { ctx } = makeCtx();
        const result = await runSelect(ctx, { cwd: '/fake/cwd', goal: '' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('goal parameter is required');
    });
    it('returns error when goal is whitespace only', async () => {
        const { ctx } = makeCtx();
        const result = await runSelect(ctx, { cwd: '/fake/cwd', goal: '   ' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('goal parameter is required');
    });
    it('does not mutate state on error', async () => {
        const { ctx, state } = makeCtx();
        const originalPhase = state.phase;
        await runSelect(ctx, { cwd: '/fake/cwd', goal: '' });
        expect(state.phase).toBe(originalPhase);
        expect(state.selectedGoal).toBeUndefined();
    });
    it('includes bead creation prompt in the output', async () => {
        const { ctx } = makeCtx();
        const result = await runSelect(ctx, { cwd: '/fake/cwd', goal: 'Build API' });
        const text = result.content[0].text;
        expect(text).toContain('Bead Creation Instructions');
        expect(text).toContain('br create');
    });
    it('works without a repoProfile on state', async () => {
        const { ctx } = makeCtx();
        ctx.state.repoProfile = undefined;
        const result = await runSelect(ctx, { cwd: '/fake/cwd', goal: 'Quick fix' });
        // Should still succeed — select doesn't require repoProfile
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain('Quick fix');
        expect(ctx.state.phase).toBe('planning');
    });
    it('returns structuredContent for successful goal selection', async () => {
        const { ctx } = makeCtx({ constraints: ['must be backward compatible'] });
        const result = await runSelect(ctx, { cwd: '/fake/cwd', goal: 'Add tests' });
        expect(result.structuredContent).toEqual({
            tool: 'flywheel_select',
            version: 1,
            status: 'ok',
            phase: 'planning',
            goal: 'Add tests',
            nextStep: {
                type: 'present_choices',
                message: 'Choose a workflow for the selected goal.',
                options: [
                    {
                        id: 'plan-first',
                        label: 'Plan first',
                        description: 'Generate a single plan document with flywheel_plan mode="standard".',
                        tool: 'flywheel_plan',
                        args: { mode: 'standard' },
                    },
                    {
                        id: 'deep-plan',
                        label: 'Deep plan',
                        description: 'Generate parallel planning perspectives with flywheel_plan mode="deep".',
                        tool: 'flywheel_plan',
                        args: { mode: 'deep' },
                    },
                    {
                        id: 'direct-to-beads',
                        label: 'Direct to beads',
                        description: 'Skip planning and create beads directly with br create / br dep add.',
                    },
                ],
            },
            data: {
                kind: 'goal_selected',
                goal: 'Add tests',
                constraints: ['must be backward compatible'],
                workflowOptions: ['plan-first', 'deep-plan', 'direct-to-beads'],
                hasRepoProfile: true,
            },
        });
    });
    it('returns structuredContent for invalid goal errors', async () => {
        const { ctx } = makeCtx();
        const result = await runSelect(ctx, { cwd: '/fake/cwd', goal: '   ' });
        expect(result.structuredContent).toMatchObject({
            tool: 'flywheel_select',
            version: 1,
            status: 'error',
            phase: 'idle',
            data: {
                kind: 'error',
                error: {
                    code: 'invalid_input',
                    message: 'Error: goal parameter is required and must be non-empty.',
                },
            },
        });
    });
});
//# sourceMappingURL=select.test.js.map