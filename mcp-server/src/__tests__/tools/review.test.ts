import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── T11 mocks (must be hoisted before review.ts is imported) ──
// These cover the modules `handleBatchReview` (T4) calls that aren't
// reachable via the existing `createMockExec` harness: filesystem reads
// of the verdict file, bead-synthesis side effects, and CASS notes.
// Non-batch_review code paths in review.ts do not touch these modules,
// so the mocks are inert for the rest of the suite.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(async () => {
        const err = Object.assign(new Error('not mocked'), { code: 'ENOENT' });
        throw err;
      }),
      mkdir: vi.fn(async () => undefined),
    },
  };
});

vi.mock('../../commit-batch.js', () => ({
  synthesizeBeadsFromFindings: vi.fn(),
  rollbackSynthesizedBeads: vi.fn(async () => ({ deleted: [], closed: [], failed: [] })),
}));

vi.mock('../../memory.js', () => ({
  readMemory: vi.fn(() => ''),
  appendMemory: vi.fn(() => true),
}));

import { promises as fsPromises } from 'node:fs';
import { runReview } from '../../tools/review.js';
import { createMockExec, makeState } from '../helpers/mocks.js';
import type { FlywheelState, Bead, Finding } from '../../types.js';
import type { ExecCall } from '../helpers/mocks.js';
import { synthesizeBeadsFromFindings, rollbackSynthesizedBeads } from '../../commit-batch.js';
import { appendMemory, readMemory } from '../../memory.js';

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
    const nextBead = makeBead({
      id: 'test-bead-2',
      title: 'Second task',
      description: 'C3_SINGLE_BEAD_DESCRIPTION',
    });
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
    expect(result.content[0].text).toContain('implement and commit it, then call');
    expect(JSON.stringify(result).split('C3_SINGLE_BEAD_DESCRIPTION')).toHaveLength(2);
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

  it('returns parse_failure when br ready produces malformed JSON', async () => {
    const bead = makeBead();
    const { ctx } = makeCtx({}, [
      brShowCall(bead),
      brUpdateCall('test-bead-1', 'closed'),
      { cmd: 'br', args: ['ready', '--json'], result: { code: 0, stdout: 'not-valid-json{', stderr: '' } },
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
    expect(result.content[0].text).toContain('malformed JSON');
  });

  it('spawns parallel agents when multiple beads are ready', async () => {
    const bead = makeBead();
    const nextBeads = [
      makeBead({
        id: 'test-bead-2',
        title: 'Second task',
        description: 'C3_PARALLEL_BEAD_TWO_DESCRIPTION',
      }),
      makeBead({
        id: 'test-bead-3',
        title: 'Third task',
        description: 'C3_PARALLEL_BEAD_THREE_DESCRIPTION',
      }),
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
    expect(JSON.stringify(result).split('C3_PARALLEL_BEAD_TWO_DESCRIPTION')).toHaveLength(2);
    expect(JSON.stringify(result).split('C3_PARALLEL_BEAD_THREE_DESCRIPTION')).toHaveLength(2);
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
    const structured = result.structuredContent as {
      data: { reviewerBrief: string; agentTasks: unknown[] };
    };
    expect(structured.data.reviewerBrief).toContain('Review bead test-bead-1');
    expect(structured.data.agentTasks).toHaveLength(5);
  });

  it('returns one shared reviewer brief, short lenses, and a compact text receipt', async () => {
    const description = 'C3_UNIQUE_DESCRIPTION\n\nsrc/feature.ts';
    const bead = makeBead({ description });
    const { ctx } = makeCtx({}, [brShowCall(bead)]);

    const result = await runReview(ctx, {
      cwd: '/fake/cwd',
      beadId: 'test-bead-1',
      action: 'hit-me',
    });

    const structured = result.structuredContent as {
      data: {
        reviewerBrief: string;
        agentTasks: Array<{ perspective: string; task: string }>;
        instructions: string;
      };
    };
    expect(result.content[0].text).toBe(
      'Prepared 5 review tasks for test-bead-1 (interactive). Use structuredContent.data.reviewerBrief with each agentTasks[].task, then follow structuredContent.data.instructions.',
    );
    expect(structured.data.reviewerBrief).toContain(description);
    expect(structured.data.reviewerBrief).toContain('src/feature.ts');
    expect(structured.data.reviewerBrief).toContain('cwd: /fake/cwd');
    expect(structured.data.instructions).toContain('reviewerBrief');
    expect(structured.data.instructions).toContain('agentTasks[].task');
    expect(JSON.stringify(structured.data).split('C3_UNIQUE_DESCRIPTION')).toHaveLength(2);
    const adversarial = structured.data.agentTasks.find(
      (agentTask) => agentTask.perspective === 'adversarial',
    );
    expect(adversarial?.task).toContain('/ubs-workflow');
    expect(adversarial?.task).toContain('/gdb-for-debugging');
    expect(adversarial?.task).toContain('stack trace');
    for (const agentTask of structured.data.agentTasks) {
      expect(agentTask.task).not.toContain('C3_UNIQUE_DESCRIPTION');
      expect(agentTask.task).not.toContain('cwd: /fake/cwd');
      expect(agentTask.task.split('\n')).toHaveLength(1);
    }
  });

  it('includes all review perspectives in hit-me agents', async () => {
    const bead = makeBead();
    const { ctx } = makeCtx({}, [brShowCall(bead)]);

    const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'hit-me' });

    const structured = result.structuredContent as { data: { kind: string; agentTasks: Array<{ perspective: string }> } };
    expect(structured.data.kind).toBe('review_tasks');
    const perspectives = structured.data.agentTasks.map(a => a.perspective);
    expect(perspectives).toEqual([
      'fresh-eyes',
      'adversarial',
      'ergonomics',
      'reality-check',
      'exploration',
    ]);
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

    const structured = result.structuredContent as { data: { reviewerBrief: string } };
    expect(structured.data.reviewerBrief).toContain('src/feature.ts');
    expect(structured.data.reviewerBrief).toContain('src/feature.test.ts');
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

    it('walks every guided gate before completing the flywheel', async () => {
      const { ctx, state } = makeCtx({ currentGateIndex: 0, consecutiveCleanRounds: 0 });
      const gatePrompts: string[] = [];

      const firstGate = await runReview(ctx, { cwd: '/fake/cwd', beadId: '__gates__', action: 'hit-me' });
      gatePrompts.push(firstGate.content[0].text);

      for (let gate = 1; gate < 5; gate += 1) {
        const nextGate = await runReview(ctx, { cwd: '/fake/cwd', beadId: '__gates__', action: 'looks-good' });
        expect(state.phase).not.toBe('complete');
        gatePrompts.push(nextGate.content[0].text);
      }

      for (let gate = 1; gate <= 5; gate += 1) {
        expect(gatePrompts.join('\n')).toContain(`Gate ${gate}`);
      }

      const completion = await runReview(ctx, { cwd: '/fake/cwd', beadId: '__gates__', action: 'looks-good' });

      expect(state.phase).toBe('complete');
      expect(state.consecutiveCleanRounds).toBe(5);
      expect(completion.structuredContent).toMatchObject({
        tool: 'flywheel_review',
        version: 1,
        status: 'ok',
        phase: 'complete',
        data: {
          kind: 'flywheel_complete',
          consecutiveCleanRounds: 5,
        },
      });
      expect(completion.content[0].text).toContain('Flywheel Complete');
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
          reviewerBrief: string;
          agentTasks: Array<{ task: string; perspective: string }>;
          instructions: string;
        };
      };
      expect(structured.data.kind).toBe('review_tasks');
      expect(structured.data.postClose).toBe(true);
      expect(structured.data.agentTasks).toHaveLength(5);
      expect(structured.data.reviewerBrief).toContain('already closed by the impl agent');
      for (const task of structured.data.agentTasks) {
        expect(task.task).not.toContain('already closed by the impl agent');
      }
      expect(structured.data.instructions).toContain('post-close audit');
    });

    it('hit-me on open bead does NOT tag postClose', async () => {
      const openBead = makeBead({ status: 'in_progress' });
      const { ctx } = makeCtx({}, [brShowCall(openBead)]);

      const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'hit-me' });

      const structured = result.structuredContent as {
        data: { postClose: boolean; reviewerBrief: string };
      };
      expect(structured.data.postClose).toBe(false);
      expect(structured.data.reviewerBrief).not.toContain('already closed by the impl agent');
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

  // ── Review-mode matrix (bead agent-flywheel-plugin-f0j) ──────
  describe('hit-me — review mode matrix', () => {
    it('defaults to interactive mode and surfaces no preamble in the shared brief', async () => {
      const bead = makeBead();
      const { ctx } = makeCtx({}, [brShowCall(bead)]);

      const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: 'test-bead-1', action: 'hit-me' });

      const structured = result.structuredContent as {
        data: { mode: string; reviewerBrief: string };
      };
      expect(structured.data.mode).toBe('interactive');
      expect(structured.data.reviewerBrief).not.toContain('Review mode: autofix');
      expect(structured.data.reviewerBrief).not.toContain('Review mode: report-only');
      expect(structured.data.reviewerBrief).not.toContain('Review mode: headless');
    });

    it('report-only mode injects the report-only preamble into the shared brief', async () => {
      const bead = makeBead();
      const { ctx } = makeCtx({}, [brShowCall(bead)]);

      const result = await runReview(ctx, {
        cwd: '/fake/cwd',
        beadId: 'test-bead-1',
        action: 'hit-me',
        mode: 'report-only',
      });

      const structured = result.structuredContent as {
        data: { mode: string; reviewerBrief: string };
      };
      expect(structured.data.mode).toBe('report-only');
      expect(structured.data.reviewerBrief).toContain('Review mode: report-only');
      expect(structured.data.reviewerBrief).toContain('docs/reviews/');
    });

    it('headless mode injects the JSON-on-stdout preamble', async () => {
      const bead = makeBead();
      const { ctx } = makeCtx({}, [brShowCall(bead)]);

      const result = await runReview(ctx, {
        cwd: '/fake/cwd',
        beadId: 'test-bead-1',
        action: 'hit-me',
        mode: 'headless',
        parallelSafe: true,
      });

      const structured = result.structuredContent as {
        data: { mode: string; parallelSafe: boolean; reviewerBrief: string; instructions: string };
      };
      expect(structured.data.mode).toBe('headless');
      expect(structured.data.parallelSafe).toBe(true);
      expect(structured.data.instructions).toContain('action="report"');
      expect(structured.data.instructions).toContain('findingCount');
      expect(structured.data.instructions).toContain('crashed');
      expect(structured.data.reviewerBrief).toContain('Review mode: headless');
    });

    it('autofix downgrades to interactive when the working tree is dirty', async () => {
      const bead = makeBead();
      const { ctx } = makeCtx({}, [
        brShowCall(bead),
        // Dirty tree: porcelain emits a non-empty line.
        { cmd: 'git', args: ['status', '--porcelain'], result: { code: 0, stdout: ' M src/foo.ts\n', stderr: '' } },
      ]);

      const result = await runReview(ctx, {
        cwd: '/fake/cwd',
        beadId: 'test-bead-1',
        action: 'hit-me',
        mode: 'autofix',
      });

      const structured = result.structuredContent as {
        data: { mode: string; requestedMode: string; modeGateWarning?: string };
      };
      expect(structured.data.mode).toBe('interactive');
      expect(structured.data.requestedMode).toBe('autofix');
      expect(structured.data.modeGateWarning).toContain('working tree is dirty');
    });

    it('autofix is granted when git status is clean', async () => {
      const bead = makeBead();
      const { ctx } = makeCtx({}, [
        brShowCall(bead),
        { cmd: 'git', args: ['status', '--porcelain'], result: { code: 0, stdout: '', stderr: '' } },
      ]);

      const result = await runReview(ctx, {
        cwd: '/fake/cwd',
        beadId: 'test-bead-1',
        action: 'hit-me',
        mode: 'autofix',
      });

      const structured = result.structuredContent as {
        data: { mode: string; modeGateWarning?: string; reviewerBrief: string };
      };
      expect(structured.data.mode).toBe('autofix');
      expect(structured.data.modeGateWarning).toBeUndefined();
      expect(structured.data.reviewerBrief).toContain('Review mode: autofix');
    });
  });

  describe('headless report completion', () => {
    it('returns exitCode 1 when reviewers report findings', async () => {
      const { ctx } = makeCtx();

      const result = await runReview(ctx, {
        cwd: '/fake/cwd',
        beadId: 'test-bead-1',
        action: 'report',
        mode: 'headless',
        findingCount: 3,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: 'error',
        data: {
          kind: 'error',
          error: {
            code: 'review_headless_findings',
            retryable: false,
            hint: expect.stringContaining('action="report"'),
            details: {
              beadId: 'test-bead-1',
              findingCount: 3,
              crashed: false,
              exitCode: 1,
            },
          },
        },
      });
    });

    it('returns exitCode 2 when a reviewer crashed', async () => {
      const { ctx } = makeCtx();

      const result = await runReview(ctx, {
        cwd: '/fake/cwd',
        beadId: 'test-bead-1',
        action: 'report',
        mode: 'headless',
        findingCount: 0,
        crashed: true,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: 'error',
        data: {
          error: {
            code: 'review_headless_findings',
            details: {
              findingCount: 0,
              crashed: true,
              exitCode: 2,
            },
          },
        },
      });
    });

    it('returns an ok exitCode 0 result when the report is clean', async () => {
      const { ctx } = makeCtx();

      const result = await runReview(ctx, {
        cwd: '/fake/cwd',
        beadId: 'test-bead-1',
        action: 'report',
        mode: 'headless',
        findingCount: 0,
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        status: 'ok',
        data: {
          kind: 'review_headless_report',
          beadId: 'test-bead-1',
          mode: 'headless',
          findingCount: 0,
          crashed: false,
          exitCode: 0,
        },
      });
    });

    it('rejects report completion outside headless mode', async () => {
      const { ctx } = makeCtx();

      const result = await runReview(ctx, {
        cwd: '/fake/cwd',
        beadId: 'test-bead-1',
        action: 'report',
        mode: 'interactive',
        findingCount: 1,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: 'error',
        data: { error: { code: 'invalid_input' } },
      });
    });

    it('rejects a missing, negative, or fractional findingCount', async () => {
      for (const findingCount of [undefined, -1, 1.5]) {
        const { ctx } = makeCtx();
        const result = await runReview(ctx, {
          cwd: '/fake/cwd',
          beadId: 'test-bead-1',
          action: 'report',
          mode: 'headless',
          findingCount,
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          status: 'error',
          data: { error: { code: 'invalid_input' } },
        });
      }
    });
  });

  // ── T11 — action=batch_review verdict-handling branches ───────
  // Covers the Phase-2 (verdict file present) paths of `handleBatchReview`:
  //   blocking      → `synthesized_beads_pending` with bead IDs + mapping
  //   pass          → `advance_wave` (no synth)
  //   malformed     → `needs_attention` fallback + CASS note via appendMemory
  describe('batch_review action', () => {
    const SHA_RANGE = 'abc123..def456';

    function makeFinding(overrides: Partial<Finding> = {}): Finding {
      return {
        severity: 'medium',
        summary: 'Boundary check missing on user input',
        suggested_bead_title: 'Add bounds check to handler',
        affected_files: ['src/handler.ts'],
        evidence_excerpt: 'if (n > MAX) { /* never asserted */ }',
        ...overrides,
      };
    }

    function setVerdictFile(payload: unknown): void {
      vi.mocked(fsPromises.readFile).mockResolvedValueOnce(
        typeof payload === 'string' ? payload : JSON.stringify(payload),
      );
    }

    beforeEach(() => {
      vi.mocked(fsPromises.readFile).mockReset();
      vi.mocked(fsPromises.mkdir).mockReset();
      vi.mocked(synthesizeBeadsFromFindings).mockReset();
      vi.mocked(rollbackSynthesizedBeads).mockReset();
      vi.mocked(appendMemory).mockReset();
      vi.mocked(readMemory).mockReset();
      // Restore sane defaults so unrelated paths in the run never hit real fs.
      vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
      vi.mocked(rollbackSynthesizedBeads).mockResolvedValue({ deleted: [], closed: [], failed: [] });
      vi.mocked(appendMemory).mockReturnValue(true);
      vi.mocked(readMemory).mockReturnValue('');
    });

    it('dispatches one reviewer prompt with the exact verdict file as its findings channel', async () => {
      const { ctx } = makeCtx({}, [
        {
          cmd: 'git',
          args: ['diff', '--name-only', SHA_RANGE],
          result: { code: 0, stdout: 'src/handler.ts\nsrc/handler.test.ts\n', stderr: '' },
        },
      ]);

      const result = await runReview(ctx, {
        cwd: '/fake/cwd',
        beadId: '',
        action: 'batch_review',
        shaRange: SHA_RANGE,
      });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      const structured = result.structuredContent as {
        data: {
          kind: string;
          verdictPath: string;
          changedFiles: string[];
          prompt: string;
        };
      };
      const { prompt, verdictPath } = structured.data;

      expect(structured.data.kind).toBe('batch_review_dispatch');
      expect(structured.data.changedFiles).toEqual(['src/handler.ts', 'src/handler.test.ts']);
      expect(verdictPath).toBe('/fake/cwd/.pi-flywheel/batch-reviews/abc123..def456.json');
      expect(prompt).toContain(`\`${verdictPath}\``);
      expect(prompt).toContain('The server reads only this file.');
      expect(prompt).not.toContain('append a JSON object');
      expect(prompt).not.toContain('spawn fresh reviewers');
      expect(prompt).not.toContain('list_window_identities');
      expect(prompt).not.toContain('ntm --robot-send');
      expect(prompt.match(/Use ultrathink\./g)).toHaveLength(1);
      expect(text).toContain(`## Reviewer prompt\n\n${prompt}`);
      expect(text.split(prompt)).toHaveLength(2);

      expect(text).toContain('ntm --robot-send');
      expect(text).toContain('not `ntm send`');
      expect(text).toContain('Do not tear down responsive panes.');
      expect(text).toContain('The tender daemon is already stopped.');
      expect(text).toContain('One responsive pane reviews one bead.');
      expect(text).toContain('Agent(subagent_type="general-purpose")');
      expect(text).toContain(verdictPath);
    });

    it('blocking verdict → synthesized_beads_pending with 3 findings (mixed severities) and finding-to-bead mapping', async () => {
      const findings: Finding[] = [
        makeFinding({ severity: 'low', suggested_bead_title: 'Tidy log line', affected_files: ['src/log.ts'] }),
        makeFinding({ severity: 'high', suggested_bead_title: 'Fix off-by-one', affected_files: ['src/iter.ts'] }),
        makeFinding({ severity: 'critical', suggested_bead_title: 'Patch SQL injection', affected_files: ['src/query.ts'] }),
      ];
      setVerdictFile({
        status: 'blocking',
        findings,
        sha_range: SHA_RANGE,
      });
      const fakeIds = [
        'wonderful-bhaskara-3e2f85-aaa',
        'wonderful-bhaskara-3e2f85-bbb',
        'wonderful-bhaskara-3e2f85-ccc',
      ];
      vi.mocked(synthesizeBeadsFromFindings).mockResolvedValueOnce(fakeIds);

      const { ctx } = makeCtx();
      const result = await runReview(ctx, {
        cwd: '/fake/cwd',
        beadId: '',
        action: 'batch_review',
        shaRange: SHA_RANGE,
      });

      expect(result.isError).toBeUndefined();
      const structured = result.structuredContent as {
        data: {
          kind: string;
          verdict: { status: string; findings: Finding[] };
          nextStep: {
            kind: string;
            beadIds: string[];
            mapping: Array<{ beadId: string; finding: Finding }>;
          };
        };
      };
      expect(structured.data.kind).toBe('batch_review_verdict');
      expect(structured.data.verdict.status).toBe('blocking');
      expect(structured.data.nextStep.kind).toBe('synthesized_beads_pending');
      expect(structured.data.nextStep.beadIds).toEqual(fakeIds);
      // mapping is finding-index → bead-id, in order
      expect(structured.data.nextStep.mapping).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        expect(structured.data.nextStep.mapping[i].beadId).toBe(fakeIds[i]);
        expect(structured.data.nextStep.mapping[i].finding.severity).toBe(findings[i].severity);
        expect(structured.data.nextStep.mapping[i].finding.suggested_bead_title).toBe(findings[i].suggested_bead_title);
      }
      expect(vi.mocked(synthesizeBeadsFromFindings)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(synthesizeBeadsFromFindings)).toHaveBeenCalledWith(
        '/fake/cwd',
        expect.any(Object),
        findings,
        SHA_RANGE,
      );
      // No malformed-verdict CASS note on the happy path.
      expect(vi.mocked(appendMemory)).not.toHaveBeenCalled();
    });

    it('pass verdict → advance_wave, with no bead synthesis', async () => {
      setVerdictFile({
        status: 'pass',
        findings: [],
        sha_range: SHA_RANGE,
      });

      const { ctx } = makeCtx();
      const result = await runReview(ctx, {
        cwd: '/fake/cwd',
        beadId: '',
        action: 'batch_review',
        shaRange: SHA_RANGE,
      });

      expect(result.isError).toBeUndefined();
      const structured = result.structuredContent as {
        data: { kind: string; nextStep: { kind: string }; verdict: { status: string } };
      };
      expect(structured.data.kind).toBe('batch_review_verdict');
      expect(structured.data.verdict.status).toBe('pass');
      expect(structured.data.nextStep.kind).toBe('advance_wave');
      // Hard assertion from the marching orders: no synthesis on pass.
      expect(vi.mocked(synthesizeBeadsFromFindings)).not.toHaveBeenCalled();
      expect(vi.mocked(appendMemory)).not.toHaveBeenCalled();
    });

    it('malformed Finding[] (missing severity) → Zod fails → needs_attention fallback + CASS note via appendMemory', async () => {
      // First finding is missing the required `severity` field. JSON.parse
      // succeeds (it's valid JSON); BatchReviewVerdictSchema.safeParse fails
      // because FindingSchema requires `severity ∈ {low, medium, high, critical}`.
      const malformedFinding = {
        // severity intentionally omitted
        summary: 'Boundary check missing on user input',
        suggested_bead_title: 'Add bounds check to handler',
        affected_files: ['src/handler.ts'],
        evidence_excerpt: 'if (n > MAX) { /* never asserted */ }',
      };
      setVerdictFile({
        status: 'blocking',
        findings: [malformedFinding],
        sha_range: SHA_RANGE,
      });

      const { ctx } = makeCtx();
      const result = await runReview(ctx, {
        cwd: '/fake/cwd',
        beadId: '',
        action: 'batch_review',
        shaRange: SHA_RANGE,
      });

      expect(result.isError).toBeUndefined();
      const structured = result.structuredContent as {
        data: {
          kind: string;
          malformed?: boolean;
          reason?: string;
          rawVerdictSnippet?: string;
          nextStep: { kind: string; findings: Finding[] };
        };
      };
      expect(structured.data.kind).toBe('batch_review_verdict');
      expect(structured.data.malformed).toBe(true);
      expect(structured.data.nextStep.kind).toBe('needs_attention');
      expect(structured.data.nextStep.findings).toEqual([]);
      // The schema-failure reason should mention severity (the missing field).
      expect(structured.data.reason).toMatch(/schema|severity/i);
      // Raw reviewer output is surfaced so a human still sees what landed.
      expect(structured.data.rawVerdictSnippet).toContain('Boundary check missing');
      // CASS note recorded under the 'batch-review' category.
      expect(vi.mocked(appendMemory)).toHaveBeenCalledTimes(1);
      const [appendCwd, appendContent, appendCategory] = vi.mocked(appendMemory).mock.calls[0];
      expect(appendCwd).toBe('/fake/cwd');
      expect(appendContent).toMatch(/malformed batch-review verdict/i);
      expect(appendContent).toContain(SHA_RANGE);
      expect(appendCategory).toBe('batch-review');
      // No bead synthesis on schema failure.
      expect(vi.mocked(synthesizeBeadsFromFindings)).not.toHaveBeenCalled();
    });
  });
});
