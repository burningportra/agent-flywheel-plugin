import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockExec, makeState } from '../helpers/mocks.js';
import type { OrchestratorState, Bead } from '../../types.js';
import type { ExecCall } from '../helpers/mocks.js';

// ─── Helpers ──────────────────────────────────────────────────

function makeBead(overrides: Partial<Bead> = {}): Bead {
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

function makeExecCalls(beads: Bead[] = [makeBead()], readyBeads?: Bead[]): ExecCall[] {
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

function makeCtx(
  stateOverrides: Partial<OrchestratorState> = {},
  execCalls: ExecCall[] = makeExecCalls(),
  cwd = '/fake/cwd',
) {
  const exec = createMockExec(execCalls);
  const state = makeState({
    selectedGoal: 'Improve testing',
    phase: 'awaiting_bead_approval',
    ...stateOverrides,
  });
  const saved: OrchestratorState[] = [];
  const ctx = {
    exec,
    cwd,
    state,
    saveState: (s: OrchestratorState) => { saved.push(structuredClone(s)); },
    clearState: () => {},
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
  let runApprove: Awaited<ReturnType<typeof importApprove>>;

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
  });

  // ── action=start ─────────────────────────────────────────────

  it('transitions to implementing on start', async () => {
    const bead = makeBead();
    const { ctx, state } = makeCtx({}, makeExecCalls([bead]));

    const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });

    expect(state.phase).toBe('implementing');
    expect(state.currentBeadId).toBe('bead-1');
    expect(result.content[0].text).toContain('Beads approved');
  });

  it('resets beadResults and beadReviews on start', async () => {
    const bead = makeBead();
    const { ctx, state } = makeCtx(
      { beadResults: { old: { beadId: 'old', status: 'success', summary: 'done' } } },
      makeExecCalls([bead]),
    );

    await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });

    expect(state.beadResults).toEqual({});
    expect(state.beadReviews).toEqual({});
  });

  it('returns agent configs when multiple beads are ready', async () => {
    const beads = [
      makeBead({ id: 'bead-1', title: 'First task' }),
      makeBead({ id: 'bead-2', title: 'Second task' }),
    ];
    const { ctx } = makeCtx({}, makeExecCalls(beads));

    const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });

    const text = result.content[0].text;
    expect(text).toContain('Spawn 2 parallel agents');
    expect(text).toContain('bead-1');
    expect(text).toContain('bead-2');
  });

  it('includes bead quality score in output on start', async () => {
    const bead = makeBead();
    const { ctx } = makeCtx({}, makeExecCalls([bead]));

    const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });

    expect(result.content[0].text).toContain('Bead quality');
  });

  // ── action=advanced ──────────────────────────────────────────

  it('returns error when advancedAction is missing', async () => {
    const { ctx } = makeCtx();

    const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'advanced' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('advancedAction is required');
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
  });

  it('returns error for unknown advancedAction', async () => {
    const { ctx } = makeCtx();

    const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'advanced', advancedAction: 'nope' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown advancedAction');
  });

  // ── Plan approval mode ───────────────────────────────────────

  describe('plan approval mode', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'approve-plan-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('approves plan and transitions to creating_beads', async () => {
      const planContent = Array(120).fill('plan line').join('\n');
      writeFileSync(join(tmpDir, 'plan.md'), planContent);

      const { ctx, state } = makeCtx(
        { phase: 'awaiting_plan_approval', planDocument: 'plan.md' },
        [],
        tmpDir,
      );

      const result = await runApprove(ctx, { cwd: tmpDir, action: 'start' });

      expect(state.phase).toBe('creating_beads');
      expect(result.content[0].text).toContain('Plan approved');
    });

    it('rejects plan and resets state', async () => {
      writeFileSync(join(tmpDir, 'plan.md'), '# Plan\nContent');

      const { ctx, state } = makeCtx(
        { phase: 'awaiting_plan_approval', planDocument: 'plan.md' },
        [],
        tmpDir,
      );

      const result = await runApprove(ctx, { cwd: tmpDir, action: 'reject' });

      expect(state.phase).toBe('idle');
      expect(state.planDocument).toBeUndefined();
      expect(result.content[0].text).toContain('Plan rejected');
    });

    it('polishes plan and increments refinement round', async () => {
      writeFileSync(join(tmpDir, 'plan.md'), '# Plan\nContent');

      const { ctx, state } = makeCtx(
        { phase: 'awaiting_plan_approval', planDocument: 'plan.md', planRefinementRound: 0 },
        [],
        tmpDir,
      );

      const result = await runApprove(ctx, { cwd: tmpDir, action: 'polish' });

      expect(state.phase).toBe('planning');
      expect(state.planRefinementRound).toBe(1);
      expect(result.content[0].text).toContain('Refine the plan');
    });

    it('returns error when plan file not found', async () => {
      const { ctx } = makeCtx(
        { phase: 'awaiting_plan_approval', planDocument: 'missing.md' },
        [],
        tmpDir,
      );

      const result = await runApprove(ctx, { cwd: tmpDir, action: 'start' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Plan document not found');
    });

    it('handles git-diff-review action', async () => {
      writeFileSync(join(tmpDir, 'plan.md'), '# Plan\nSome content here');

      const { ctx, state } = makeCtx(
        { phase: 'awaiting_plan_approval', planDocument: 'plan.md', planRefinementRound: 0 },
        [],
        tmpDir,
      );

      const result = await runApprove(ctx, { cwd: tmpDir, action: 'git-diff-review' });

      expect(state.phase).toBe('planning');
      expect(state.planRefinementRound).toBe(1);
      expect(result.content[0].text).toContain('Git-diff review');
    });
  });

  // ── Convergence tracking ─────────────────────────────────────

  it('tracks polish changes during refining_beads phase', async () => {
    const beads = [makeBead({ id: 'bead-1' })];
    const calls = makeExecCalls(beads);

    // First call in refining phase to set snapshot
    const { ctx: ctx1, state: state1 } = makeCtx(
      { phase: 'refining_beads', polishRound: 0, polishChanges: [] },
      calls,
    );
    await runApprove(ctx1, { cwd: '/fake/cwd', action: 'polish' });

    // The state should be in refining_beads after polish
    expect(state1.phase).toBe('refining_beads');
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
});
