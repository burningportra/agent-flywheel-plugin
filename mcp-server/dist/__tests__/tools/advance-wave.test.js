import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
let gitExecHandler = () => new Error('execFile mock: not configured for this test');
const execFileMock = vi.fn((_cmd, _args, _opts, _callback) => ({ pid: 1, kill: vi.fn() }));
execFileMock[promisify.custom] = (cmd, args, opts) => {
    execFileMock(cmd, args, opts, () => undefined);
    const result = gitExecHandler(cmd, args);
    if (result instanceof Error)
        return Promise.reject(result);
    return Promise.resolve({ stdout: result, stderr: '' });
};
vi.mock('node:child_process', async () => {
    const actual = await vi.importActual('node:child_process');
    return { ...actual, execFile: execFileMock };
});
// Module under test must be imported AFTER vi.mock so promisify(execFile)
// binds the mock at module load time.
const { runAdvanceWave } = await import('../../tools/advance-wave.js');
const { writeCompletionReport } = await import('../../completion-report.js');
const { createMockExec, makeState } = await import('../helpers/mocks.js');
// ─── Helpers ──────────────────────────────────────────────────
function makeBead(overrides = {}) {
    return {
        id: 'tb-1',
        title: 'Test bead',
        description: 'A test bead description',
        status: 'open',
        priority: 2,
        type: 'task',
        labels: [],
        ...overrides,
    };
}
function makeCtx(stateOverrides = {}, execCalls = [], capabilityCalls = availableCliCalls()) {
    const state = makeState({
        selectedGoal: 'test goal',
        phase: 'implementing',
        beadResults: {},
        ...stateOverrides,
    });
    const exec = createMockExec([
        ...capabilityCalls,
        ...execCalls,
        brListAllCall([]),
    ]);
    const ctx = {
        exec,
        cwd: '/fake/project',
        state,
        saveState: (_s) => { },
        clearState: () => { },
    };
    return { ctx, state };
}
function availableCliCalls(gemini = true, pi = true) {
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
            args: ['gemini'],
            result: gemini
                ? { code: 0, stdout: '/bin/gemini\n', stderr: '' }
                : { code: 1, stdout: '', stderr: 'gemini not found' },
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
            result: { code: 0, stdout: 'ready\n', stderr: '' },
        },
    ];
}
function brShowClosed(id) {
    return {
        cmd: 'br',
        args: ['show', id, '--json'],
        result: { code: 0, stdout: JSON.stringify(makeBead({ id, status: 'closed' })), stderr: '' },
    };
}
function brShowOpen(id) {
    return {
        cmd: 'br',
        args: ['show', id, '--json'],
        result: { code: 0, stdout: JSON.stringify(makeBead({ id, status: 'open' })), stderr: '' },
    };
}
function gitGrepEmpty(id) {
    return {
        cmd: 'git',
        args: ['log', `--grep=${id}`, '--oneline', '-1'],
        result: { code: 0, stdout: '', stderr: '' },
    };
}
function gitGrepFound(id, sha) {
    return {
        cmd: 'git',
        args: ['log', `--grep=${id}`, '--oneline', '-1'],
        result: { code: 0, stdout: `${sha} fix(${id}): done`, stderr: '' },
    };
}
function brUpdate(id) {
    return {
        cmd: 'br',
        args: ['update', id, '--status', 'closed'],
        result: { code: 0, stdout: '', stderr: '' },
    };
}
function brReadyCall(beads) {
    return {
        cmd: 'br',
        args: ['ready', '--limit', '0', '--json'],
        result: { code: 0, stdout: JSON.stringify(beads), stderr: '' },
    };
}
function brListAllCall(beads) {
    return {
        cmd: 'br',
        args: ['list', '--all', '--limit', '0', '--json'],
        result: { code: 0, stdout: JSON.stringify(beads), stderr: '' },
    };
}
// ─── Tests ────────────────────────────────────────────────────
describe('runAdvanceWave', () => {
    it('returns invalid_input error when closedBeadIds is empty', async () => {
        const { ctx } = makeCtx();
        const result = await runAdvanceWave(ctx, { cwd: '/fake/project', closedBeadIds: [] });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
            tool: 'flywheel_advance_wave',
            status: 'error',
            data: { error: { code: 'invalid_input' } },
        });
    });
    it('returns waveComplete=false when stragglers have no matching commit', async () => {
        const { ctx } = makeCtx({}, [
            brShowOpen('strag-1'),
            gitGrepEmpty('strag-1'),
        ]);
        const result = await runAdvanceWave(ctx, { cwd: '/fake/project', closedBeadIds: ['strag-1'] });
        expect(result.isError).toBeUndefined();
        const data = result.structuredContent.data;
        expect(data.waveComplete).toBe(false);
        expect(data.nextWave).toBeNull();
        expect(data.verification.unclosedNoCommit).toHaveLength(1);
        expect(result.content[0].text).toContain('Wave incomplete');
    });
    it('returns nextWave=null when queue is drained', async () => {
        const { ctx } = makeCtx({}, [
            brShowClosed('done-1'),
            brShowClosed('done-2'),
            brReadyCall([]),
        ]);
        const result = await runAdvanceWave(ctx, { cwd: '/fake/project', closedBeadIds: ['done-1', 'done-2'] });
        expect(result.isError).toBeUndefined();
        const data = result.structuredContent.data;
        expect(data.waveComplete).toBe(true);
        expect(data.nextWave).toBeNull();
        expect(data.verification.verified).toEqual(['done-1', 'done-2']);
        expect(result.content[0].text).toContain('Queue drained');
    });
    it('dispatches the next wave with server-built provider prompts', async () => {
        const nextBeads = [
            makeBead({ id: 'next-1', title: 'First' }),
            makeBead({ id: 'next-2', title: 'Second' }),
            makeBead({ id: 'next-3', title: 'Third' }),
        ];
        const { ctx } = makeCtx({}, [
            brShowClosed('prev-1'),
            brReadyCall(nextBeads),
        ]);
        const result = await runAdvanceWave(ctx, {
            cwd: '/fake/project',
            closedBeadIds: ['prev-1'],
            coordinatorName: 'WindyBasin',
        });
        expect(result.isError).toBeUndefined();
        const data = result.structuredContent.data;
        expect(data.waveComplete).toBe(true);
        expect(data.nextWave.beadIds).toEqual(['next-1', 'next-2', 'next-3']);
        expect(data.nextWave.lanes).toEqual([
            { lane: 'cc', beadIds: ['next-1'] },
            { lane: 'pi', beadIds: ['next-2'] },
            { lane: 'gmi', beadIds: ['next-3'] },
        ]);
        expect(data.nextWave.prompts.map((prompt) => ({
            beadId: prompt.beadId,
            lane: prompt.lane,
        }))).toEqual([
            { beadId: 'next-1', lane: 'cc' },
            { beadId: 'next-2', lane: 'pi' },
            { beadId: 'next-3', lane: 'gmi' },
        ]);
        for (const prompt of data.nextWave.prompts) {
            expect(prompt.prompt).toContain('## PRE-COMPLETION QUALITY GATE');
            expect(prompt.prompt).toContain(`.pi-flywheel/completion/${prompt.beadId}.json`);
        }
    });
    it('respects maxNextWave to limit dispatched beads', async () => {
        const nextBeads = [
            makeBead({ id: 'a-1', title: 'A' }),
            makeBead({ id: 'a-2', title: 'B' }),
            makeBead({ id: 'a-3', title: 'C' }),
            makeBead({ id: 'a-4', title: 'D' }),
        ];
        const { ctx } = makeCtx({}, [
            brShowClosed('prev-1'),
            brReadyCall(nextBeads),
        ]);
        const result = await runAdvanceWave(ctx, { cwd: '/fake/project', closedBeadIds: ['prev-1'], maxNextWave: 2 });
        const data = result.structuredContent.data;
        expect(data.nextWave.beadIds).toEqual(['a-1', 'a-2']);
        expect(data.nextWave.prompts).toHaveLength(2);
    });
    it('includes complexity classification for each dispatched bead', async () => {
        const nextBeads = [
            makeBead({ id: 'c-1', title: 'Simple fix', description: 'fix typo' }),
            makeBead({ id: 'c-2', title: 'Big refactor', description: 'Refactor the entire authentication pipeline including migration, rollback, multi-step orchestration, security audit, and cross-service coordination across five modules with backward-compatible API changes' }),
        ];
        const { ctx } = makeCtx({}, [
            brShowClosed('prev-1'),
            brReadyCall(nextBeads),
        ]);
        const result = await runAdvanceWave(ctx, { cwd: '/fake/project', closedBeadIds: ['prev-1'] });
        const data = result.structuredContent.data;
        expect(data.nextWave.complexity['c-1']).toBeDefined();
        expect(data.nextWave.complexity['c-2']).toBeDefined();
        expect(['simple', 'medium', 'complex']).toContain(data.nextWave.complexity['c-1']);
        expect(['simple', 'medium', 'complex']).toContain(data.nextWave.complexity['c-2']);
    });
    it('auto-closes stragglers with commits and still advances', async () => {
        const nextBeads = [makeBead({ id: 'ready-1', title: 'Next' })];
        const { ctx } = makeCtx({}, [
            brShowOpen('auto-1'),
            gitGrepFound('auto-1', 'abc1234'),
            brUpdate('auto-1'),
            brReadyCall(nextBeads),
        ]);
        const result = await runAdvanceWave(ctx, { cwd: '/fake/project', closedBeadIds: ['auto-1'] });
        const data = result.structuredContent.data;
        expect(data.verification.autoClosed).toEqual([{ beadId: 'auto-1', commit: 'abc1234' }]);
        expect(data.waveComplete).toBe(true);
        expect(data.nextWave).not.toBeNull();
        expect(data.nextWave.beadIds).toEqual(['ready-1']);
    });
    it('prompt includes bead ID, absolute project root, and coordinator identity', async () => {
        const nextBeads = [makeBead({ id: 'prompt-1', title: 'Check prompt' })];
        const { ctx } = makeCtx({}, [
            brShowClosed('prev-1'),
            brReadyCall(nextBeads),
        ]);
        const result = await runAdvanceWave(ctx, {
            cwd: '/fake/project',
            closedBeadIds: ['prev-1'],
            coordinatorName: 'WindyBasin',
        });
        const data = result.structuredContent.data;
        const prompt = data.nextWave.prompts[0].prompt;
        expect(prompt).toContain('prompt-1');
        expect(prompt).toContain("human_key='/fake/project'");
        expect(prompt).toContain("send_message to 'WindyBasin'");
    });
    it('keeps canonical lane shares for more beads than lanes', async () => {
        const nextBeads = [
            makeBead({ id: 'w-1' }),
            makeBead({ id: 'w-2' }),
            makeBead({ id: 'w-3' }),
            makeBead({ id: 'w-4' }),
            makeBead({ id: 'w-5' }),
        ];
        const { ctx } = makeCtx({}, [
            brShowClosed('prev-1'),
            brReadyCall(nextBeads),
        ]);
        const result = await runAdvanceWave(ctx, { cwd: '/fake/project', closedBeadIds: ['prev-1'], maxNextWave: 5 });
        const data = result.structuredContent.data;
        const lanes = data.nextWave.prompts.map((prompt) => prompt.lane);
        expect(lanes).toEqual(['cc', 'cc', 'pi', 'pi', 'gmi']);
    });
    it('reassigns a missing Gemini share to Pi', async () => {
        const nextBeads = Array.from({ length: 6 }, (_, index) => makeBead({
            id: `fallback-${index + 1}`,
            title: `Fallback ${index + 1}`,
        }));
        const { ctx } = makeCtx({}, [brShowClosed('prev-1'), brReadyCall(nextBeads)], availableCliCalls(false));
        const result = await runAdvanceWave(ctx, {
            cwd: '/fake/project',
            closedBeadIds: ['prev-1'],
            maxNextWave: 6,
        });
        const data = result.structuredContent.data;
        expect(data.nextWave.lanes).toEqual([
            { lane: 'cc', beadIds: ['fallback-1', 'fallback-2'] },
            {
                lane: 'pi',
                beadIds: ['fallback-3', 'fallback-4', 'fallback-5', 'fallback-6'],
            },
        ]);
    });
    it('reassigns missing Gemini and Pi shares to Codex', async () => {
        const nextBeads = Array.from({ length: 6 }, (_, index) => makeBead({
            id: `fallback-${index + 1}`,
            title: `Fallback ${index + 1}`,
        }));
        const { ctx } = makeCtx({}, [brShowClosed('prev-1'), brReadyCall(nextBeads)], availableCliCalls(false, false));
        const result = await runAdvanceWave(ctx, {
            cwd: '/fake/project',
            closedBeadIds: ['prev-1'],
            maxNextWave: 6,
        });
        const data = result.structuredContent.data;
        expect(data.nextWave.lanes).toEqual([
            { lane: 'cc', beadIds: ['fallback-1', 'fallback-2'] },
            {
                lane: 'cod',
                beadIds: ['fallback-3', 'fallback-4', 'fallback-5', 'fallback-6'],
            },
        ]);
    });
    it('dispatches only ready beads from the persisted goal program', async () => {
        const labelA = 'flywheel-goal:goal-a:ccba1a8c';
        const readyA = makeBead({ id: 'goal-a-ready', labels: [labelA] });
        const readyB = makeBead({
            id: 'goal-b-ready',
            labels: ['flywheel-goal:goal-b:9406de47'],
        });
        const { ctx } = makeCtx({ beadProgramScope: { kind: 'tagged', label: labelA } }, [brShowClosed('prev-1'), brReadyCall([readyB, readyA])]);
        const result = await runAdvanceWave(ctx, {
            cwd: '/fake/project',
            closedBeadIds: ['prev-1'],
            coordinatorName: 'WindyBasin',
        });
        const data = result.structuredContent.data;
        expect(data.nextWave.beadIds).toEqual([readyA.id]);
        expect(data.nextWave.prompts).toEqual([
            expect.objectContaining({ beadId: readyA.id }),
        ]);
    });
    it('reports the current program drained when only another program is ready', async () => {
        const labelA = 'flywheel-goal:goal-a:ccba1a8c';
        const readyB = makeBead({
            id: 'goal-b-ready',
            labels: ['flywheel-goal:goal-b:9406de47'],
        });
        const { ctx } = makeCtx({ beadProgramScope: { kind: 'tagged', label: labelA } }, [brShowClosed('prev-1'), brReadyCall([readyB])]);
        const result = await runAdvanceWave(ctx, {
            cwd: '/fake/project',
            closedBeadIds: ['prev-1'],
        });
        const data = result.structuredContent.data;
        expect(data.nextWave).toBeNull();
        expect(data.waveComplete).toBe(true);
        expect(result.content[0].text).toContain('Queue drained');
    });
    it('does not let a legacy checkpoint dispatch a newly tagged foreign program', async () => {
        const labelA = 'flywheel-goal:goal-a:ccba1a8c';
        const readyB = makeBead({
            id: 'goal-b-ready',
            labels: ['flywheel-goal:goal-b:9406de47'],
        });
        const legacyA = makeBead({ id: 'goal-a-legacy', status: 'closed' });
        const { ctx, state } = makeCtx({ beadProgramScope: { kind: 'legacy', label: labelA } }, [
            brShowClosed('prev-1'),
            brReadyCall([readyB]),
            brListAllCall([legacyA, readyB]),
        ]);
        const result = await runAdvanceWave(ctx, {
            cwd: '/fake/project',
            closedBeadIds: ['prev-1'],
        });
        const data = result.structuredContent.data;
        expect(data.nextWave).toBeNull();
        expect(state.beadProgramScope).toEqual({ kind: 'tagged', label: labelA });
        expect(result.content[0].text).toContain('repository-wide fallback is disabled');
    });
});
// ─── Completion Evidence Attestation gate (T2) ───────────
describe('runAdvanceWave — attestation gate', () => {
    let cwd;
    const origRequired = process.env.FW_ATTESTATION_REQUIRED;
    function validReport(beadId, overrides = {}) {
        return {
            version: 1,
            beadId,
            agentName: 'TestAgent',
            status: 'closed',
            changedFiles: ['src/foo.ts'],
            commits: ['abc1234'],
            ubs: { ran: true, summary: 'clean', findingsFixed: 0, deferredBeadIds: [] },
            verify: [{ command: 'npm test', exitCode: 0, summary: 'ok' }],
            selfReview: { ran: true, summary: 'looks good' },
            beadClosedVerified: true,
            reservationsReleased: true,
            createdAt: '2026-04-30T23:00:00.000Z',
            ...overrides,
        };
    }
    function makeCtxAt(tmpCwd, execCalls = []) {
        const state = makeState({
            selectedGoal: 'test goal',
            phase: 'implementing',
            beadResults: {},
        });
        const exec = createMockExec([
            ...availableCliCalls(),
            ...execCalls,
            brListAllCall([]),
        ]);
        return {
            exec,
            cwd: tmpCwd,
            state,
            saveState: (_s) => { },
            clearState: () => { },
        };
    }
    beforeEach(async () => {
        cwd = await mkdtemp(path.join(tmpdir(), 'fw-advance-attest-'));
        delete process.env.FW_ATTESTATION_REQUIRED;
    });
    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
        if (origRequired === undefined)
            delete process.env.FW_ATTESTATION_REQUIRED;
        else
            process.env.FW_ATTESTATION_REQUIRED = origRequired;
    });
    it('default mode: warns but advances when attestation is missing (needsEvidence=true)', async () => {
        const nextBeads = [makeBead({ id: 'next-1' })];
        const ctx = makeCtxAt(cwd, [brShowClosed('done-1'), brReadyCall(nextBeads)]);
        const result = await runAdvanceWave(ctx, { cwd, closedBeadIds: ['done-1'] });
        expect(result.isError).toBeUndefined();
        const data = result.structuredContent.data;
        expect(data.waveComplete).toBe(true);
        expect(data.nextWave).not.toBeNull();
        expect(data.needsEvidence).toBe(true);
        expect(data.verification.missingEvidence).toEqual(['done-1']);
        expect(result.content[0].text).toContain('without completion attestation');
    });
    it('default mode: needsEvidence=false when valid attestation present', async () => {
        await writeCompletionReport(cwd, validReport('done-1'));
        const nextBeads = [makeBead({ id: 'next-1' })];
        const ctx = makeCtxAt(cwd, [brShowClosed('done-1'), brReadyCall(nextBeads)]);
        const result = await runAdvanceWave(ctx, { cwd, closedBeadIds: ['done-1'] });
        const data = result.structuredContent.data;
        expect(data.needsEvidence).toBe(false);
        expect(data.verification.missingEvidence).toEqual([]);
    });
    it('FW_ATTESTATION_REQUIRED=1: blocks with attestation_missing error when no JSON', async () => {
        process.env.FW_ATTESTATION_REQUIRED = '1';
        const ctx = makeCtxAt(cwd, [brShowClosed('done-1')]);
        const result = await runAdvanceWave(ctx, { cwd, closedBeadIds: ['done-1'] });
        expect(result.isError).toBe(true);
        const sc = result.structuredContent;
        expect(sc.status).toBe('error');
        expect(sc.data.error.code).toBe('attestation_missing');
        expect(sc.data.error.hint).toBeTruthy();
        expect(sc.data.error.details.beadIds).toEqual(['done-1']);
    });
    it('FW_ATTESTATION_REQUIRED=1: blocks with attestation_invalid when schema fails', async () => {
        process.env.FW_ATTESTATION_REQUIRED = '1';
        await writeCompletionReport(cwd, validReport('done-1', { beadClosedVerified: false }));
        const ctx = makeCtxAt(cwd, [brShowClosed('done-1')]);
        const result = await runAdvanceWave(ctx, { cwd, closedBeadIds: ['done-1'] });
        expect(result.isError).toBe(true);
        const sc = result.structuredContent;
        expect(sc.data.error.code).toBe('attestation_invalid');
        expect(sc.data.error.hint).toBeTruthy();
    });
    it('FW_ATTESTATION_REQUIRED=1: passes through when valid attestation present', async () => {
        process.env.FW_ATTESTATION_REQUIRED = '1';
        await writeCompletionReport(cwd, validReport('done-1'));
        const ctx = makeCtxAt(cwd, [brShowClosed('done-1'), brReadyCall([])]);
        const result = await runAdvanceWave(ctx, { cwd, closedBeadIds: ['done-1'] });
        expect(result.isError).toBeUndefined();
        const data = result.structuredContent.data;
        expect(data.needsEvidence).toBe(false);
        expect(data.waveComplete).toBe(true);
    });
    it('FW_ATTESTATION_REQUIRED=0/false/empty: warn-only (Stage 1 default)', async () => {
        for (const v of ['0', 'false', '']) {
            process.env.FW_ATTESTATION_REQUIRED = v;
            const ctx = makeCtxAt(cwd, [brShowClosed('done-1'), brReadyCall([])]);
            const result = await runAdvanceWave(ctx, { cwd, closedBeadIds: ['done-1'] });
            expect(result.isError, `FW_ATTESTATION_REQUIRED=${JSON.stringify(v)} should be warn-only`).toBeUndefined();
            const data = result.structuredContent.data;
            expect(data.needsEvidence).toBe(true);
        }
    });
});
// ─── v3.17.0 fresh-eyes auto-trigger (batch-review gate) ─────────
describe('runAdvanceWave — batch-review gate (v3.17.0)', () => {
    beforeEach(() => {
        execFileMock.mockClear();
        gitExecHandler = () => new Error('execFile mock: not configured for this test');
    });
    it('flags a due batch review over the exact range and still dispatches the next wave', async () => {
        gitExecHandler = (cmd, args) => {
            expect(cmd).toBe('git');
            if (args[0] === 'rev-list') {
                expect(args).toEqual(['rev-list', '--count', 'abc123..HEAD']);
                return '8\n';
            }
            if (args[0] === 'rev-parse') {
                expect(args).toEqual(['rev-parse', 'HEAD']);
                return 'def456\n';
            }
            throw new Error(`unexpected git args: ${args.join(' ')}`);
        };
        const { ctx } = makeCtx({
            commitBatchThreshold: 8,
            lastBatchReviewSha: 'abc123',
        }, [brShowClosed('done-1'), brReadyCall([makeBead({ id: 'next-1' })])]);
        const result = await runAdvanceWave(ctx, {
            cwd: '/fake/project',
            closedBeadIds: ['done-1'],
        });
        expect(result.isError).toBeUndefined();
        const data = result.structuredContent.data;
        expect(data.nextStep).toEqual({
            kind: 'batch_review_due',
            reviewSha: 'def456',
            lastBaselineSha: 'abc123',
            shaRange: 'abc123..def456',
        });
        expect(data.nextWave.beadIds).toEqual(['next-1']);
        expect(data.waveComplete).toBe(true);
        expect(result.content[0].text).toContain('Batch review due over abc123..def456: call flywheel_review(action="batch_review", shaRange="abc123..def456")');
    });
    it('counts from cycleStartSha before the first review, and skips the gate with no baseline at all', async () => {
        gitExecHandler = (_cmd, args) => {
            if (args[0] !== 'rev-list')
                return 'def456\n';
            expect(args[2]).toBe('cyc000..HEAD');
            return '9\n';
        };
        const first = makeCtx({ commitBatchThreshold: 8, cycleStartSha: 'cyc000' }, [brShowClosed('done-1'), brReadyCall([makeBead({ id: 'next-1' })])]);
        const firstResult = await runAdvanceWave(first.ctx, { cwd: '/fake/project', closedBeadIds: ['done-1'] });
        expect(firstResult.structuredContent.data.nextStep.shaRange).toBe('cyc000..def456');
        execFileMock.mockClear();
        const none = makeCtx({ commitBatchThreshold: 8 }, [brShowClosed('done-1'), brReadyCall([makeBead({ id: 'next-1' })])]);
        const noneResult = await runAdvanceWave(none.ctx, { cwd: '/fake/project', closedBeadIds: ['done-1'] });
        expect(noneResult.structuredContent.data.nextStep).toBeUndefined();
        expect(execFileMock).not.toHaveBeenCalled();
    });
    it('omits batch_review_due when live commit count is below the threshold', async () => {
        // Live count of 7 < threshold 8 → feature enabled but doesn't fire yet.
        gitExecHandler = (cmd, args) => {
            expect(cmd).toBe('git');
            expect(args).toEqual(['rev-list', '--count', 'abc123..HEAD']);
            return '7\n';
        };
        const { ctx } = makeCtx({
            commitBatchThreshold: 8,
            lastBatchReviewSha: 'abc123',
        }, [brShowClosed('done-1'), brReadyCall([makeBead({ id: 'next-1' })])]);
        const result = await runAdvanceWave(ctx, {
            cwd: '/fake/project',
            closedBeadIds: ['done-1'],
        });
        const data = result.structuredContent.data;
        expect(data.nextStep).toBeUndefined();
        expect(data.nextWave).not.toBeNull();
        expect(data.nextWave.beadIds).toEqual(['next-1']);
        expect(data.waveComplete).toBe(true);
        // Only the rev-list count call fired; no rev-parse HEAD since gate didn't trip.
        expect(execFileMock).toHaveBeenCalledTimes(1);
    });
    it('regression: feature-disabled state preserves legacy nextWave shape', async () => {
        // threshold=0 explicitly disables the feature — no live count call should fire.
        const { ctx } = makeCtx({ commitBatchThreshold: 0 }, [brShowClosed('done-1'), brReadyCall([makeBead({ id: 'next-1' })])]);
        const result = await runAdvanceWave(ctx, {
            cwd: '/fake/project',
            closedBeadIds: ['done-1'],
        });
        const data = result.structuredContent.data;
        expect(data.nextStep).toBeUndefined();
        expect(data.nextWave).not.toBeNull();
        expect(data.nextWave.beadIds).toEqual(['next-1']);
        expect(data.waveComplete).toBe(true);
        // No git calls at all — gate short-circuits on the threshold check.
        expect(execFileMock).not.toHaveBeenCalled();
    });
    it('regression: legacy state (threshold undefined) preserves legacy shape', async () => {
        // No batch-review fields at all — v3.16 and earlier checkpoints.
        const { ctx } = makeCtx({}, [
            brShowClosed('done-1'),
            brReadyCall([makeBead({ id: 'next-1' })]),
        ]);
        const result = await runAdvanceWave(ctx, {
            cwd: '/fake/project',
            closedBeadIds: ['done-1'],
        });
        const data = result.structuredContent.data;
        expect(data.nextStep).toBeUndefined();
        expect(data.nextWave).not.toBeNull();
        expect(execFileMock).not.toHaveBeenCalled();
    });
    it('graceful degrade: git rev-list failure during gate skips to legacy nextWave', async () => {
        gitExecHandler = () => new Error('not a git repository');
        const { ctx } = makeCtx({
            commitBatchThreshold: 8,
            lastBatchReviewSha: 'abc123',
        }, [brShowClosed('done-1'), brReadyCall([makeBead({ id: 'next-1' })])]);
        const result = await runAdvanceWave(ctx, {
            cwd: '/fake/project',
            closedBeadIds: ['done-1'],
        });
        const data = result.structuredContent.data;
        // rev-list failed → count=0 → gate skipped → legacy flow.
        expect(data.nextStep).toBeUndefined();
        expect(data.nextWave).not.toBeNull();
        expect(data.nextWave.beadIds).toEqual(['next-1']);
        expect(execFileMock).toHaveBeenCalledTimes(1);
    });
    describe('pending batch reviews', () => {
        let projectDir;
        beforeEach(async () => {
            projectDir = await mkdtemp(path.join(tmpdir(), 'advance-wave-batch-'));
        });
        afterEach(async () => {
            await rm(projectDir, { recursive: true, force: true });
        });
        it('files beads from a verdict that landed and keeps waiting on one that has not', async () => {
            const landed = 'aaa111..bbb222';
            const waiting = 'bbb222..ccc333';
            const verdictDir = path.join(projectDir, '.pi-flywheel', 'batch-reviews');
            await mkdir(verdictDir, { recursive: true });
            await writeFile(path.join(verdictDir, `${landed}.json`), JSON.stringify({
                status: 'needs_attention',
                sha_range: landed,
                findings: [{
                        severity: 'low',
                        summary: 'log line repeats the bead id',
                        suggested_bead_title: 'Drop the duplicate bead id from the log line',
                        affected_files: ['src/log.ts'],
                        evidence_excerpt: 'log.info(id, id)',
                    }],
            }));
            const brCreates = [];
            gitExecHandler = (cmd, args) => {
                expect(cmd).toBe('br');
                brCreates.push([...args]);
                return 'bead-from-review\n';
            };
            const saved = [];
            const { ctx, state } = makeCtx({ pendingBatchReviews: [landed, waiting] }, [brShowClosed('done-1'), brReadyCall([makeBead({ id: 'bead-from-review' })])]);
            ctx.cwd = projectDir;
            ctx.saveState = (s) => { saved.push(structuredClone(s)); };
            const result = await runAdvanceWave(ctx, { cwd: projectDir, closedBeadIds: ['done-1'] });
            const data = result.structuredContent.data;
            expect(brCreates).toHaveLength(1);
            expect(brCreates[0][brCreates[0].indexOf('--priority') + 1]).toBe('3');
            expect(data.batchReviews).toEqual({
                filed: [{ shaRange: landed, beadIds: ['bead-from-review'] }],
                pending: [waiting],
            });
            expect(state.pendingBatchReviews).toEqual([waiting]);
            expect(saved[0]?.pendingBatchReviews).toEqual([waiting]);
            expect(data.nextWave.beadIds).toEqual(['bead-from-review']);
            const text = result.content[0].text;
            expect(text).toContain(`Batch review ${landed}: filed 1 bead(s) from its findings: bead-from-review.`);
            expect(text).toContain(`Batch review ${waiting}: waiting on the reviewer's verdict.`);
        });
        it('keeps a range pending and still advances when br create fails', async () => {
            const range = 'aaa111..bbb222';
            const verdictDir = path.join(projectDir, '.pi-flywheel', 'batch-reviews');
            await mkdir(verdictDir, { recursive: true });
            await writeFile(path.join(verdictDir, `${range}.json`), JSON.stringify({
                status: 'blocking',
                sha_range: range,
                findings: [{
                        severity: 'high',
                        summary: 'cache never expires',
                        suggested_bead_title: 'Expire cache entries',
                        affected_files: ['src/cache.ts'],
                        evidence_excerpt: 'ttl = Infinity',
                    }],
            }));
            gitExecHandler = () => new Error('database is locked');
            const { ctx, state } = makeCtx({ pendingBatchReviews: [range] }, [brShowClosed('done-1'), brReadyCall([makeBead({ id: 'next-1' })])]);
            ctx.cwd = projectDir;
            const result = await runAdvanceWave(ctx, { cwd: projectDir, closedBeadIds: ['done-1'] });
            const data = result.structuredContent.data;
            expect(data.batchReviews).toEqual({ filed: [], pending: [range] });
            expect(state.pendingBatchReviews).toEqual([range]);
            expect(data.nextWave.beadIds).toEqual(['next-1']);
        });
    });
});
//# sourceMappingURL=advance-wave.test.js.map