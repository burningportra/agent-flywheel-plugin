import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockExec, makeState } from '../helpers/mocks.js';
// ─── Helpers ──────────────────────────────────────────────────
function makeBead(overrides = {}) {
    return {
        id: 'bead-1',
        title: 'Add tests',
        description: 'Write unit tests for the core module.\n\nWHAT: test coverage\nWHY: reliability\nHOW: src/core.test.ts',
        status: 'open',
        priority: 2,
        type: 'task',
        labels: [],
        ...overrides,
    };
}
function makeExecCalls(beads = [makeBead()], readyBeads) {
    return [
        {
            cmd: 'br',
            args: ['list', '--json'],
            result: { code: 0, stdout: JSON.stringify(beads), stderr: '' },
        },
        {
            cmd: 'br',
            args: ['ready', '--json'],
            result: { code: 0, stdout: JSON.stringify(readyBeads ?? beads), stderr: '' },
        },
        // update calls for marking beads as in_progress
        ...beads.map(b => ({
            cmd: 'br',
            args: ['update', b.id, '--status', 'in_progress'],
            result: { code: 0, stdout: '', stderr: '' },
        })),
    ];
}
function makeCtx(stateOverrides = {}, execCalls = makeExecCalls(), cwd = '/fake/cwd') {
    const exec = createMockExec(execCalls);
    const state = makeState({
        selectedGoal: 'Improve testing',
        phase: 'awaiting_bead_approval',
        ...stateOverrides,
    });
    const saved = [];
    const ctx = {
        exec,
        cwd,
        state,
        saveState: (s) => { saved.push(structuredClone(s)); },
        clearState: () => { },
    };
    return { ctx, state, saved };
}
// We need to isolate modules because approve.ts has module-level _lastBeadSnapshot state
async function importApprove() {
    const mod = await import('../../tools/approve.js');
    return mod.runApprove;
}
// ─── Tests ────────────────────────────────────────────────────
describe('runApprove', () => {
    let runApprove;
    beforeEach(async () => {
        vi.resetModules();
        runApprove = await importApprove();
    });
    // ── Error cases ──────────────────────────────────────────────
    it('returns error when no selectedGoal', async () => {
        const { ctx } = makeCtx({ selectedGoal: undefined });
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('No goal selected');
    });
    it('returns error when br list fails', async () => {
        const { ctx } = makeCtx({}, [
            { cmd: 'br', args: ['list', '--json'], result: { code: 1, stdout: '', stderr: 'br not found' } },
        ]);
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Error reading beads');
        expect(result.structuredContent).toMatchObject({
            tool: 'flywheel_approve_beads',
            version: 1,
            status: 'error',
            phase: 'awaiting_bead_approval',
            approvalTarget: 'beads',
            data: {
                kind: 'error',
                error: {
                    code: 'cli_failure',
                    message: expect.stringContaining('Error reading beads'),
                    retryable: true,
                    details: {
                        command: 'br list --json',
                        stderr: 'br not found',
                    },
                },
            },
        });
    });
    it('returns error when br list returns invalid JSON', async () => {
        const { ctx } = makeCtx({}, [
            { cmd: 'br', args: ['list', '--json'], result: { code: 0, stdout: 'not json', stderr: '' } },
        ]);
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Could not parse');
    });
    it('returns guidance when no open beads found', async () => {
        const closedBead = makeBead({ status: 'closed' });
        const { ctx } = makeCtx({}, [
            { cmd: 'br', args: ['list', '--json'], result: { code: 0, stdout: JSON.stringify([closedBead]), stderr: '' } },
        ]);
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        expect(result.content[0].text).toContain('No open beads found');
    });
    // ── action=reject ────────────────────────────────────────────
    it('resets state on reject', async () => {
        const { ctx, state } = makeCtx();
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'reject' });
        expect(state.phase).toBe('idle');
        expect(result.content[0].text).toContain('Beads rejected');
    });
    // ── action=polish ────────────────────────────────────────────
    it('transitions to refining_beads on polish', async () => {
        const { ctx, state } = makeCtx();
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'polish' });
        expect(state.phase).toBe('refining_beads');
        expect(result.content[0].text).toContain('Review and refine');
        expect(result.structuredContent).toEqual({
            tool: 'flywheel_approve_beads',
            version: 1,
            status: 'ok',
            phase: 'refining_beads',
            approvalTarget: 'beads',
            nextStep: {
                type: 'present_choices',
                message: 'Refine the bead graph, then either approve implementation or request another bead refinement pass.',
                options: [
                    {
                        id: 'approve-beads-start',
                        label: 'Approve beads and launch implementation',
                        tool: 'flywheel_approve_beads',
                        args: { action: 'start' },
                    },
                    {
                        id: 'approve-beads-polish',
                        label: 'Request another bead refinement round',
                        tool: 'flywheel_approve_beads',
                        args: { action: 'polish' },
                    },
                ],
            },
            data: {
                kind: 'bead_refinement_requested',
                action: 'polish',
                refinementMode: 'same-agent',
                activeBeadIds: ['bead-1'],
                convergence: {
                    round: 0,
                    changes: [],
                    converged: false,
                    score: undefined,
                },
                quality: {
                    score: expect.any(Number),
                    summary: expect.stringContaining('Bead quality'),
                },
                matrix: expect.objectContaining({
                    version: 1,
                    recommendation: expect.stringMatching(/^(swarm|coordinator-serial)$/),
                }),
                advancedActions: ['fresh-agent', 'same-agent', 'blunder-hunt', 'dedup', 'cross-model', 'graph-fix'],
            },
        });
    });
    // ── action=start ─────────────────────────────────────────────
    it('transitions to implementing on start', async () => {
        const bead = makeBead();
        const { ctx, state } = makeCtx({}, makeExecCalls([bead]));
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        expect(state.phase).toBe('implementing');
        expect(state.currentBeadId).toBe('bead-1');
        expect(result.content[0].text).toContain('Beads approved');
        expect(result.structuredContent).toEqual({
            tool: 'flywheel_approve_beads',
            version: 1,
            status: 'ok',
            phase: 'implementing',
            approvalTarget: 'beads',
            nextStep: {
                type: 'call_tool',
                message: 'Implement the ready bead, then call flywheel_review with its summary.',
                tool: 'flywheel_review',
                argsSchemaHint: { beadId: 'string', action: 'looks-good | hit-me | skip' },
            },
            data: {
                kind: 'beads_approved',
                launchMode: 'sequential',
                readyCount: 1,
                stop_reason: 'manual_start',
                activeBeadIds: ['bead-1'],
                currentBeadId: 'bead-1',
                convergence: {
                    round: 0,
                    changes: [],
                    converged: false,
                    score: undefined,
                },
                quality: {
                    score: expect.any(Number),
                    summary: expect.stringContaining('Bead quality'),
                },
                matrix: expect.objectContaining({
                    version: 1,
                    recommendation: expect.stringMatching(/^(swarm|coordinator-serial)$/),
                }),
                readyBeads: [
                    {
                        id: 'bead-1',
                        title: 'Add tests',
                        launchInstruction: 'implement',
                        agentName: undefined,
                    },
                ],
            },
        });
    });
    it('resets beadResults and beadReviews on start', async () => {
        const bead = makeBead();
        const { ctx, state } = makeCtx({ beadResults: { old: { beadId: 'old', status: 'success', summary: 'done' } } }, makeExecCalls([bead]));
        await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        expect(state.beadResults).toEqual({});
        expect(state.beadReviews).toEqual({});
    });
    it('returns agent configs when multiple beads are ready', async () => {
        // Use distinct descriptions so hotspot matrix stays in swarm mode (no
        // coordinator-serial override). Without this, the shared 'HOW: src/core.test.ts'
        // in the default bead body would trigger the 4-option menu.
        const beads = [
            makeBead({ id: 'bead-1', title: 'First task', description: 'WHAT: task 1\nWHY: reliability\nHOW: src/first.ts' }),
            makeBead({ id: 'bead-2', title: 'Second task', description: 'WHAT: task 2\nWHY: reliability\nHOW: src/second.ts' }),
        ];
        const { ctx } = makeCtx({}, makeExecCalls(beads));
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        const text = result.content[0].text;
        expect(text).toContain('Spawn 2 parallel agents');
        expect(text).toContain('bead-1');
        expect(text).toContain('bead-2');
        expect(result.structuredContent).toEqual({
            tool: 'flywheel_approve_beads',
            version: 1,
            status: 'ok',
            phase: 'implementing',
            approvalTarget: 'beads',
            nextStep: {
                type: 'spawn_agents',
                message: 'Spawn one implementation agent per ready bead, then call flywheel_review for each completed bead.',
            },
            data: {
                kind: 'beads_approved',
                launchMode: 'parallel',
                readyCount: 2,
                stop_reason: 'manual_start',
                activeBeadIds: ['bead-1', 'bead-2'],
                currentBeadId: 'bead-1',
                convergence: {
                    round: 0,
                    changes: [],
                    converged: false,
                    score: undefined,
                },
                quality: {
                    score: expect.any(Number),
                    summary: expect.stringContaining('Bead quality'),
                },
                matrix: expect.objectContaining({
                    version: 1,
                    recommendation: 'swarm',
                }),
                readyBeads: [
                    {
                        id: 'bead-1',
                        title: 'First task',
                        launchInstruction: 'spawn-agent',
                        agentName: 'bead-bead-1',
                    },
                    {
                        id: 'bead-2',
                        title: 'Second task',
                        launchInstruction: 'spawn-agent',
                        agentName: 'bead-bead-2',
                    },
                ],
            },
        });
    });
    it('falls back to first 3 beads when br ready fails', async () => {
        const beads = [
            makeBead({ id: 'bead-1', title: 'First' }),
            makeBead({ id: 'bead-2', title: 'Second' }),
            makeBead({ id: 'bead-3', title: 'Third' }),
        ];
        const execCalls = [
            { cmd: 'br', args: ['list', '--json'], result: { code: 0, stdout: JSON.stringify(beads), stderr: '' } },
            { cmd: 'br', args: ['ready', '--json'], result: { code: 1, stdout: '', stderr: 'br ready failed' } },
            ...beads.map(b => ({
                cmd: 'br',
                args: ['update', b.id, '--status', 'in_progress'],
                result: { code: 0, stdout: '', stderr: '' },
            })),
        ];
        const { ctx, state } = makeCtx({}, execCalls);
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        expect(state.phase).toBe('implementing');
        expect(result.content[0].text).toContain('Beads approved');
        // Should have used the fallback (first 3 beads)
        expect(result.content[0].text).toContain('bead-1');
    });
    it('includes bead quality score in output on start', async () => {
        const bead = makeBead();
        const { ctx } = makeCtx({}, makeExecCalls([bead]));
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        // P1.1 (3rt): Quality is now a sub-headline beside Convergence (or the
        // sole headline when convergence is undefined). The structuredContent
        // still carries `quality.summary` for tooling.
        expect(result.content[0].text).toContain('Quality');
        const sc = result.structuredContent;
        const data = sc?.data;
        expect(data?.quality).toMatchObject({ score: expect.any(Number) });
    });
    // P1.1 (3rt): Convergence is the headline polish metric, not the
    // weak-3 quality heuristic that plateaus while the bead set converges.
    it('renders Convergence as the headline metric when score is defined (3rt)', async () => {
        const bead = makeBead();
        const calls = makeExecCalls([bead]);
        // Seed enough polish history to trigger convergence computation
        // (>=3 polishChanges entries is the threshold in handleStart).
        const { ctx } = makeCtx({
            polishRound: 3,
            polishChanges: [3, 1, 0],
            polishOutputSizes: [1000, 1100, 1100],
        }, calls);
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        const text = result.content[0].text;
        // Headline contains both metrics, with Convergence first.
        expect(text).toMatch(/Convergence \d+ \/ Quality \d+/);
        // Weak-3 list (when present) is rendered as a footnote, not headline.
        if (text.includes('weakest')) {
            expect(text).toMatch(/_3 weakest:/);
        }
    });
    it('renders Quality-only headline when convergence is undefined (3rt)', async () => {
        const bead = makeBead();
        const { ctx } = makeCtx({}, makeExecCalls([bead]));
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        const text = result.content[0].text;
        // No convergence score on first start — Quality is the sole headline.
        expect(text).toMatch(/Quality \d+/);
        expect(text).not.toMatch(/Convergence \d+/);
    });
    // ── action=advanced ──────────────────────────────────────────
    it('returns error when advancedAction is missing', async () => {
        const { ctx } = makeCtx();
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'advanced' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('advancedAction is required');
        expect(result.structuredContent).toMatchObject({
            tool: 'flywheel_approve_beads',
            version: 1,
            status: 'error',
            phase: 'awaiting_bead_approval',
            approvalTarget: 'beads',
            data: {
                kind: 'error',
                error: {
                    code: 'invalid_input',
                    message: expect.stringContaining('advancedAction is required'),
                    retryable: false,
                    details: {
                        action: 'advanced',
                        validAdvancedActions: ['fresh-agent', 'same-agent', 'blunder-hunt', 'dedup', 'cross-model', 'graph-fix'],
                    },
                },
            },
        });
    });
    it('handles blunder-hunt advancedAction', async () => {
        const { ctx, state } = makeCtx();
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'advanced', advancedAction: 'blunder-hunt' });
        expect(state.phase).toBe('refining_beads');
        expect(result.content[0].text).toContain('Blunder Hunt');
    });
    it('handles dedup advancedAction', async () => {
        const { ctx, state } = makeCtx();
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'advanced', advancedAction: 'dedup' });
        expect(state.phase).toBe('refining_beads');
        expect(result.content[0].text).toContain('deduplication');
    });
    it('handles graph-fix advancedAction', async () => {
        const { ctx, state } = makeCtx();
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'advanced', advancedAction: 'graph-fix' });
        expect(state.phase).toBe('refining_beads');
        expect(result.content[0].text).toContain('dependency graph');
        expect(result.structuredContent).toEqual({
            tool: 'flywheel_approve_beads',
            version: 1,
            status: 'ok',
            phase: 'refining_beads',
            approvalTarget: 'beads',
            nextStep: {
                type: 'run_cli',
                message: 'Diagnose and repair bead dependencies with br dep commands, then return to flywheel_approve_beads.',
            },
            data: {
                kind: 'bead_refinement_requested',
                action: 'advanced',
                refinementMode: 'graph-fix',
                activeBeadIds: ['bead-1'],
                convergence: {
                    round: 0,
                    changes: [],
                    converged: false,
                    score: undefined,
                },
                quality: {
                    score: expect.any(Number),
                    summary: expect.stringContaining('Bead quality'),
                },
                matrix: expect.objectContaining({
                    version: 1,
                    recommendation: expect.stringMatching(/^(swarm|coordinator-serial)$/),
                }),
                advancedActions: ['fresh-agent', 'same-agent', 'blunder-hunt', 'dedup', 'cross-model', 'graph-fix'],
            },
        });
    });
    it('returns unsupported_action error for unknown advancedAction', async () => {
        const { ctx } = makeCtx();
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'advanced', advancedAction: 'nope' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Unknown advancedAction');
        const sc = result.structuredContent;
        expect(sc.status).toBe('error');
        expect(sc.data.error.code).toBe('unsupported_action');
        expect(sc.data.error.details).toEqual({
            advancedAction: 'nope',
            validAdvancedActions: ['fresh-agent', 'same-agent', 'blunder-hunt', 'dedup', 'cross-model', 'graph-fix'],
        });
    });
    // ── Plan approval mode ───────────────────────────────────────
    describe('plan approval mode', () => {
        let tmpDir;
        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'approve-plan-'));
        });
        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });
        it('approves plan and transitions to creating_beads', async () => {
            const planContent = Array(120).fill('plan line').join('\n');
            writeFileSync(join(tmpDir, 'plan.md'), planContent);
            const { ctx, state } = makeCtx({ phase: 'awaiting_plan_approval', planDocument: 'plan.md' }, [], tmpDir);
            const result = await runApprove(ctx, { cwd: tmpDir, action: 'start' });
            expect(state.phase).toBe('creating_beads');
            expect(result.content[0].text).toContain('Plan approved');
            expect(result.structuredContent).toEqual({
                tool: 'flywheel_approve_beads',
                version: 1,
                status: 'ok',
                phase: 'creating_beads',
                approvalTarget: 'plan',
                nextStep: {
                    type: 'run_cli',
                    message: 'Create beads from the approved plan with br create / br dep add, then return to flywheel_approve_beads action="start".',
                },
                data: {
                    kind: 'plan_approved',
                    planDocument: 'plan.md',
                    lineCount: 120,
                    sizeAssessment: 'too_short',
                    planRefinementRound: 0,
                    readyForBeadCreation: true,
                },
            });
        });
        it('rejects plan and resets state', async () => {
            writeFileSync(join(tmpDir, 'plan.md'), '# Plan\nContent');
            const { ctx, state } = makeCtx({ phase: 'awaiting_plan_approval', planDocument: 'plan.md' }, [], tmpDir);
            const result = await runApprove(ctx, { cwd: tmpDir, action: 'reject' });
            expect(state.phase).toBe('idle');
            expect(state.planDocument).toBeUndefined();
            expect(result.content[0].text).toContain('Plan rejected');
        });
        it('polishes plan and increments refinement round', async () => {
            writeFileSync(join(tmpDir, 'plan.md'), '# Plan\nContent');
            const { ctx, state } = makeCtx({ phase: 'awaiting_plan_approval', planDocument: 'plan.md', planRefinementRound: 0 }, [], tmpDir);
            const result = await runApprove(ctx, { cwd: tmpDir, action: 'polish' });
            expect(state.phase).toBe('planning');
            expect(state.planRefinementRound).toBe(1);
            expect(result.content[0].text).toContain('Refine the plan');
            expect(result.structuredContent).toEqual({
                tool: 'flywheel_approve_beads',
                version: 1,
                status: 'ok',
                phase: 'planning',
                approvalTarget: 'plan',
                nextStep: {
                    type: 'generate_artifact',
                    message: 'Revise the existing plan document and save it back before returning to flywheel_approve_beads.',
                },
                data: {
                    kind: 'plan_refinement_requested',
                    action: 'polish',
                    planDocument: 'plan.md',
                    lineCount: 2,
                    sizeAssessment: 'too_short',
                    planRefinementRound: 1,
                    refinementModel: 'claude-opus-4-7',
                },
            });
        });
        it('returns error when plan file not found', async () => {
            const { ctx } = makeCtx({ phase: 'awaiting_plan_approval', planDocument: 'missing.md' }, [], tmpDir);
            const result = await runApprove(ctx, { cwd: tmpDir, action: 'start' });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Plan document not found');
        });
        it('handles git-diff-review action', async () => {
            writeFileSync(join(tmpDir, 'plan.md'), '# Plan\nSome content here');
            const { ctx, state } = makeCtx({ phase: 'awaiting_plan_approval', planDocument: 'plan.md', planRefinementRound: 0 }, [], tmpDir);
            const result = await runApprove(ctx, { cwd: tmpDir, action: 'git-diff-review' });
            expect(state.phase).toBe('planning');
            expect(state.planRefinementRound).toBe(1);
            expect(result.content[0].text).toContain('Git-diff review');
            expect(result.structuredContent).toEqual({
                tool: 'flywheel_approve_beads',
                version: 1,
                status: 'ok',
                phase: 'planning',
                approvalTarget: 'plan',
                nextStep: {
                    type: 'spawn_agents',
                    message: 'Run the git-diff plan review and integration cycle, then return to flywheel_approve_beads.',
                },
                data: {
                    kind: 'plan_refinement_requested',
                    action: 'git-diff-review',
                    planDocument: 'plan.md',
                    lineCount: 2,
                    sizeAssessment: 'too_short',
                    planRefinementRound: 1,
                    refinementModel: undefined,
                },
            });
        });
    });
    // ── Convergence tracking ─────────────────────────────────────
    it('tracks polish changes during refining_beads phase', async () => {
        const beads = [makeBead({ id: 'bead-1' })];
        const calls = makeExecCalls(beads);
        // First call in refining phase to set snapshot
        const { ctx: ctx1, state: state1 } = makeCtx({ phase: 'refining_beads', polishRound: 0, polishChanges: [] }, calls);
        await runApprove(ctx1, { cwd: '/fake/cwd', action: 'polish' });
        // The state should be in refining_beads after polish
        expect(state1.phase).toBe('refining_beads');
        // Second call should track changes
        vi.resetModules();
        const runApprove2 = await importApprove();
        // First call sets snapshot
        const { ctx: ctx2a, state: state2a } = makeCtx({ phase: 'refining_beads', polishRound: 0, polishChanges: [] }, calls);
        await runApprove2(ctx2a, { cwd: '/fake/cwd', action: 'polish' });
        // Second call detects changes
        const { ctx: ctx2b } = makeCtx({ phase: 'refining_beads', polishRound: state2a.polishRound, polishChanges: [...state2a.polishChanges] }, calls);
        Object.assign(ctx2b, { exec: ctx2a.exec });
        await runApprove2(ctx2b, { cwd: '/fake/cwd', action: 'polish' });
        expect(ctx2b.state.polishChanges).toBeInstanceOf(Array);
        expect(ctx2b.state.polishChanges.length).toBeGreaterThanOrEqual(1);
        expect(ctx2b.state.polishRound).toBeGreaterThanOrEqual(1);
    });
    it('sets polishConverged when two consecutive zero-change rounds', async () => {
        const beads = [makeBead({ id: 'bead-1' })];
        const calls = makeExecCalls(beads);
        vi.resetModules();
        const runApproveConv = await importApprove();
        // Round 1: sets snapshot (no _lastBeadSnapshot yet)
        const { ctx: ctxA, state: stateA } = makeCtx({ phase: 'refining_beads', polishRound: 0, polishChanges: [] }, calls);
        await runApproveConv(ctxA, { cwd: '/fake/cwd', action: 'polish' });
        // Round 2: same beads → 0 changes
        const { ctx: ctxB } = makeCtx({ phase: 'refining_beads', polishRound: stateA.polishRound, polishChanges: [...stateA.polishChanges] }, calls);
        Object.assign(ctxB, { exec: ctxA.exec });
        await runApproveConv(ctxB, { cwd: '/fake/cwd', action: 'polish' });
        // Round 3: same beads again → second 0-change round → converged
        const { ctx: ctxC } = makeCtx({ phase: 'refining_beads', polishRound: ctxB.state.polishRound, polishChanges: [...ctxB.state.polishChanges] }, calls);
        Object.assign(ctxC, { exec: ctxA.exec });
        await runApproveConv(ctxC, { cwd: '/fake/cwd', action: 'polish' });
        expect(ctxC.state.polishConverged).toBe(true);
    });
    it('stores activeBeadIds from open beads', async () => {
        const beads = [
            makeBead({ id: 'bead-1' }),
            makeBead({ id: 'bead-2' }),
        ];
        const { ctx, state } = makeCtx({}, makeExecCalls(beads));
        await runApprove(ctx, { cwd: '/fake/cwd', action: 'polish' });
        expect(state.activeBeadIds).toEqual(['bead-1', 'bead-2']);
    });
    // ── Rollback on mid-loop failure ─────────────────────────────
    it('rolls back transitioned beads when br update fails mid-loop', async () => {
        const beads = [
            makeBead({ id: 'bead-1', title: 'First task' }),
            makeBead({ id: 'bead-2', title: 'Second task' }),
            makeBead({ id: 'bead-3', title: 'Third task' }),
        ];
        const execCalls = [
            { cmd: 'br', args: ['list', '--json'], result: { code: 0, stdout: JSON.stringify(beads), stderr: '' } },
            { cmd: 'br', args: ['ready', '--json'], result: { code: 0, stdout: JSON.stringify(beads), stderr: '' } },
            // bead-1 succeeds
            { cmd: 'br', args: ['update', 'bead-1', '--status', 'in_progress'], result: { code: 0, stdout: '', stderr: '' } },
            // bead-2 fails
            { cmd: 'br', args: ['update', 'bead-2', '--status', 'in_progress'], result: { code: 1, stdout: '', stderr: 'db locked' } },
            // rollback: bead-1 back to open
            { cmd: 'br', args: ['update', 'bead-1', '--status', 'open'], result: { code: 0, stdout: '', stderr: '' } },
        ];
        const { ctx } = makeCtx({}, execCalls);
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        expect(result.isError).toBe(true);
        const sc = result.structuredContent;
        expect(sc.data.error.code).toBe('cli_failure');
        expect(sc.data.error.details.rolledBack).toEqual(['bead-1']);
        expect(sc.data.error.details.failedBeadId).toBe('bead-2');
    });
    // ── Concurrent invocation ────────────────────────────────────
    it('returns concurrent_write when two start actions for same cwd overlap', async () => {
        const { _resetForTest } = await import('../../mutex.js');
        _resetForTest();
        const bead = makeBead();
        const execCalls = [
            { cmd: 'br', args: ['list', '--json'], result: { code: 0, stdout: JSON.stringify([bead]), stderr: '' } },
            { cmd: 'br', args: ['ready', '--json'], result: { code: 0, stdout: JSON.stringify([bead]), stderr: '' } },
            { cmd: 'br', args: ['update', bead.id, '--status', 'in_progress'], result: { code: 0, stdout: '', stderr: '' } },
        ];
        // Use a specific cwd so the mutex key is deterministic
        const testCwd = '/test/concurrent';
        const { ctx: ctx1 } = makeCtx({}, execCalls, testCwd);
        const { ctx: ctx2 } = makeCtx({}, execCalls, testCwd);
        // Acquire the mutex manually to simulate an in-flight operation
        const { acquireBeadMutex, releaseBeadMutex } = await import('../../mutex.js');
        const key = `approve-start:${testCwd}`;
        acquireBeadMutex(key);
        const result = await runApprove(ctx2, { cwd: testCwd, action: 'start' });
        expect(result.isError).toBe(true);
        const sc = result.structuredContent;
        expect(sc.data.error.code).toBe('concurrent_write');
        expect(sc.data.error.retryable).toBe(true);
        releaseBeadMutex(key);
        _resetForTest();
    });
});
// ─── P2.4 / 2p5 — polish bounds + stop_reason ─────────────────────────────
//
// flywheel_approve_beads now auto-stops the polish loop when convergence
// crosses the threshold OR when state.polishRound hits max_rounds. Every
// terminal transition surfaces a `stop_reason` field so callers can decide
// programmatically whether to start, reject, or override with a higher cap.
describe('flywheel_approve_beads polish bounds (2p5)', () => {
    let runApprove2p5;
    beforeEach(async () => {
        vi.resetModules();
        runApprove2p5 = await importApprove();
    });
    it('returns stop_reason="manual_reject" when action=reject', async () => {
        const { ctx } = makeCtx({}, makeExecCalls([makeBead()]));
        const result = await runApprove2p5(ctx, { cwd: '/fake/cwd', action: 'reject' });
        const sc = result.structuredContent;
        expect(sc.data.stop_reason).toBe('manual_reject');
    });
    it('returns stop_reason="manual_start" when action=start', async () => {
        const { ctx } = makeCtx({}, makeExecCalls([makeBead()]));
        const result = await runApprove2p5(ctx, { cwd: '/fake/cwd', action: 'start' });
        const sc = result.structuredContent;
        expect(sc.data.stop_reason).toBe('manual_start');
    });
    it('returns stop_reason="convergence_reached" when convergence ≥ until_convergence_score', async () => {
        // Seed enough polish history for computeConvergenceScore to fire AND
        // produce a high score: 3 rounds, last two with 0 changes, output sizes
        // stable → convergence trends to 1.0.
        const { ctx } = makeCtx({
            polishRound: 4,
            polishChanges: [3, 0, 0, 0],
            polishOutputSizes: [1000, 1100, 1100, 1100],
        }, makeExecCalls([makeBead()]));
        const result = await runApprove2p5(ctx, {
            cwd: '/fake/cwd',
            action: 'polish',
            until_convergence_score: 0.5,
        });
        const sc = result.structuredContent;
        expect(sc.data.kind).toBe('polish_bound_reached');
        expect(sc.data.stop_reason).toBe('convergence_reached');
        expect(sc.data.convergenceScore).toBeGreaterThanOrEqual(0.5);
        expect(result.content[0].text).toMatch(/Polish bound reached/);
    });
    it('returns stop_reason="max_rounds_hit" when polishRound ≥ max_rounds', async () => {
        const { ctx } = makeCtx({
            polishRound: 5,
            polishChanges: [3, 2, 1],
        }, makeExecCalls([makeBead()]));
        const result = await runApprove2p5(ctx, {
            cwd: '/fake/cwd',
            action: 'polish',
            max_rounds: 5,
        });
        const sc = result.structuredContent;
        expect(sc.data.kind).toBe('polish_bound_reached');
        expect(sc.data.stop_reason).toBe('max_rounds_hit');
        expect(result.content[0].text).toMatch(/round 5 ≥ max_rounds 5/);
    });
    it('does NOT bound when polish round < max_rounds AND convergence is undefined', async () => {
        // Default state — no polish history → convergence undefined, round=0
        // → polish round runs normally.
        const { ctx } = makeCtx({}, makeExecCalls([makeBead()]));
        const result = await runApprove2p5(ctx, { cwd: '/fake/cwd', action: 'polish' });
        const sc = result.structuredContent;
        expect(sc.data.kind).not.toBe('polish_bound_reached');
        expect(sc.data.kind).toBe('bead_refinement_requested');
    });
});
//# sourceMappingURL=approve.test.js.map