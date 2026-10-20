import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockExec, makeState } from '../helpers/mocks.js';
import { CompletionReportSchemaV1 } from '../../completion-report.js';
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
function parsePromptCompletionReport(prompt) {
    const json = prompt.match(/## PRE-COMPLETION QUALITY GATE[\s\S]*?```json\n(?<json>[\s\S]*?)\n```/u)?.groups?.json;
    if (!json)
        throw new Error('completion report JSON example missing from prompt');
    const materialized = json
        .replaceAll('<pane-name-or-omit>', 'impl-wave__cc_1')
        .replaceAll('<repo-relative-path>', 'src/feature.ts')
        .replaceAll('<short-sha>', 'abc1234')
        .replaceAll('<repo-verify-command>', 'npx vitest run')
        .replaceAll('<verify-summary>', 'all green')
        .replaceAll('<self-review-summary>', 'no regressions found')
        .replaceAll('<ISO-8601 timestamp>', '2026-10-15T14:00:00.000Z');
    return CompletionReportSchemaV1.parse(JSON.parse(materialized));
}
/** The Gemini lane is Pi on the gateway; `gateway: false` leaves Pi only the xai login a picks file names. */
function availableCliCalls(gateway = true, pi = true) {
    return [
        {
            cmd: 'which',
            args: ['claude'],
            result: { code: 0, stdout: '/bin/claude\n', stderr: '' },
        },
        {
            cmd: 'which',
            args: ['codex'],
            result: { code: 0, stdout: '/bin/codex\n', stderr: '' },
        },
        {
            cmd: 'which',
            args: ['pi'],
            result: pi
                ? { code: 0, stdout: '/bin/pi\n', stderr: '' }
                : { code: 1, stdout: '', stderr: 'pi not found' },
        },
        {
            cmd: 'pi',
            args: ['auth', 'check', '--provider', 'vercel-ai-gateway', '--json'],
            result: gateway
                ? { code: 0, stdout: 'ready\n', stderr: '' }
                : { code: 1, stdout: '{"status":"not_ready","reason":"credentials_not_configured"}\n', stderr: '' },
        },
        {
            cmd: 'pi',
            args: ['auth', 'check', '--provider', 'xai', '--json'],
            result: { code: 0, stdout: '{"status":"ready","authType":"oauth"}\n', stderr: '' },
        },
    ];
}
/** A cwd whose saved Pi pick runs on the xai login, so Pi stays ready without the gateway. */
function cwdWithXaiPick() {
    const cwd = mkdtempSync(join(tmpdir(), 'approve-xai-pick-'));
    mkdirSync(join(cwd, '.pi-flywheel'));
    writeFileSync(join(cwd, '.pi-flywheel', 'pi-models.json'), JSON.stringify({ version: 2, picks: { implementer: { piModels: ['xai/grok-4.7'], chosenAt: '2026-10-19T00:00:00.000Z' } } }));
    return cwd;
}
function unavailableCliCalls() {
    return ['claude', 'codex', 'gemini', 'pi'].map((provider) => ({
        cmd: 'which',
        args: [provider],
        result: { code: 1, stdout: '', stderr: `${provider} not found` },
    }));
}
function makeExecCalls(beads = [makeBead()], readyBeads) {
    return [
        {
            cmd: 'br',
            args: ['list', '--all', '--limit', '0', '--json'],
            result: { code: 0, stdout: JSON.stringify(beads), stderr: '' },
        },
        {
            cmd: 'br',
            args: ['ready', '--limit', '0', '--json'],
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
function makeCtx(stateOverrides = {}, execCalls = makeExecCalls(), cwd = '/fake/cwd', capabilityCalls = availableCliCalls()) {
    const exec = createMockExec([...capabilityCalls, ...execCalls]);
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
            { cmd: 'br', args: ['list', '--all', '--limit', '0', '--json'], result: { code: 1, stdout: '', stderr: 'br not found' } },
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
                        command: 'br list --all --limit 0 --json',
                        stderr: 'br not found',
                    },
                },
            },
        });
    });
    it('returns error when br list returns invalid JSON', async () => {
        const { ctx } = makeCtx({}, [
            { cmd: 'br', args: ['list', '--all', '--limit', '0', '--json'], result: { code: 0, stdout: 'not json', stderr: '' } },
        ]);
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Could not parse');
    });
    it('returns guidance when no open beads found', async () => {
        const closedBead = makeBead({ status: 'closed' });
        const { ctx } = makeCtx({}, [
            { cmd: 'br', args: ['list', '--all', '--limit', '0', '--json'], result: { code: 0, stdout: JSON.stringify([closedBead]), stderr: '' } },
        ]);
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        expect(result.content[0].text).toContain('No open beads found');
    });
    it('starts from a br list holding rows br accepts but the flywheel used to reject', async () => {
        const openBead = makeBead();
        const { description: _, ...noDescription } = makeBead({ id: 'old-1', status: 'closed' });
        const rows = [
            openBead,
            noDescription,
            { ...makeBead({ id: 'old-2', status: 'closed' }), description: null },
            makeBead({ id: 'old-3', status: 'completed' }),
            makeBead({ id: 'odd-1', status: 'wibble' }),
        ];
        const { ctx, state } = makeCtx({}, [
            { cmd: 'br', args: ['list', '--all', '--limit', '0', '--json'], result: { code: 0, stdout: JSON.stringify(rows), stderr: '' } },
            { cmd: 'br', args: ['ready', '--limit', '0', '--json'], result: { code: 0, stdout: JSON.stringify([openBead]), stderr: '' } },
            { cmd: 'br', args: ['update', openBead.id, '--status', 'in_progress'], result: { code: 0, stdout: '', stderr: '' } },
        ]);
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).not.toContain('Could not parse');
        expect(state.activeBeadIds).toEqual([openBead.id]);
        const skippedWarnings = result.content[0].text.split('\n').filter((line) => line.startsWith('Warning: Skipped'));
        expect(skippedWarnings).toEqual(['Warning: Skipped bead odd-1 from br output: unknown status "wibble".']);
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
                creationAudit: { planCoverage: null, duplicateCandidates: [] },
                matrix: expect.objectContaining({
                    version: 1,
                    recommendation: expect.stringMatching(/^(swarm|coordinator-serial)$/),
                }),
                advancedActions: ['fresh-agent', 'same-agent', 'blunder-hunt', 'dedup', 'cross-model', 'graph-fix'],
            },
        });
    });
    // ── action=start ─────────────────────────────────────────────
    it('returns the server-computed plan coverage and dedup audit', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'approve-creation-audit-'));
        const beads = [
            makeBead({
                id: 'cache-1',
                title: 'Add request cache',
                description: 'Implement request caching, invalidation, and eviction behavior.',
            }),
            makeBead({
                id: 'cache-2',
                title: 'Implement request cache',
                description: 'Implement request caching.',
            }),
            makeBead({
                id: 'metrics-1',
                title: 'Record cache metrics',
                description: 'Record cache hit and miss metrics.',
            }),
        ];
        try {
            writeFileSync(join(cwd, 'plan.md'), '# Request cache\nImplement request caching and invalidation.\n\n# Metrics\nRecord cache hit and miss metrics.');
            const { ctx } = makeCtx({ planDocument: 'plan.md' }, [{
                    cmd: 'br',
                    args: ['list', '--all', '--limit', '0', '--json'],
                    result: { code: 0, stdout: JSON.stringify(beads), stderr: '' },
                }], cwd);
            const result = await runApprove(ctx, { cwd, action: 'polish' });
            const structured = result.structuredContent;
            expect(structured.data.creationAudit).toEqual({
                planCoverage: expect.objectContaining({
                    totalSections: 2,
                    coveredSections: 2,
                    uncoveredSections: [],
                    weakMappings: [],
                }),
                duplicateCandidates: [{
                        beadIds: ['cache-1', 'cache-2'],
                        canonicalBeadId: 'cache-1',
                        duplicateBeadId: 'cache-2',
                        reasons: ['near-duplicate-title'],
                        sharedFiles: [],
                    }],
            });
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
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
                type: 'spawn_agents',
                message: 'Send the server-built prompt to one implementation pane, then call flywheel_review with its summary.',
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
                creationAudit: { planCoverage: null, duplicateCandidates: [] },
                lanes: [{ lane: 'cc', beadIds: ['bead-1'] }],
                prompts: [{
                        beadId: 'bead-1',
                        lane: 'cc',
                        agentName: expect.any(String),
                        prompt: expect.stringContaining('## PRE-COMPLETION QUALITY GATE'),
                    }],
                dispatch: { degraded: false, warnings: [] },
                matrix: expect.objectContaining({
                    version: 1,
                    recommendation: expect.stringMatching(/^(swarm|coordinator-serial)$/),
                }),
                readyBeads: [
                    {
                        id: 'bead-1',
                        title: 'Add tests',
                        launchInstruction: 'implement',
                        agentName: expect.any(String),
                    },
                ],
            },
        });
    });
    it('does not claim ready beads from another goal program', async () => {
        const goalALabel = 'flywheel-goal:goal-a:ccba1a8c';
        const goalBLabel = 'flywheel-goal:goal-b:9406de47';
        const goalAReady = makeBead({
            id: 'goal-a-ready',
            title: 'Goal A ready',
            description: 'Implement goal A.\nHOW: src/goal-a.ts',
            labels: [goalALabel],
        });
        const goalABlocked = makeBead({
            id: 'goal-a-blocked',
            title: 'Goal A blocked',
            description: 'Implement blocked goal A work.\nHOW: src/goal-a-blocked.ts',
            labels: [goalALabel],
        });
        const goalBReady = makeBead({
            id: 'goal-b-ready',
            title: 'Goal B ready',
            description: 'Implement goal B.\nHOW: src/goal-b.ts',
            labels: [goalBLabel],
        });
        const goalBBlocked = makeBead({
            id: 'goal-b-blocked',
            title: 'Goal B blocked',
            description: 'Implement blocked goal B work.\nHOW: src/goal-b-blocked.ts',
            labels: [goalBLabel],
        });
        const allBeads = [goalAReady, goalABlocked, goalBReady, goalBBlocked];
        const { ctx, state } = makeCtx({ selectedGoal: 'Goal A' }, [
            { cmd: 'br', args: ['list', '--all', '--limit', '0', '--json'], result: { code: 0, stdout: JSON.stringify(allBeads), stderr: '' } },
            { cmd: 'br', args: ['ready', '--limit', '0', '--json'], result: { code: 0, stdout: JSON.stringify([goalBReady, goalAReady]), stderr: '' } },
            { cmd: 'br', args: ['update', goalBReady.id, '--status', 'in_progress'], result: { code: 0, stdout: '', stderr: '' } },
            { cmd: 'br', args: ['update', goalAReady.id, '--status', 'in_progress'], result: { code: 0, stdout: '', stderr: '' } },
        ]);
        const exec = vi.fn(ctx.exec);
        ctx.exec = exec;
        const result = await runApprove(ctx, {
            cwd: '/fake/cwd',
            action: 'start',
            coordinatorName: 'WindyBasin',
        });
        const data = result.structuredContent.data;
        expect(state.activeBeadIds).toEqual([goalAReady.id, goalABlocked.id]);
        expect(state.currentBeadId).toBe(goalAReady.id);
        expect(data.readyBeads).toEqual([
            expect.objectContaining({ id: goalAReady.id }),
        ]);
        expect(exec).toHaveBeenCalledWith('br', ['update', goalAReady.id, '--status', 'in_progress'], expect.anything());
        expect(exec).not.toHaveBeenCalledWith('br', ['update', goalBReady.id, '--status', 'in_progress'], expect.anything());
    });
    it('keeps legacy untagged behavior with an ownership warning', async () => {
        const bead = makeBead({ id: 'legacy-ready', labels: ['bug'] });
        const { ctx, state } = makeCtx({ selectedGoal: 'Legacy goal' }, makeExecCalls([bead]));
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        expect(state.beadProgramScope).toEqual({
            kind: 'legacy',
            label: 'flywheel-goal:legacy-goal:022a4d11',
        });
        expect(state.activeBeadIds).toEqual([bead.id]);
        expect(result.content[0].text).toContain('using legacy repository-wide scope');
        expect(result.content[0].text).toContain('Ownership across goals cannot be verified');
    });
    it('refuses repository-wide fallback when only another tagged program exists', async () => {
        const foreign = makeBead({
            id: 'goal-b-ready',
            labels: ['flywheel-goal:goal-b:9406de47'],
        });
        const { ctx, state } = makeCtx({ selectedGoal: 'Goal A' }, [{
                cmd: 'br',
                args: ['list', '--all', '--limit', '0', '--json'],
                result: { code: 0, stdout: JSON.stringify([foreign]), stderr: '' },
            }]);
        const exec = vi.fn(ctx.exec);
        ctx.exec = exec;
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        expect(state.activeBeadIds).toEqual([]);
        expect(result.content[0].text).toContain('repository-wide fallback is disabled');
        expect(exec).not.toHaveBeenCalledWith('br', ['update', foreign.id, '--status', 'in_progress'], expect.anything());
    });
    it('resets beadResults and beadReviews on start', async () => {
        const bead = makeBead();
        const { ctx, state } = makeCtx({ beadResults: { old: { beadId: 'old', status: 'success', summary: 'done' } } }, makeExecCalls([bead]));
        await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        expect(state.beadResults).toEqual({});
        expect(state.beadReviews).toEqual({});
    });
    it('returns server-built prompts when multiple beads are ready', async () => {
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
        expect(text).toContain('data.lanes');
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
                creationAudit: { planCoverage: null, duplicateCandidates: [] },
                lanes: [
                    { lane: 'cc', beadIds: ['bead-1'] },
                    { lane: 'pi', beadIds: ['bead-2'] },
                ],
                prompts: [
                    {
                        beadId: 'bead-1',
                        lane: 'cc',
                        agentName: expect.any(String),
                        prompt: expect.stringContaining('## PRE-COMPLETION QUALITY GATE'),
                    },
                    {
                        beadId: 'bead-2',
                        lane: 'pi',
                        agentName: expect.any(String),
                        prompt: expect.stringContaining('## PRE-COMPLETION QUALITY GATE'),
                    },
                ],
                dispatch: { degraded: false, warnings: [] },
                matrix: expect.objectContaining({
                    version: 1,
                    recommendation: 'swarm',
                }),
                readyBeads: [
                    {
                        id: 'bead-1',
                        title: 'First task',
                        launchInstruction: 'spawn-agent',
                        agentName: expect.any(String),
                    },
                    {
                        id: 'bead-2',
                        title: 'Second task',
                        launchInstruction: 'spawn-agent',
                        agentName: expect.any(String),
                    },
                ],
            },
        });
    });
    it('returns 2/2/2 lanes and a gated adapter prompt for every wave-one bead', async () => {
        const beads = Array.from({ length: 6 }, (_, index) => makeBead({
            id: `wave-1-${index + 1}`,
            title: `Implement wave feature ${index + 1}`,
            description: `Implement wave feature ${index + 1}.\nHOW: src/feature-${index + 1}.ts`,
        }));
        const { ctx } = makeCtx({}, makeExecCalls(beads));
        const result = await runApprove(ctx, {
            cwd: '/fake/cwd',
            action: 'start',
            coordinatorName: 'WindyBasin',
        });
        const structured = result.structuredContent;
        const data = structured.data;
        expect(data.lanes).toEqual([
            { lane: 'cc', beadIds: ['wave-1-1', 'wave-1-2'] },
            { lane: 'pi', beadIds: ['wave-1-3', 'wave-1-4'] },
            { lane: 'gmi', beadIds: ['wave-1-5', 'wave-1-6'] },
        ]);
        expect(data.prompts.map(({ beadId, lane }) => ({ beadId, lane }))).toEqual([
            { beadId: 'wave-1-1', lane: 'cc' },
            { beadId: 'wave-1-2', lane: 'cc' },
            { beadId: 'wave-1-3', lane: 'pi' },
            { beadId: 'wave-1-4', lane: 'pi' },
            { beadId: 'wave-1-5', lane: 'gmi' },
            { beadId: 'wave-1-6', lane: 'gmi' },
        ]);
        for (const prompt of data.prompts) {
            expect(prompt.prompt).toContain('## PRE-COMPLETION QUALITY GATE');
            expect(prompt.prompt).toContain(`.pi-flywheel/completion/${prompt.beadId}.json`);
            expect(prompt.prompt).toContain(`"beadId": "${prompt.beadId}"`);
            expect(prompt.prompt).toContain(`"agentName": "${prompt.agentName}"`);
            expect(prompt.prompt).toContain(prompt.lane === 'pi' || prompt.lane === 'gmi' ? "--to 'WindyBasin'" : "send_message to 'WindyBasin'");
            expect(prompt.prompt).not.toContain('AGENTS.md');
            expect(parsePromptCompletionReport(prompt.prompt)).toMatchObject({
                beadId: prompt.beadId,
                agentName: prompt.agentName,
            });
        }
    });
    it('returns 2/4 wave-one lanes with Pi taking the Gemini share when only a Pi login works', async () => {
        const beads = Array.from({ length: 6 }, (_, index) => makeBead({
            id: `fallback-${index + 1}`,
            title: `Fallback ${index + 1}`,
            description: `Implement fallback ${index + 1}.\nHOW: src/fallback-${index + 1}.ts`,
        }));
        const cwd = cwdWithXaiPick();
        try {
            const { ctx } = makeCtx({}, makeExecCalls(beads), cwd, availableCliCalls(false));
            const result = await runApprove(ctx, { cwd, action: 'start' });
            const structured = result.structuredContent;
            expect(structured.data.lanes).toEqual([
                { lane: 'cc', beadIds: ['fallback-1', 'fallback-2'] },
                {
                    lane: 'pi',
                    beadIds: ['fallback-3', 'fallback-4', 'fallback-5', 'fallback-6'],
                },
            ]);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('hands the Pi and Gemini shares to Codex when Pi is not on PATH', async () => {
        const beads = Array.from({ length: 6 }, (_, index) => makeBead({
            id: `nopi-${index + 1}`,
            title: `No Pi ${index + 1}`,
            description: `Implement no-pi ${index + 1}.\nHOW: src/nopi-${index + 1}.ts`,
        }));
        const { ctx } = makeCtx({}, makeExecCalls(beads), '/fake/cwd', availableCliCalls(true, false));
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        const structured = result.structuredContent;
        expect(structured.data.lanes).toEqual([
            { lane: 'cc', beadIds: ['nopi-1', 'nopi-2'] },
            { lane: 'cod', beadIds: ['nopi-3', 'nopi-4', 'nopi-5', 'nopi-6'] },
        ]);
        expect(structured.data.dispatch).toEqual({
            degraded: true,
            warnings: [
                'pi lane not available (which pi exited 1); reassigned 2 bead(s) to codex',
                'gemini lane not available (which pi exited 1); reassigned 2 bead(s) to codex',
            ],
        });
    });
    it('does not mutate the implementation state when no provider is available', async () => {
        const bead = makeBead();
        const { ctx, state } = makeCtx({ beadResults: { old: { beadId: 'old', status: 'success', summary: 'done' } } }, makeExecCalls([bead]), '/fake/cwd', unavailableCliCalls());
        const exec = vi.fn(ctx.exec);
        ctx.exec = exec;
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
            data: { error: { code: 'cli_not_available' } },
        });
        expect(state.phase).toBe('awaiting_bead_approval');
        expect(state.beadResults).toEqual({
            old: { beadId: 'old', status: 'success', summary: 'done' },
        });
        expect(exec).not.toHaveBeenCalledWith('br', ['update', bead.id, '--status', 'in_progress'], expect.anything());
    });
    it('does not dispatch dependency-unknown beads when br ready fails', async () => {
        const beads = [
            makeBead({ id: 'bead-1', title: 'First' }),
            makeBead({ id: 'bead-2', title: 'Second' }),
            makeBead({ id: 'bead-3', title: 'Third' }),
        ];
        const execCalls = [
            { cmd: 'br', args: ['list', '--all', '--limit', '0', '--json'], result: { code: 0, stdout: JSON.stringify(beads), stderr: '' } },
            { cmd: 'br', args: ['ready', '--limit', '0', '--json'], result: { code: 1, stdout: '', stderr: 'br ready failed' } },
            ...beads.map(b => ({
                cmd: 'br',
                args: ['update', b.id, '--status', 'in_progress'],
                result: { code: 0, stdout: '', stderr: '' },
            })),
        ];
        const { ctx, state } = makeCtx({}, execCalls);
        const exec = vi.fn(ctx.exec);
        ctx.exec = exec;
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        expect(state.phase).toBe('awaiting_bead_approval');
        expect(result.content[0].text).toContain('Beads approved');
        expect(result.content[0].text).toContain('no ready beads found');
        for (const bead of beads) {
            expect(exec).not.toHaveBeenCalledWith('br', ['update', bead.id, '--status', 'in_progress'], expect.anything());
        }
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
    it('renders one repeat-until-clean blunder-hunt pass', async () => {
        const { ctx, state } = makeCtx();
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'advanced', advancedAction: 'blunder-hunt' });
        expect(state.phase).toBe('refining_beads');
        expect(result).toEqual({
            content: [{
                    type: 'text',
                    text: `**NEXT: Run the pass below and repeat until a pass finds nothing new (at most 5 passes), then call \`flywheel_approve_beads\` again.**

### Blunder Hunt Pass
Read all beads via \`br list --json\`. Look for: incomplete descriptions, missing files, circular dependencies, wrong priorities, vague acceptance criteria. Fix anything suspicious.

cd /fake/cwd

Current beads:
• bead-1: Add tests`,
                }],
        });
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
                creationAudit: { planCoverage: null, duplicateCandidates: [] },
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
        function writePlanFixture(name) {
            const relativePath = `docs/plans/${name}`;
            mkdirSync(join(tmpDir, 'docs', 'plans'), { recursive: true });
            writeFileSync(join(tmpDir, relativePath), readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8'), 'utf8');
            return relativePath;
        }
        it('injects parsed duel provenance into the plan-to-beads prompt', async () => {
            const planDocument = writePlanFixture('duel-report-valid.md');
            const { ctx } = makeCtx({ phase: 'awaiting_plan_approval', planDocument, planSource: 'duel' }, [], tmpDir);
            const result = await runApprove(ctx, { cwd: tmpDir, action: 'start' });
            const text = result.content[0].text;
            expect(text).toContain('## Provenance');
            expect(text).toContain('- **Agent scores:** cc=self, cod=920, gmi=860');
            expect(text).toContain('- **Contested:** false');
        });
        it('omits provenance for a non-duel plan', async () => {
            const planDocument = writePlanFixture('duel-report-valid.md');
            const { ctx } = makeCtx({ phase: 'awaiting_plan_approval', planDocument, planSource: 'standard' }, [], tmpDir);
            const result = await runApprove(ctx, { cwd: tmpDir, action: 'start' });
            expect(result.content[0].text).not.toContain('## Provenance');
        });
        it('uses placeholders instead of throwing when a duel report is malformed', async () => {
            const planDocument = writePlanFixture('duel-report-malformed.md');
            const { ctx } = makeCtx({ phase: 'awaiting_plan_approval', planDocument, planSource: 'duel' }, [], tmpDir);
            const result = await runApprove(ctx, { cwd: tmpDir, action: 'start' });
            const text = result.content[0].text;
            expect(result.isError).toBeUndefined();
            expect(text).toContain('## Provenance');
            expect(text).toContain('cc=<0-1000 or n/a>');
            expect(text).toContain(`Read missing provenance values from \`${planDocument}\``);
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
                    refinementModel: 'opus',
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
            expect(result.content[0].text).toContain('Carefully review this entire plan for me');
            expect(result.content[0].text).toContain('# Plan\nSome content here');
            expect(result.content[0].text).toContain('OK, now integrate these revisions to the markdown plan in-place');
            expect(result.content[0].text).toContain('## Original Plan\n<original plan from plan.md>');
            expect(result.content[0].text).toContain('## Proposed Revisions\n<reviewer proposed revisions>');
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
            { cmd: 'br', args: ['list', '--all', '--limit', '0', '--json'], result: { code: 0, stdout: JSON.stringify(beads), stderr: '' } },
            { cmd: 'br', args: ['ready', '--limit', '0', '--json'], result: { code: 0, stdout: JSON.stringify(beads), stderr: '' } },
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
            { cmd: 'br', args: ['list', '--all', '--limit', '0', '--json'], result: { code: 0, stdout: JSON.stringify([bead]), stderr: '' } },
            { cmd: 'br', args: ['ready', '--limit', '0', '--json'], result: { code: 0, stdout: JSON.stringify([bead]), stderr: '' } },
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
// ─── action=remediate (T20 / claude-orchestrator-38i) ─────────────────────
describe('runApprove — action=remediate', () => {
    let runApproveR;
    beforeEach(async () => {
        vi.resetModules();
        runApproveR = await importApprove();
    });
    function makeRemediation(overrides = {}) {
        return {
            planSlug: '2026-05-08-outcome-grading',
            iteration: 1,
            criterionId: 'c2',
            criterionDescription: 'flywheel_synthesize_rubric MCP tool registered in server.ts and writes .pi-flywheel/plans/<slug>/rubric.md',
            status: 'unmet',
            evidence: 'mcp-server/src/server.ts has no entry for flywheel_synthesize_rubric',
            gaps: [
                'Tool is not registered in server.ts',
                'No corresponding inputSchema defined',
            ],
            ...overrides,
        };
    }
    it('creates a remediation bead from a failing criterion and increments iterationRound', async () => {
        const calls = [
            {
                cmd: 'br',
                args: [
                    'create',
                    '--title', 'Outcome remediation c2: flywheel_synthesize_rubric MCP tool registered in server.…',
                    '--description', expect.any(String),
                    '--priority', '2',
                    '--type', 'task',
                ],
                result: { code: 0, stdout: 'br-remediate-1', stderr: '' },
            },
        ];
        // Use a permissive matcher: the title is deterministic but description
        // is long; use a lenient mock that matches on cmd + first 4 args.
        const exec = vi.fn(async (cmd, args) => {
            if (cmd === 'br' && args[0] === 'create') {
                return { code: 0, stdout: 'br-remediate-1', stderr: '' };
            }
            return { code: 1, stdout: '', stderr: 'not mocked' };
        });
        const state = makeState({
            selectedGoal: 'Outcome grading',
            phase: 'reviewing',
            iterationRound: 0,
            beadProgramScope: {
                kind: 'tagged',
                label: 'flywheel-goal:outcome-grading:feedface',
            },
        });
        const ctx = {
            exec: exec,
            cwd: '/fake/cwd',
            state,
            saveState: () => { },
            clearState: () => { },
        };
        const result = await runApproveR(ctx, {
            cwd: '/fake/cwd',
            action: 'remediate',
            remediation: makeRemediation(),
        });
        expect(result.isError).toBeUndefined();
        expect(state.iterationRound).toBe(1);
        const sc = result.structuredContent;
        expect(sc.data.kind).toBe('remediation_bead_created');
        expect(sc.data.criterionId).toBe('c2');
        expect(sc.data.iterationRound).toBe(1);
        expect(sc.data.title).toContain('Outcome remediation c2');
        expect(exec).toHaveBeenCalledWith('br', expect.arrayContaining([
            '--labels',
            'flywheel-goal:outcome-grading:feedface',
        ]), expect.anything());
        void calls;
    });
    it('returns invalid_input when remediation payload is omitted', async () => {
        const { ctx } = makeCtx({ phase: 'reviewing' });
        const result = await runApproveR(ctx, {
            cwd: '/fake/cwd',
            action: 'remediate',
        });
        expect(result.isError).toBe(true);
        const sc = result.structuredContent;
        expect(sc.data.error.code).toBe('invalid_input');
        expect(sc.data.error.message).toContain('remediation` payload');
    });
    it('returns invalid_input when criterionDescription is empty', async () => {
        const { ctx } = makeCtx({ phase: 'reviewing' });
        const result = await runApproveR(ctx, {
            cwd: '/fake/cwd',
            action: 'remediate',
            remediation: makeRemediation({ criterionDescription: '' }),
        });
        expect(result.isError).toBe(true);
        const sc = result.structuredContent;
        expect(sc.data.error.code).toBe('invalid_input');
        expect(sc.data.error.details.criterionDescriptionSet).toBe(false);
    });
    it('surfaces br-create failure as cli_failure', async () => {
        const exec = async (cmd, args) => {
            if (cmd === 'br' && args[0] === 'create') {
                return { code: 2, stdout: '', stderr: 'br: database locked' };
            }
            return { code: 1, stdout: '', stderr: 'not mocked' };
        };
        const state = makeState({ selectedGoal: 'Outcome grading', phase: 'reviewing' });
        const ctx = {
            exec: exec,
            cwd: '/fake/cwd',
            state,
            saveState: () => { },
            clearState: () => { },
        };
        const result = await runApproveR(ctx, {
            cwd: '/fake/cwd',
            action: 'remediate',
            remediation: makeRemediation(),
        });
        expect(result.isError).toBe(true);
        const sc = result.structuredContent;
        expect(sc.data.error.code).toBe('cli_failure');
        expect(sc.data.error.message).toContain('database locked');
    });
});
//# sourceMappingURL=approve.test.js.map