import { describe, it, expect } from 'vitest';
import { runAdvanceWave } from '../../tools/advance-wave.js';
import { createMockExec, makeState } from '../helpers/mocks.js';
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
function makeCtx(stateOverrides = {}, execCalls = []) {
    const state = makeState({
        phase: 'implementing',
        beadResults: {},
        ...stateOverrides,
    });
    const exec = createMockExec(execCalls);
    const ctx = {
        exec,
        cwd: '/fake/project',
        state,
        saveState: (_s) => { },
        clearState: () => { },
    };
    return { ctx, state };
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
        args: ['ready', '--json'],
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
    it('dispatches next wave with round-robin lane assignment', async () => {
        const nextBeads = [
            makeBead({ id: 'next-1', title: 'First' }),
            makeBead({ id: 'next-2', title: 'Second' }),
            makeBead({ id: 'next-3', title: 'Third' }),
        ];
        const { ctx } = makeCtx({}, [
            brShowClosed('prev-1'),
            brReadyCall(nextBeads),
        ]);
        const result = await runAdvanceWave(ctx, { cwd: '/fake/project', closedBeadIds: ['prev-1'] });
        expect(result.isError).toBeUndefined();
        const data = result.structuredContent.data;
        expect(data.waveComplete).toBe(true);
        expect(data.nextWave).not.toBeNull();
        expect(data.nextWave.beadIds).toEqual(['next-1', 'next-2', 'next-3']);
        const lanes = data.nextWave.prompts.map((p) => p.lane);
        expect(lanes).toEqual(['cc', 'cod', 'gem']);
        for (const p of data.nextWave.prompts) {
            expect(p.prompt).toBeTruthy();
            expect(typeof p.prompt).toBe('string');
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
    it('prompt includes bead ID and project key', async () => {
        const nextBeads = [makeBead({ id: 'prompt-1', title: 'Check prompt' })];
        const { ctx } = makeCtx({}, [
            brShowClosed('prev-1'),
            brReadyCall(nextBeads),
        ]);
        const result = await runAdvanceWave(ctx, { cwd: '/fake/project', closedBeadIds: ['prev-1'] });
        const data = result.structuredContent.data;
        const prompt = data.nextWave.prompts[0].prompt;
        expect(prompt).toContain('prompt-1');
        expect(prompt).toContain('project');
    });
    it('wraps lane assignment for more beads than lanes', async () => {
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
        const lanes = data.nextWave.prompts.map((p) => p.lane);
        expect(lanes).toEqual(['cc', 'cod', 'gem', 'cc', 'cod']);
    });
});
//# sourceMappingURL=advance-wave.test.js.map