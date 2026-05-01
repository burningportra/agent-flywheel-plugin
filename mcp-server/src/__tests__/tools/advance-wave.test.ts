import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runAdvanceWave } from '../../tools/advance-wave.js';
import { writeCompletionReport, type CompletionReportV1 } from '../../completion-report.js';
import { createMockExec, makeState } from '../helpers/mocks.js';
import type { FlywheelState, Bead } from '../../types.js';
import type { ExecCall } from '../helpers/mocks.js';

// ─── Helpers ──────────────────────────────────────────────────

function makeBead(overrides: Partial<Bead> = {}): Bead {
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

function makeCtx(
  stateOverrides: Partial<FlywheelState> = {},
  execCalls: ExecCall[] = [],
) {
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
    saveState: (_s: FlywheelState) => {},
    clearState: () => {},
  };
  return { ctx, state };
}

function brShowClosed(id: string): ExecCall {
  return {
    cmd: 'br',
    args: ['show', id, '--json'],
    result: { code: 0, stdout: JSON.stringify(makeBead({ id, status: 'closed' })), stderr: '' },
  };
}

function brShowOpen(id: string): ExecCall {
  return {
    cmd: 'br',
    args: ['show', id, '--json'],
    result: { code: 0, stdout: JSON.stringify(makeBead({ id, status: 'open' })), stderr: '' },
  };
}

function gitGrepEmpty(id: string): ExecCall {
  return {
    cmd: 'git',
    args: ['log', `--grep=${id}`, '--oneline', '-1'],
    result: { code: 0, stdout: '', stderr: '' },
  };
}

function gitGrepFound(id: string, sha: string): ExecCall {
  return {
    cmd: 'git',
    args: ['log', `--grep=${id}`, '--oneline', '-1'],
    result: { code: 0, stdout: `${sha} fix(${id}): done`, stderr: '' },
  };
}

function brUpdate(id: string): ExecCall {
  return {
    cmd: 'br',
    args: ['update', id, '--status', 'closed'],
    result: { code: 0, stdout: '', stderr: '' },
  };
}

function brReadyCall(beads: Bead[]): ExecCall {
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
    const data = (result.structuredContent as any).data;
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
    const data = (result.structuredContent as any).data;
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
    const data = (result.structuredContent as any).data;
    expect(data.waveComplete).toBe(true);
    expect(data.nextWave).not.toBeNull();
    expect(data.nextWave.beadIds).toEqual(['next-1', 'next-2', 'next-3']);

    const lanes = data.nextWave.prompts.map((p: any) => p.lane);
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

    const data = (result.structuredContent as any).data;
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

    const data = (result.structuredContent as any).data;
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

    const data = (result.structuredContent as any).data;
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

    const data = (result.structuredContent as any).data;
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

    const data = (result.structuredContent as any).data;
    const lanes = data.nextWave.prompts.map((p: any) => p.lane);
    expect(lanes).toEqual(['cc', 'cod', 'gem', 'cc', 'cod']);
  });
});

// ─── Completion Evidence Attestation gate (T2) ───────────

describe('runAdvanceWave — attestation gate', () => {
  let cwd: string;
  const origRequired = process.env.FW_ATTESTATION_REQUIRED;

  function validReport(beadId: string, overrides: Partial<CompletionReportV1> = {}): CompletionReportV1 {
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

  function makeCtxAt(tmpCwd: string, execCalls: ExecCall[] = []) {
    const state = makeState({ phase: 'implementing', beadResults: {} });
    const exec = createMockExec(execCalls);
    return {
      exec,
      cwd: tmpCwd,
      state,
      saveState: (_s: FlywheelState) => {},
      clearState: () => {},
    };
  }

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'fw-advance-attest-'));
    delete process.env.FW_ATTESTATION_REQUIRED;
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    if (origRequired === undefined) delete process.env.FW_ATTESTATION_REQUIRED;
    else process.env.FW_ATTESTATION_REQUIRED = origRequired;
  });

  it('default mode: warns but advances when attestation is missing (needsEvidence=true)', async () => {
    const nextBeads = [makeBead({ id: 'next-1' })];
    const ctx = makeCtxAt(cwd, [brShowClosed('done-1'), brReadyCall(nextBeads)]);
    const result = await runAdvanceWave(ctx, { cwd, closedBeadIds: ['done-1'] });
    expect(result.isError).toBeUndefined();
    const data = (result.structuredContent as any).data;
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
    const data = (result.structuredContent as any).data;
    expect(data.needsEvidence).toBe(false);
    expect(data.verification.missingEvidence).toEqual([]);
  });

  it('FW_ATTESTATION_REQUIRED=1: blocks with attestation_missing error when no JSON', async () => {
    process.env.FW_ATTESTATION_REQUIRED = '1';
    const ctx = makeCtxAt(cwd, [brShowClosed('done-1')]);
    const result = await runAdvanceWave(ctx, { cwd, closedBeadIds: ['done-1'] });
    expect(result.isError).toBe(true);
    const sc = result.structuredContent as any;
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
    const sc = result.structuredContent as any;
    expect(sc.data.error.code).toBe('attestation_invalid');
    expect(sc.data.error.hint).toBeTruthy();
  });

  it('FW_ATTESTATION_REQUIRED=1: passes through when valid attestation present', async () => {
    process.env.FW_ATTESTATION_REQUIRED = '1';
    await writeCompletionReport(cwd, validReport('done-1'));
    const ctx = makeCtxAt(cwd, [brShowClosed('done-1'), brReadyCall([])]);
    const result = await runAdvanceWave(ctx, { cwd, closedBeadIds: ['done-1'] });
    expect(result.isError).toBeUndefined();
    const data = (result.structuredContent as any).data;
    expect(data.needsEvidence).toBe(false);
    expect(data.waveComplete).toBe(true);
  });

  it('FW_ATTESTATION_REQUIRED=0/false/empty: warn-only (Stage 1 default)', async () => {
    for (const v of ['0', 'false', '']) {
      process.env.FW_ATTESTATION_REQUIRED = v;
      const ctx = makeCtxAt(cwd, [brShowClosed('done-1'), brReadyCall([])]);
      const result = await runAdvanceWave(ctx, { cwd, closedBeadIds: ['done-1'] });
      expect(result.isError, `FW_ATTESTATION_REQUIRED=${JSON.stringify(v)} should be warn-only`).toBeUndefined();
      const data = (result.structuredContent as any).data;
      expect(data.needsEvidence).toBe(true);
    }
  });
});
