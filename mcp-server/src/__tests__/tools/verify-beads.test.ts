import { describe, it, expect, vi } from 'vitest';
import { runVerifyBeads } from '../../tools/verify-beads.js';
import { createMockExec, makeState } from '../helpers/mocks.js';
import type { FlywheelState, Bead } from '../../types.js';
import type { ExecCall } from '../helpers/mocks.js';

// ─── Helpers ──────────────────────────────────────────────────

function makeBead(overrides: Partial<Bead> = {}): Bead {
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

function makeCtx(
  stateOverrides: Partial<FlywheelState> = {},
  execCalls: ExecCall[] = [],
) {
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
    saveState: (_s: FlywheelState) => {},
    clearState: () => {},
  };
  return { ctx, state };
}

function brShowCall(bead: Bead): ExecCall {
  return {
    cmd: 'br',
    args: ['show', bead.id, '--json'],
    result: { code: 0, stdout: JSON.stringify(bead), stderr: '' },
  };
}

/** Matches the real br v0.1.x `br show --json` shape: single-element array. */
function brShowArrayCall(bead: Bead): ExecCall {
  return {
    cmd: 'br',
    args: ['show', bead.id, '--json'],
    result: { code: 0, stdout: JSON.stringify([bead]), stderr: '' },
  };
}

/** Regression: some br forks wrap the bead in { bead: {...} }. */
function brShowWrappedCall(bead: Bead): ExecCall {
  return {
    cmd: 'br',
    args: ['show', bead.id, '--json'],
    result: { code: 0, stdout: JSON.stringify({ bead }), stderr: '' },
  };
}

function brShowError(beadId: string, stderr: string): ExecCall {
  return {
    cmd: 'br',
    args: ['show', beadId, '--json'],
    result: { code: 1, stdout: '', stderr }, // non-empty stderr → permanent (no retries)
  };
}

function brUpdateCall(beadId: string, status: string): ExecCall {
  return {
    cmd: 'br',
    args: ['update', beadId, '--status', status],
    result: { code: 0, stdout: '', stderr: '' },
  };
}

function gitGrepCall(beadId: string, line: string): ExecCall {
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
    const data = (result.structuredContent as any).data;
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

    const data = (result.structuredContent as any).data;
    // Before the fix this returned errors: { 'arr-1': 'parse_failure...', 'arr-2': 'parse_failure...' }
    expect(data.errors).toEqual({});
    expect(data.verified).toEqual(['arr-1']);
    expect(data.unclosedNoCommit).toEqual([{ id: 'arr-2', status: 'in_progress' }]);
  });

  it('unwraps { bead: {...} } shape (regression: br fork wrapper)', async () => {
    const a = makeBead({ id: 'wrap-1', status: 'closed' });
    const { ctx } = makeCtx({}, [brShowWrappedCall(a)]);

    const result = await runVerifyBeads(ctx, { cwd: '/fake/cwd', beadIds: ['wrap-1'] });

    const data = (result.structuredContent as any).data;
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

    const data = (result.structuredContent as any).data;
    expect(data.verified.sort()).toEqual(['cl-1', 'op-1']);
    expect(data.autoClosed).toEqual([{ beadId: 'op-1', commit: 'abc1234' }]);
    expect(data.unclosedNoCommit).toEqual([]);

    // State must be reconciled so subsequent flywheel_review short-circuits cleanly.
    expect(state.beadResults!['op-1']).toEqual({
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

    const data = (result.structuredContent as any).data;
    expect(data.verified).toEqual([]);
    expect(data.autoClosed).toEqual([]);
    expect(data.unclosedNoCommit).toEqual([{ id: 'op-2', status: 'open' }]);
    expect(state.beadResults!['op-2']).toBeUndefined();
    expect(result.content[0].text).toContain('without commits');
  });

  it('records br show failures in errors map without crashing', async () => {
    const closed = makeBead({ id: 'ok-1', status: 'closed' });
    const { ctx } = makeCtx({}, [
      brShowCall(closed),
      brShowError('missing-1', 'bead not found'),
    ]);

    const result = await runVerifyBeads(ctx, { cwd: '/fake/cwd', beadIds: ['ok-1', 'missing-1'] });

    const data = (result.structuredContent as any).data;
    expect(data.verified).toEqual(['ok-1']);
    expect(Object.keys(data.errors)).toContain('missing-1');
    expect(data.errors['missing-1']).toContain('bead not found');
  });

  it('returns cli_failure error when verifyBeadsClosed throws', async () => {
    const beadsModule = await import('../../beads.js');
    const spy = vi.spyOn(beadsModule, 'verifyBeadsClosed').mockRejectedValueOnce(
      new Error('Timed out after 8000ms: br show tb-1 --json')
    );

    const { ctx } = makeCtx({}, []);

    const result = await runVerifyBeads(ctx, { cwd: '/fake/cwd', beadIds: ['tb-1'] });

    expect(result.isError).toBe(true);
    const sc = result.structuredContent as any;
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

    const data = (result.structuredContent as any).data;
    expect(data.autoClosed).toEqual([]);
    expect(data.unclosedNoCommit).toEqual([{ id: 'op-3', status: 'in_progress' }]);
    expect(data.errors['op-3']).toContain('auto-close failed');
    expect(state.beadResults!['op-3']).toBeUndefined();
  });
});
