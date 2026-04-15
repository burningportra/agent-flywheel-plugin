import { describe, it, expect, beforeEach } from 'vitest';
import { runReview } from '../../tools/review.js';
import { createMockExec, makeState } from '../helpers/mocks.js';
import type { FlywheelState, Bead } from '../../types.js';
import type { ExecCall } from '../helpers/mocks.js';

// ─── Helpers ──────────────────────────────────────────────────

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: 'test-bead-1',
    title: 'Add feature X',
    description: 'Implement feature X.\n\nsrc/feature.ts\nsrc/feature.test.ts',
    status: 'in_progress',
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
    selectedGoal: 'test goal',
    phase: 'reviewing',
    activeBeadIds: ['test-bead-1'],
    currentBeadId: 'test-bead-1',
    beadResults: {},
    beadReviewPassCounts: {},
    ...stateOverrides,
  });
  const exec = createMockExec(execCalls);
  const saved: FlywheelState[] = [];
  const ctx = {
    exec,
    cwd: '/fake/cwd',
    state,
    saveState: (s: FlywheelState) => { saved.push(structuredClone(s)); },
    clearState: () => {},
  };
  return { ctx, state, saved };
}

function brShowCall(bead: Bead): ExecCall {
  return {
    cmd: 'br',
    args: ['show', bead.id, '--json'],
    result: { code: 0, stdout: JSON.stringify(bead), stderr: '' },
  };
}

function brUpdateCall(beadId: string, status: string): ExecCall {
  return {
    cmd: 'br',
    args: ['update', beadId, '--status', status],
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

function brListCall(beads: Bead[]): ExecCall {
  return {
    cmd: 'br',
    args: ['list', '--json'],
    result: { code: 0, stdout: JSON.stringify(beads), stderr: '' },
  };
}

// ─── Tests ────────────────────────────────────────────────────

describe('runReview', () => {
  // ── Error cases ──────────────────────────────────────────────

  it('returns error when beadId is missing', async () => {
    const { ctx } = makeCtx();

    const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: '', action: 'looks-good' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      tool: 'flywheel_review',
      version: 1,
      status: 'error',
      data: {
        kind: 'error',
        error: {
          code: 'invalid_input',
        },
      },
    });
    expect(result.content[0].text).toContain('beadId is required');
  });

  it('returns error when bead not found', async () => {
    const { ctx } = makeCtx({}, [
      { cmd: 'br', args: ['show', 'missing-bead', '--json'], result: { code: 1, stdout: '', stderr: 'not found' } },
    ]);

    const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'missing-bead', action: 'looks-good' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      tool: 'flywheel_review',
      version: 1,
      status: 'error',
      data: {
        kind: 'error',
        error: {
          code: 'not_found',
        },
      },
    });
    expect(result.content[0].text).toContain('not found');
  });

  it('returns structured error when bead JSON cannot be parsed', async () => {
    const { ctx } = makeCtx({}, [
      { cmd: 'br', args: ['show', 'test-bead-1', '--json'], result: { code: 0, stdout: 'not-json', stderr: '' } },
    ]);

    const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'looks-good' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      tool: 'flywheel_review',
      version: 1,
      status: 'error',
      data: {
        kind: 'error',
        error: {
          code: 'parse_failure',
        },
      },
    });
  });

  it('returns message when bead is already complete', async () => {
    const bead = makeBead();
    const { ctx } = makeCtx(
      { beadResults: { 'test-bead-1': { beadId: 'test-bead-1', status: 'success', summary: 'done' } } },
      [brShowCall(bead)],
    );

    const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'looks-good' });

    expect(result.content[0].text).toContain('already complete');
  });

  // ── action=looks-good ────────────────────────────────────────

  it('marks bead as successful on looks-good', async () => {
    const bead = makeBead();
    const { ctx, state } = makeCtx({}, [
      brShowCall(bead),
      brUpdateCall('test-bead-1', 'closed'),
      brReadyCall([]),
    ]);

    await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'looks-good' });

    expect(state.beadResults!['test-bead-1']).toEqual({
      beadId: 'test-bead-1',
      status: 'success',
      summary: 'Passed review',
    });
  });

  it('increments review pass count on looks-good', async () => {
    const bead = makeBead();
    const { ctx, state } = makeCtx({}, [
      brShowCall(bead),
      brUpdateCall('test-bead-1', 'closed'),
      brReadyCall([]),
    ]);

    await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'looks-good' });

    expect(state.beadReviewPassCounts!['test-bead-1']).toBe(1);
  });

  it('transitions to iterating (gates) when all beads done', async () => {
    const bead = makeBead();
    const { ctx, state } = makeCtx({}, [
      brShowCall(bead),
      brUpdateCall('test-bead-1', 'closed'),
      brReadyCall([]),
    ]);

    const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'looks-good' });

    expect(state.phase).toBe('iterating');
    expect(result.structuredContent).toMatchObject({
      tool: 'flywheel_review',
      version: 1,
      status: 'ok',
      phase: 'iterating',
      data: {
        kind: 'review_gate',
        scope: 'bead_completion',
        completedBeadId: 'test-bead-1',
      },
    });
    expect(result.content[0].text).toContain('All beads complete');
    expect(result.content[0].text).toContain('__gates__');
  });

  it('moves to next bead when more beads are ready', async () => {
    const bead = makeBead();
    const nextBead = makeBead({ id: 'test-bead-2', title: 'Second task' });
    const { ctx, state } = makeCtx({}, [
      brShowCall(bead),
      brUpdateCall('test-bead-1', 'closed'),
      brReadyCall([nextBead]),
      brUpdateCall('test-bead-2', 'in_progress'),
    ]);

    const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'looks-good' });

    expect(state.currentBeadId).toBe('test-bead-2');
    expect(state.phase).toBe('implementing');
    expect(result.structuredContent).toMatchObject({
      tool: 'flywheel_review',
      version: 1,
      status: 'ok',
      phase: 'implementing',
      data: {
        kind: 'review_tasks',
        strategy: 'single_bead',
        nextBeadIds: ['test-bead-2'],
      },
    });
    expect(result.content[0].text).toContain('test-bead-2');
  });

  // ── Parent auto-close ──────────────────────────────────────

  describe('parent auto-close', () => {
    it('auto-closes parent when all siblings done', async () => {
      const bead = makeBead({ id: 'child-1', parent: 'parent-bead-1' });
      const siblingClosed = makeBead({ id: 'child-2', parent: 'parent-bead-1', status: 'closed' });
      const { ctx, state } = makeCtx({}, [
        brShowCall(bead),
        brUpdateCall('child-1', 'closed'),
        brListCall([bead, siblingClosed]),
        brUpdateCall('parent-bead-1', 'closed'),
        brReadyCall([]),
      ]);

      await runReview(ctx, { cwd: '/fake/cwd', beadId: 'child-1', action: 'looks-good' });

      expect(state.beadResults!['parent-bead-1']).toEqual({
        beadId: 'parent-bead-1',
        status: 'success',
        summary: 'All subtasks complete',
      });
    });

    it('does not auto-close parent when siblings still open', async () => {
      const bead = makeBead({ id: 'child-1', parent: 'parent-bead-1' });
      const siblingOpen = makeBead({ id: 'child-2', parent: 'parent-bead-1', status: 'in_progress' });
      const { ctx, state } = makeCtx({}, [
        brShowCall(bead),
        brUpdateCall('child-1', 'closed'),
        brListCall([bead, siblingOpen]),
        brReadyCall([]),
      ]);

      await runReview(ctx, { cwd: '/fake/cwd', beadId: 'child-1', action: 'looks-good' });

      expect(state.beadResults!['parent-bead-1']).toBeUndefined();
    });

    it('gracefully handles br list failure during parent auto-close', async () => {
      const bead = makeBead({ id: 'child-1', parent: 'parent-bead-1' });
      const { ctx, state } = makeCtx({}, [
        brShowCall(bead),
        brUpdateCall('child-1', 'closed'),
        { cmd: 'br', args: ['list', '--json'], result: { code: 1, stdout: '', stderr: 'error' } },
        brReadyCall([]),
      ]);

      const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'child-1', action: 'looks-good' });

      // Should not crash, parent not closed
      expect(state.beadResults!['parent-bead-1']).toBeUndefined();
      expect(result.isError).toBeUndefined();
    });
  });

  it('spawns parallel agents when multiple beads are ready', async () => {
    const bead = makeBead();
    const nextBeads = [
      makeBead({ id: 'test-bead-2', title: 'Second task' }),
      makeBead({ id: 'test-bead-3', title: 'Third task' }),
    ];
    const { ctx } = makeCtx({}, [
      brShowCall(bead),
      brUpdateCall('test-bead-1', 'closed'),
      brReadyCall(nextBeads),
      brUpdateCall('test-bead-2', 'in_progress'),
      brUpdateCall('test-bead-3', 'in_progress'),
    ]);

    const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'looks-good' });

    const text = result.content[0].text;
    expect(result.structuredContent).toMatchObject({
      tool: 'flywheel_review',
      version: 1,
      status: 'ok',
      phase: 'implementing',
      data: {
        kind: 'review_tasks',
        strategy: 'parallel_beads',
        nextBeadIds: ['test-bead-2', 'test-bead-3'],
      },
    });
    expect(text).toContain('2 beads now ready');
    expect(text).toContain('Spawn 2 parallel agents');
  });

  // ── action=hit-me ────────────────────────────────────────────

  it('returns agent task specs on hit-me', async () => {
    const bead = makeBead();
    const { ctx } = makeCtx({}, [brShowCall(bead)]);

    const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'hit-me' });

    expect(result.structuredContent).toMatchObject({
      tool: 'flywheel_review',
      version: 1,
      status: 'ok',
      phase: 'reviewing',
      data: {
        kind: 'review_tasks',
        strategy: 'hit_me',
        beadId: 'test-bead-1',
      },
    });
    const structured = result.structuredContent as { data: { agentTasks: unknown[] } };
    expect(structured.data.agentTasks).toHaveLength(5);
  });

  it('includes all review perspectives in hit-me agents', async () => {
    const bead = makeBead();
    const { ctx } = makeCtx({}, [brShowCall(bead)]);

    const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'hit-me' });

    const structured = result.structuredContent as { data: { kind: string; agentTasks: Array<{ perspective: string }> } };
    expect(structured.data.kind).toBe('review_tasks');
    const perspectives = structured.data.agentTasks.map(a => a.perspective);
    expect(perspectives).toContain('fresh-eyes');
    expect(perspectives).toContain('adversarial');
    expect(perspectives).toContain('ergonomics');
    expect(perspectives).toContain('reality-check');
    expect(perspectives).toContain('exploration');
  });

  it('sets beadHitMeTriggered on hit-me', async () => {
    const bead = makeBead();
    const { ctx, state } = makeCtx({}, [brShowCall(bead)]);

    await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'hit-me' });

    expect(state.beadHitMeTriggered!['test-bead-1']).toBe(true);
    expect(state.beadHitMeCompleted!['test-bead-1']).toBe(false);
  });

  it('extracts file paths from bead description in hit-me output', async () => {
    const bead = makeBead({
      description: 'Implement feature.\n\n`src/feature.ts`\n`src/feature.test.ts`',
    });
    const { ctx } = makeCtx({}, [brShowCall(bead)]);

    const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'hit-me' });

    const structured = result.structuredContent as { data: { agentTasks: Array<{ task: string }> } };
    // At least one agent task should mention the files
    const allTaskText = structured.data.agentTasks.map(a => a.task).join(' ');
    expect(allTaskText).toContain('src/feature.ts');
  });

  // ── action=skip ──────────────────────────────────────────────

  it('marks bead as blocked/skipped on skip', async () => {
    const bead = makeBead();
    const { ctx, state } = makeCtx({}, [
      brShowCall(bead),
      brUpdateCall('test-bead-1', 'deferred'),
      brReadyCall([]),
    ]);

    await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'skip' });

    expect(state.beadResults!['test-bead-1'].status).toBe('blocked');
    expect(state.beadResults!['test-bead-1'].summary).toContain('Skipped');
  });

  // ── Sentinel beadIds ─────────────────────────────────────────

  describe('gates sentinel', () => {
    it('shows current gate on hit-me', async () => {
      const { ctx } = makeCtx({ currentGateIndex: 0 });

      const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: '__gates__', action: 'hit-me' });

      expect(result.structuredContent).toMatchObject({
        tool: 'flywheel_review',
        version: 1,
        status: 'ok',
        data: {
          kind: 'review_gate',
          scope: 'gates',
          gateIndex: 0,
          round: 1,
        },
      });
      expect(result.content[0].text).toContain('Review Gate');
      expect(result.content[0].text).toContain('Gate 1');
    });

    it('advances gate index on looks-good', async () => {
      const { ctx, state } = makeCtx({ currentGateIndex: 0, consecutiveCleanRounds: 0 });

      const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: '__gates__', action: 'looks-good' });

      expect(state.currentGateIndex).toBe(1);
      expect(state.consecutiveCleanRounds).toBe(1);
      expect(result.structuredContent).toMatchObject({
        tool: 'flywheel_review',
        version: 1,
        status: 'ok',
        data: {
          kind: 'review_gate',
          scope: 'gates',
          gateIndex: 1,
          consecutiveCleanRounds: 1,
        },
      });
      expect(result.content[0].text).toContain('Gate passed');
    });

    it('completes flywheel after 2 consecutive clean rounds', async () => {
      const { ctx, state } = makeCtx({ currentGateIndex: 0, consecutiveCleanRounds: 1 });

      const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: '__gates__', action: 'looks-good' });

      expect(state.phase).toBe('complete');
      expect(result.structuredContent).toMatchObject({
        tool: 'flywheel_review',
        version: 1,
        status: 'ok',
        phase: 'complete',
        data: {
          kind: 'flywheel_complete',
          consecutiveCleanRounds: 2,
        },
      });
      expect(result.content[0].text).toContain('Flywheel Complete');
    });

    it('resets clean streak on hit-me (issue found)', async () => {
      const { ctx, state } = makeCtx({ currentGateIndex: 0, consecutiveCleanRounds: 1 });

      await runReview(ctx, { cwd: '/fake/cwd', beadId: '__gates__', action: 'hit-me' });

      expect(state.consecutiveCleanRounds).toBe(0);
    });
  });

  // ── Regression sentinels ─────────────────────────────────────

  it('regresses to planning phase with __regress_to_plan__', async () => {
    const { ctx, state } = makeCtx({ planDocument: 'docs/plans/plan.md' });

    const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: '__regress_to_plan__', action: 'looks-good' });

    expect(state.phase).toBe('planning');
    expect(result.content[0].text).toContain('plan revision');
  });

  it('regresses to creating_beads with __regress_to_beads__', async () => {
    const { ctx, state } = makeCtx();

    const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: '__regress_to_beads__', action: 'looks-good' });

    expect(state.phase).toBe('creating_beads');
    expect(result.content[0].text).toContain('bead creation');
  });

  it('regresses to implementing with __regress_to_implement__', async () => {
    const { ctx, state } = makeCtx();

    const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: '__regress_to_implement__', action: 'looks-good' });

    expect(state.phase).toBe('implementing');
    expect(result.content[0].text).toContain('implementation');
  });

  // ── Unknown action ───────────────────────────────────────────

  it('returns error for unknown action', async () => {
    const bead = makeBead();
    const { ctx } = makeCtx({}, [brShowCall(bead)]);

    const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'nope' as any });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown action');
  });

  // ── Already-closed bead handling (state desync recovery) ─────

  describe('bead.status === "closed" preflight', () => {
    it('looks-good is idempotent on already-closed bead — syncs state and advances', async () => {
      const closedBead = makeBead({ status: 'closed' });
      const { ctx, state } = makeCtx({}, [
        brShowCall(closedBead),
        brReadyCall([]),
      ]);

      const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'looks-good' });

      expect(result.isError).toBeUndefined();
      // State is reconciled with the auto-close
      expect(state.beadResults!['test-bead-1']).toEqual({
        beadId: 'test-bead-1',
        status: 'success',
        summary: 'Auto-closed by impl agent',
      });
      // Should NOT have called br update --status closed (no such mock; would 404)
      // and should have transitioned (gates phase or next bead)
      expect(state.phase).toBe('iterating');
      expect(result.content[0].text).toContain('Already closed by impl agent');
    });

    it('skip on already-closed bead returns already_closed error', async () => {
      const closedBead = makeBead({ status: 'closed' });
      const { ctx } = makeCtx({}, [brShowCall(closedBead)]);

      const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'skip' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        tool: 'flywheel_review',
        version: 1,
        status: 'error',
        data: {
          kind: 'error',
          error: { code: 'already_closed' },
        },
      });
      expect(result.content[0].text).toContain('already closed');
    });

    it('hit-me on already-closed bead returns postClose payload with 5 agent specs', async () => {
      const closedBead = makeBead({ status: 'closed' });
      const { ctx } = makeCtx({}, [brShowCall(closedBead)]);

      const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'hit-me' });

      expect(result.isError).toBeUndefined();
      const structured = result.structuredContent as {
        data: {
          kind: string;
          postClose: boolean;
          agentTasks: Array<{ task: string; perspective: string }>;
          instructions: string;
        };
      };
      expect(structured.data.kind).toBe('review_tasks');
      expect(structured.data.postClose).toBe(true);
      expect(structured.data.agentTasks).toHaveLength(5);
      // postClose note should be prepended to each agent task body
      for (const task of structured.data.agentTasks) {
        expect(task.task).toContain('already closed by the impl agent');
      }
      expect(structured.data.instructions).toContain('post-close audit');
    });

    it('hit-me on open bead does NOT tag postClose', async () => {
      const openBead = makeBead({ status: 'in_progress' });
      const { ctx } = makeCtx({}, [brShowCall(openBead)]);

      const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'hit-me' });

      const structured = result.structuredContent as {
        data: { postClose: boolean; agentTasks: Array<{ task: string }> };
      };
      expect(structured.data.postClose).toBe(false);
      for (const task of structured.data.agentTasks) {
        expect(task.task).not.toContain('already closed by the impl agent');
      }
    });

    it('hit-me on closed bead with empty description does not crash', async () => {
      // Regression: extractFilesFromBead must guard empty/missing description.
      const closedBeadEmpty = makeBead({ status: 'closed', description: '' });
      const { ctx } = makeCtx({}, [brShowCall(closedBeadEmpty)]);

      const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'hit-me' });

      expect(result.isError).toBeUndefined();
      const structured = result.structuredContent as { data: { files: string[]; postClose: boolean } };
      expect(structured.data.files).toEqual([]);
      expect(structured.data.postClose).toBe(true);
    });
  });
});
