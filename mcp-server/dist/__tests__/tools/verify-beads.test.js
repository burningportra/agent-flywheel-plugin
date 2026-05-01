import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runVerifyBeads } from '../../tools/verify-beads.js';
import { writeCompletionReport } from '../../completion-report.js';
import { createMockExec, makeState } from '../helpers/mocks.js';
// ─── Helpers ──────────────────────────────────────────────────
function makeBead(overrides = {}) {
    return {
        id: 'tb-1',
        title: 'Bead under test',
        description: 'desc',
        status: 'closed',
        priority: 2,
        type: 'task',
        labels: [],
        ...overrides,
    };
}
function makeCtx(stateOverrides = {}, execCalls = []) {
    const state = makeState({
        phase: 'reviewing',
        beadResults: {},
        ...stateOverrides,
    });
    const exec = createMockExec(execCalls);
    const ctx = {
        exec,
        cwd: '/fake/cwd',
        state,
        saveState: (_s) => { },
        clearState: () => { },
    };
    return { ctx, state };
}
function brShowCall(bead) {
    return {
        cmd: 'br',
        args: ['show', bead.id, '--json'],
        result: { code: 0, stdout: JSON.stringify(bead), stderr: '' },
    };
}
/** Matches the real br v0.1.x `br show --json` shape: single-element array. */
function brShowArrayCall(bead) {
    return {
        cmd: 'br',
        args: ['show', bead.id, '--json'],
        result: { code: 0, stdout: JSON.stringify([bead]), stderr: '' },
    };
}
/** Regression: some br forks wrap the bead in { bead: {...} }. */
function brShowWrappedCall(bead) {
    return {
        cmd: 'br',
        args: ['show', bead.id, '--json'],
        result: { code: 0, stdout: JSON.stringify({ bead }), stderr: '' },
    };
}
function brShowError(beadId, stderr) {
    return {
        cmd: 'br',
        args: ['show', beadId, '--json'],
        result: { code: 1, stdout: '', stderr }, // non-empty stderr → permanent (no retries)
    };
}
function brUpdateCall(beadId, status) {
    return {
        cmd: 'br',
        args: ['update', beadId, '--status', status],
        result: { code: 0, stdout: '', stderr: '' },
    };
}
function gitGrepCall(beadId, line) {
    return {
        cmd: 'git',
        args: ['log', `--grep=${beadId}`, '--oneline', '-1'],
        result: { code: 0, stdout: line, stderr: '' },
    };
}
// ─── Tests ────────────────────────────────────────────────────
describe('runVerifyBeads', () => {
    it('returns invalid_input error when beadIds is empty', async () => {
        const { ctx } = makeCtx();
        const result = await runVerifyBeads(ctx, { cwd: '/fake/cwd', beadIds: [] });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
            tool: 'flywheel_verify_beads',
            version: 1,
            status: 'error',
            data: { error: { code: 'invalid_input' } },
        });
    });
    it('reports all beads verified when each br show returns status closed (object shape)', async () => {
        const a = makeBead({ id: 'a-1', status: 'closed' });
        const b = makeBead({ id: 'b-2', status: 'closed' });
        const { ctx } = makeCtx({}, [brShowCall(a), brShowCall(b)]);
        const result = await runVerifyBeads(ctx, { cwd: '/fake/cwd', beadIds: ['a-1', 'b-2'] });
        expect(result.isError).toBeUndefined();
        const data = result.structuredContent.data;
        expect(data.verified).toEqual(['a-1', 'b-2']);
        expect(data.autoClosed).toEqual([]);
        expect(data.unclosedNoCommit).toEqual([]);
        expect(data.errors).toEqual({});
    });
    it('unwraps br show single-element array shape [{...}] (regression: br v0.1.x)', async () => {
        const a = makeBead({ id: 'arr-1', status: 'closed' });
        const b = makeBead({ id: 'arr-2', status: 'in_progress' });
        const { ctx } = makeCtx({}, [
            brShowArrayCall(a),
            brShowArrayCall(b),
            { cmd: 'git', args: ['log', '--grep=arr-2', '--oneline', '-1'], result: { code: 0, stdout: '', stderr: '' } },
        ]);
        const result = await runVerifyBeads(ctx, { cwd: '/fake/cwd', beadIds: ['arr-1', 'arr-2'] });
        const data = result.structuredContent.data;
        // Before the fix this returned errors: { 'arr-1': 'parse_failure...', 'arr-2': 'parse_failure...' }
        expect(data.errors).toEqual({});
        expect(data.verified).toEqual(['arr-1']);
        expect(data.unclosedNoCommit).toEqual([{ id: 'arr-2', status: 'in_progress' }]);
    });
    it('unwraps { bead: {...} } shape (regression: br fork wrapper)', async () => {
        const a = makeBead({ id: 'wrap-1', status: 'closed' });
        const { ctx } = makeCtx({}, [brShowWrappedCall(a)]);
        const result = await runVerifyBeads(ctx, { cwd: '/fake/cwd', beadIds: ['wrap-1'] });
        const data = result.structuredContent.data;
        expect(data.errors).toEqual({});
        expect(data.verified).toEqual(['wrap-1']);
    });
    it('auto-closes stragglers that have a matching commit and updates state', async () => {
        const open = makeBead({ id: 'op-1', status: 'in_progress' });
        const closed = makeBead({ id: 'cl-1', status: 'closed' });
        const { ctx, state } = makeCtx({}, [
            brShowCall(open),
            brShowCall(closed),
            gitGrepCall('op-1', 'abc1234 bead op-1: did the work'),
            brUpdateCall('op-1', 'closed'),
        ]);
        const result = await runVerifyBeads(ctx, { cwd: '/fake/cwd', beadIds: ['op-1', 'cl-1'] });
        const data = result.structuredContent.data;
        expect(data.verified.sort()).toEqual(['cl-1', 'op-1']);
        expect(data.autoClosed).toEqual([{ beadId: 'op-1', commit: 'abc1234' }]);
        expect(data.unclosedNoCommit).toEqual([]);
        // State must be reconciled so subsequent flywheel_review short-circuits cleanly.
        expect(state.beadResults['op-1']).toEqual({
            beadId: 'op-1',
            status: 'success',
            summary: 'Auto-closed by flywheel_verify_beads (commit: abc1234)',
        });
    });
    it('reports unclosedNoCommit when straggler has no matching commit', async () => {
        const open = makeBead({ id: 'op-2', status: 'open' });
        const { ctx, state } = makeCtx({}, [
            brShowCall(open),
            // git log returns empty stdout → no commit found
            { cmd: 'git', args: ['log', '--grep=op-2', '--oneline', '-1'], result: { code: 0, stdout: '', stderr: '' } },
        ]);
        const result = await runVerifyBeads(ctx, { cwd: '/fake/cwd', beadIds: ['op-2'] });
        const data = result.structuredContent.data;
        expect(data.verified).toEqual([]);
        expect(data.autoClosed).toEqual([]);
        expect(data.unclosedNoCommit).toEqual([{ id: 'op-2', status: 'open' }]);
        expect(state.beadResults['op-2']).toBeUndefined();
        expect(result.content[0].text).toContain('without commits');
    });
    it('records br show failures in errors map without crashing', async () => {
        const closed = makeBead({ id: 'ok-1', status: 'closed' });
        const { ctx } = makeCtx({}, [
            brShowCall(closed),
            brShowError('missing-1', 'bead not found'),
        ]);
        const result = await runVerifyBeads(ctx, { cwd: '/fake/cwd', beadIds: ['ok-1', 'missing-1'] });
        const data = result.structuredContent.data;
        expect(data.verified).toEqual(['ok-1']);
        expect(Object.keys(data.errors)).toContain('missing-1');
        expect(data.errors['missing-1']).toContain('bead not found');
    });
    it('returns cli_failure error when verifyBeadsClosed throws', async () => {
        const beadsModule = await import('../../beads.js');
        const spy = vi.spyOn(beadsModule, 'verifyBeadsClosed').mockRejectedValueOnce(new Error('Timed out after 8000ms: br show tb-1 --json'));
        const { ctx } = makeCtx({}, []);
        const result = await runVerifyBeads(ctx, { cwd: '/fake/cwd', beadIds: ['tb-1'] });
        expect(result.isError).toBe(true);
        const sc = result.structuredContent;
        expect(sc.status).toBe('error');
        expect(sc.data.error.code).toBe('exec_timeout');
        expect(sc.data.error.retryable).toBe(true);
        expect(result.content[0].text).toContain('Error verifying beads');
        spy.mockRestore();
    });
    it('records auto-close failure under errors and leaves bead in unclosedNoCommit', async () => {
        const open = makeBead({ id: 'op-3', status: 'in_progress' });
        const { ctx, state } = makeCtx({}, [
            brShowCall(open),
            gitGrepCall('op-3', 'def5678 bead op-3: ship it'),
            // br update fails (non-empty stderr → permanent so no retry)
            { cmd: 'br', args: ['update', 'op-3', '--status', 'closed'], result: { code: 1, stdout: '', stderr: 'db locked' } },
        ]);
        const result = await runVerifyBeads(ctx, { cwd: '/fake/cwd', beadIds: ['op-3'] });
        const data = result.structuredContent.data;
        expect(data.autoClosed).toEqual([]);
        expect(data.unclosedNoCommit).toEqual([{ id: 'op-3', status: 'in_progress' }]);
        expect(data.errors['op-3']).toContain('auto-close failed');
        expect(state.beadResults['op-3']).toBeUndefined();
    });
});
// ─── Completion Evidence Attestation (T2) ─────────────────
describe('runVerifyBeads — attestation evidence', () => {
    let cwd;
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
        const state = makeState({ phase: 'reviewing', beadResults: {} });
        const exec = createMockExec(execCalls);
        return {
            exec,
            cwd: tmpCwd,
            state,
            saveState: (_s) => { },
            clearState: () => { },
        };
    }
    function brShowClosedReal(id) {
        return {
            cmd: 'br',
            args: ['show', id, '--json'],
            result: { code: 0, stdout: JSON.stringify(makeBead({ id, status: 'closed' })), stderr: '' },
        };
    }
    beforeEach(async () => {
        cwd = await mkdtemp(path.join(tmpdir(), 'fw-verify-attest-'));
    });
    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
    });
    it('reports missing attestation for closed beads with no JSON file', async () => {
        const ctx = makeCtxAt(cwd, [brShowClosedReal('done-1'), brShowClosedReal('done-2')]);
        const result = await runVerifyBeads(ctx, { cwd, beadIds: ['done-1', 'done-2'] });
        expect(result.isError).toBeUndefined();
        const data = result.structuredContent.data;
        expect(data.verified).toEqual(['done-1', 'done-2']);
        expect(data.missingEvidence).toEqual(['done-1', 'done-2']);
        expect(data.invalidEvidence).toEqual([]);
        expect(result.content[0].text).toContain('missing completion attestation');
    });
    it('reports no missing attestation when valid reports exist for every bead', async () => {
        await writeCompletionReport(cwd, validReport('done-1'));
        await writeCompletionReport(cwd, validReport('done-2'));
        const ctx = makeCtxAt(cwd, [brShowClosedReal('done-1'), brShowClosedReal('done-2')]);
        const result = await runVerifyBeads(ctx, { cwd, beadIds: ['done-1', 'done-2'] });
        const data = result.structuredContent.data;
        expect(data.missingEvidence).toEqual([]);
        expect(data.invalidEvidence).toEqual([]);
    });
    it('reports schema_invalid for malformed JSON', async () => {
        const filePath = path.join(cwd, '.pi-flywheel/completion/done-1.json');
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, JSON.stringify({ version: 1, beadId: 'done-1' }), 'utf8');
        const ctx = makeCtxAt(cwd, [brShowClosedReal('done-1')]);
        const result = await runVerifyBeads(ctx, { cwd, beadIds: ['done-1'] });
        const data = result.structuredContent.data;
        expect(data.invalidEvidence).toHaveLength(1);
        expect(data.invalidEvidence[0]).toMatchObject({ beadId: 'done-1', code: 'schema_invalid' });
    });
    it('reports invalid_json for unparseable JSON', async () => {
        const filePath = path.join(cwd, '.pi-flywheel/completion/done-1.json');
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, '{ not json', 'utf8');
        const ctx = makeCtxAt(cwd, [brShowClosedReal('done-1')]);
        const result = await runVerifyBeads(ctx, { cwd, beadIds: ['done-1'] });
        const data = result.structuredContent.data;
        expect(data.invalidEvidence).toHaveLength(1);
        expect(data.invalidEvidence[0].code).toBe('invalid_json');
    });
    it('reports closed_without_verification when status=closed but beadClosedVerified=false', async () => {
        await writeCompletionReport(cwd, validReport('done-1', { beadClosedVerified: false }));
        const ctx = makeCtxAt(cwd, [brShowClosedReal('done-1')]);
        const result = await runVerifyBeads(ctx, { cwd, beadIds: ['done-1'] });
        const data = result.structuredContent.data;
        expect(data.invalidEvidence).toHaveLength(1);
        expect(data.invalidEvidence[0].code).toBe('closed_without_verification');
    });
    it('does NOT check attestation for stragglers without commits', async () => {
        const ctx = makeCtxAt(cwd, [
            {
                cmd: 'br',
                args: ['show', 'strag-1', '--json'],
                result: { code: 0, stdout: JSON.stringify(makeBead({ id: 'strag-1', status: 'open' })), stderr: '' },
            },
            {
                cmd: 'git',
                args: ['log', '--grep=strag-1', '--oneline', '-1'],
                result: { code: 0, stdout: '', stderr: '' },
            },
        ]);
        const result = await runVerifyBeads(ctx, { cwd, beadIds: ['strag-1'] });
        const data = result.structuredContent.data;
        expect(data.missingEvidence).toEqual([]);
        expect(data.invalidEvidence).toEqual([]);
        expect(data.unclosedNoCommit).toHaveLength(1);
    });
});
//# sourceMappingURL=verify-beads.test.js.map