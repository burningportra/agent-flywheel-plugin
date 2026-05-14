import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { FlywheelState, Bead } from '../../types.js';
import type { ExecCall } from '../helpers/mocks.js';

// ─── node:child_process.execFile mock (T6 — v3.17.0 batch-review gate) ──
//
// advance-wave.ts T3 hook calls `execFile('git', ['rev-parse', 'HEAD'])` via
// `promisify(execFile)` to capture the dispatch baseline. The existing tests
// use a `ctx.exec` mock for shell calls routed through ExecFn, but T3's git
// call bypasses ctx.exec and hits child_process directly — so we need a
// module-level mock to intercept it.
//
// Implementation notes:
//   • `vi.importActual` preserves the rest of child_process so any indirect
//     imports from the runtime aren't broken.
//   • The real execFile has a `[util.promisify.custom]` symbol that makes
//     `promisify(execFile)` resolve with `{ stdout, stderr }`. Without it,
//     promisify defaults to single-arg resolution. We replicate the symbol
//     so the module under test sees the same contract.
//   • execHandler is the per-test seam; default = HEAD missing so existing
//     tests (no commitBatchThreshold) remain unaffected (gate short-circuits
//     on git failure → falls through to legacy nextWave path).

type GitExecHandler = (
  cmd: string,
  args: readonly string[],
) => string | Error;

let gitExecHandler: GitExecHandler = () =>
  new Error('execFile mock: not configured for this test');

const execFileMock = vi.fn(
  (
    _cmd: string,
    _args: readonly string[],
    _opts: unknown,
    _callback: (err: Error | null, stdout?: string, stderr?: string) => void,
  ) => ({ pid: 1, kill: vi.fn() }),
);

(execFileMock as unknown as { [k: symbol]: unknown })[promisify.custom] = (
  cmd: string,
  args: readonly string[],
  opts?: unknown,
): Promise<{ stdout: string; stderr: string }> => {
  execFileMock(cmd, args, opts, () => undefined);
  const result = gitExecHandler(cmd, args);
  if (result instanceof Error) return Promise.reject(result);
  return Promise.resolve({ stdout: result, stderr: '' });
};

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>(
    'node:child_process',
  );
  return { ...actual, execFile: execFileMock };
});

// Module under test must be imported AFTER vi.mock so promisify(execFile)
// binds the mock at module load time.
const { runAdvanceWave } = await import('../../tools/advance-wave.js');
const { writeCompletionReport } = await import('../../completion-report.js');
type CompletionReportV1 = import('../../completion-report.js').CompletionReportV1;
const { createMockExec, makeState } = await import('../helpers/mocks.js');

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

// ─── v3.17.0 fresh-eyes auto-trigger (batch-review gate) ─────────

describe('runAdvanceWave — batch-review gate (v3.17.0)', () => {
  beforeEach(() => {
    execFileMock.mockClear();
    gitExecHandler = () =>
      new Error('execFile mock: not configured for this test');
  });

  it('returns batch_review_due nextStep when live commit count crosses threshold', async () => {
    // Live count via `git rev-list --count abc123..HEAD` returns 8 → meets threshold 8.
    // Then `git rev-parse HEAD` returns the reviewSha.
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
    const { ctx } = makeCtx(
      {
        commitBatchThreshold: 8,
        lastBatchReviewSha: 'abc123',
      },
      [brShowClosed('done-1')],
    );

    const result = await runAdvanceWave(ctx, {
      cwd: '/fake/project',
      closedBeadIds: ['done-1'],
    });

    expect(result.isError).toBeUndefined();
    const data = (result.structuredContent as any).data;
    expect(data.nextStep).toBeDefined();
    expect(data.nextStep.kind).toBe('batch_review_due');
    expect(data.nextStep.reviewSha).toBe('def456');
    expect(data.nextStep.lastBaselineSha).toBe('abc123');
    // Wave isn't fully done until the review verdict lands.
    expect(data.nextWave).toBeNull();
    expect(data.waveComplete).toBe(false);
    // Two git calls: rev-list --count then rev-parse HEAD. No br ready.
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(result.content[0].text).toContain('Batch-review threshold crossed');
  });

  it('omits batch_review_due when live commit count is below the threshold', async () => {
    // Live count of 7 < threshold 8 → feature enabled but doesn't fire yet.
    gitExecHandler = (cmd, args) => {
      expect(cmd).toBe('git');
      expect(args).toEqual(['rev-list', '--count', 'abc123..HEAD']);
      return '7\n';
    };
    const { ctx } = makeCtx(
      {
        commitBatchThreshold: 8,
        lastBatchReviewSha: 'abc123',
      },
      [brShowClosed('done-1'), brReadyCall([makeBead({ id: 'next-1' })])],
    );

    const result = await runAdvanceWave(ctx, {
      cwd: '/fake/project',
      closedBeadIds: ['done-1'],
    });

    const data = (result.structuredContent as any).data;
    expect(data.nextStep).toBeUndefined();
    expect(data.nextWave).not.toBeNull();
    expect(data.nextWave.beadIds).toEqual(['next-1']);
    expect(data.waveComplete).toBe(true);
    // Only the rev-list count call fired; no rev-parse HEAD since gate didn't trip.
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('regression: feature-disabled state preserves legacy nextWave shape', async () => {
    // threshold=0 explicitly disables the feature — no live count call should fire.
    const { ctx } = makeCtx(
      { commitBatchThreshold: 0 },
      [brShowClosed('done-1'), brReadyCall([makeBead({ id: 'next-1' })])],
    );

    const result = await runAdvanceWave(ctx, {
      cwd: '/fake/project',
      closedBeadIds: ['done-1'],
    });

    const data = (result.structuredContent as any).data;
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

    const data = (result.structuredContent as any).data;
    expect(data.nextStep).toBeUndefined();
    expect(data.nextWave).not.toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('graceful degrade: git rev-list failure during gate skips to legacy nextWave', async () => {
    gitExecHandler = () => new Error('not a git repository');
    const { ctx } = makeCtx(
      {
        commitBatchThreshold: 8,
        lastBatchReviewSha: 'abc123',
      },
      [brShowClosed('done-1'), brReadyCall([makeBead({ id: 'next-1' })])],
    );

    const result = await runAdvanceWave(ctx, {
      cwd: '/fake/project',
      closedBeadIds: ['done-1'],
    });

    const data = (result.structuredContent as any).data;
    // rev-list failed → count=0 → gate skipped → legacy flow.
    expect(data.nextStep).toBeUndefined();
    expect(data.nextWave).not.toBeNull();
    expect(data.nextWave.beadIds).toEqual(['next-1']);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
