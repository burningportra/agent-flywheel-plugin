import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runReview } from '../tools/review.js';
import type { FlywheelState, ReviewArgs } from '../types.js';
import { createMockExec, makeState } from './helpers/mocks.js';

type IterationState = FlywheelState & {
  reviewIterations?: Record<string, { round: number; cleanStreak: number; converged: boolean; lastFindingCount: number }>;
};

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'review-converge-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function makeCtx(state: IterationState = makeState({ phase: 'reviewing' })) {
  const saveState = vi.fn(async () => true);
  return { ctx: { exec: createMockExec(), cwd, state, saveState, clearState: vi.fn() }, state, saveState };
}

function review(ctx: ReturnType<typeof makeCtx>['ctx'], args: Record<string, unknown>) {
  return runReview(ctx, { cwd, beadId: 'bead-1', ...args } as unknown as ReviewArgs);
}

function data(result: Awaited<ReturnType<typeof runReview>>): Record<string, unknown> {
  return (result.structuredContent as { data: Record<string, unknown> }).data;
}

function writeReport(beadId: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(cwd, '.pi-flywheel', 'completion'), { recursive: true });
  const report = {
    version: 1,
    beadId,
    agentName: 'SandyPelican',
    status: 'closed',
    changedFiles: ['mcp-server/src/foo.ts'],
    commits: ['abc1234', 'def5678'],
    ubs: { ran: true, summary: 'clean', findingsFixed: 0, deferredBeadIds: [] },
    verify: [{ command: 'npm test', exitCode: 0, summary: 'ok' }],
    selfReview: { ran: true, summary: 'ok' },
    beadClosedVerified: true,
    createdAt: '2026-10-21T20:00:00Z',
    ...extra,
  };
  writeFileSync(join(cwd, '.pi-flywheel', 'completion', `${beadId}.json`), JSON.stringify(report));
}

describe('flywheel_review action="converge"', () => {
  it('converges after two consecutive clean rounds and persists each round', async () => {
    const { ctx, state, saveState } = makeCtx();

    expect(data(await review(ctx, { action: 'converge', findingCount: 3 }))).toEqual({
      kind: 'review_convergence',
      beadId: 'bead-1',
      round: 1,
      cleanStreak: 0,
      converged: false,
      maxRounds: 5,
      reason: 'continue_review',
    });
    expect(data(await review(ctx, { action: 'converge', findingCount: 0 }))).toMatchObject({ round: 2, cleanStreak: 1, converged: false });
    expect(data(await review(ctx, { action: 'converge' }))).toMatchObject({
      round: 3,
      cleanStreak: 2,
      converged: true,
      reason: 'two_consecutive_clean_rounds',
    });

    expect(saveState).toHaveBeenCalledTimes(3);
    expect(state.reviewIterations?.['bead-1']).toEqual({ round: 3, cleanStreak: 2, converged: true, lastFindingCount: 0 });
  });

  it('resets the clean streak on findings and stops at round 5', async () => {
    const { ctx, state } = makeCtx();
    const counts = [0, 2, 0, 1, 4];
    const results = [];
    for (const findingCount of counts) results.push(data(await review(ctx, { action: 'converge', findingCount })));

    expect(results.map((r) => r['cleanStreak'])).toEqual([1, 0, 1, 0, 0]);
    expect(results.at(-1)).toMatchObject({ round: 5, converged: true, reason: 'max_rounds_reached' });
    expect(state.reviewIterations?.['bead-1']?.lastFindingCount).toBe(4);
  });

  it('leaves a converged bead untouched on further calls', async () => {
    const converged = { round: 5, cleanStreak: 0, converged: true, lastFindingCount: 2 };
    const { ctx, state, saveState } = makeCtx(makeState({ reviewIterations: { 'bead-1': converged } } as Partial<FlywheelState>));

    expect(data(await review(ctx, { action: 'converge', findingCount: 0 }))).toMatchObject({ round: 5, converged: true, reason: 'max_rounds_reached' });
    expect(saveState).not.toHaveBeenCalled();
    expect(state.reviewIterations?.['bead-1']).toEqual(converged);
  });

  it('tracks beads separately and records rounds without a beadId under __cycle__', async () => {
    const { ctx, state } = makeCtx();
    await review(ctx, { action: 'converge', beadId: 'bead-a', findingCount: 0 });
    await review(ctx, { action: 'converge', beadId: 'bead-b', findingCount: 1 });
    expect(data(await review(ctx, { action: 'converge', beadId: undefined }))).toMatchObject({ beadId: '__cycle__', round: 1 });

    expect(state.reviewIterations).toMatchObject({
      'bead-a': { round: 1, cleanStreak: 1 },
      'bead-b': { round: 1, cleanStreak: 0 },
      __cycle__: { round: 1, cleanStreak: 1 },
    });
  });

  it.each([-1, 1.5, Number.NaN])('rejects findingCount %s', async (findingCount) => {
    const { ctx, saveState } = makeCtx();
    const result = await review(ctx, { action: 'converge', findingCount });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain('invalid_input');
    expect(saveState).not.toHaveBeenCalled();
  });
});

describe('flywheel_review action="cross-agent"', () => {
  it.each([
    [{ paneName: 'proj--impl__cc_1' }, 'claude', 'pi'],
    [{ paneName: 'proj--impl__pi_2' }, 'pi', 'claude'],
    [{ paneName: 'proj--impl__pi_gmi_1' }, 'gemini', 'claude'],
    [{ paneName: 'proj--impl__agy_1' }, 'gemini', 'claude'],
    [{ lane: 'pi', paneName: 'proj--impl__cc_1' }, 'pi', 'claude'],
    [{ model: 'claude-opus-5-5' }, 'claude', 'pi'],
    [{ model: 'xai/grok-4.7' }, 'pi', 'claude'],
    [{ model: 'gemini-4-argon-high' }, 'gemini', 'claude'],
  ])('report %j: implementer %s gets a %s reviewer', async (extra, implementerFamily, reviewerFamily) => {
    writeReport('bead-1', extra);
    const { ctx } = makeCtx();
    const result = data(await review(ctx, { action: 'cross-agent' }));

    expect(result).toMatchObject({ kind: 'cross_agent_review', beadId: 'bead-1', implementerFamily, reviewerFamily, selfAnnealingRule: null });
    expect(result['reviewerFamily']).not.toBe(result['implementerFamily']);
  });

  it('builds a prompt over the reported commits and files', async () => {
    writeReport('bead-1', { paneName: 'proj--impl__cc_1' });
    const { ctx } = makeCtx();
    const prompt = String(data(await review(ctx, { action: 'cross-agent' }))['prompt']);

    expect(prompt).toContain('git show abc1234');
    expect(prompt).toContain('git show def5678');
    expect(prompt).toContain('mcp-server/src/foo.ts');
    expect(prompt).toContain('action="converge", beadId="bead-1"');
    expect(prompt).not.toContain('rejected');
  });

  it('drafts a self-annealing memory rule when the bead was rejected', async () => {
    writeReport('bead-1', { paneName: 'proj--impl__pi_1' });
    const { ctx } = makeCtx();
    const result = data(await review(ctx, { action: 'cross-agent', rejectedReason: 'skipped the regression test' }));

    expect(result['selfAnnealingRule']).toEqual({
      operation: 'store',
      category: 'review-rejection',
      beadId: 'bead-1',
      rule: 'Prevention rule for bead-1: skipped the regression test',
    });
    expect(result['prompt']).toContain('An earlier review rejected this bead: skipped the regression test.');
  });

  it('falls back to a pi reviewer when the implementer family is unknown', async () => {
    writeReport('bead-1');
    const { ctx } = makeCtx();
    expect(data(await review(ctx, { action: 'cross-agent' }))).toMatchObject({ implementerFamily: 'unknown', reviewerFamily: 'pi' });
  });

  it('returns missing_prerequisite without a completion report', async () => {
    const { ctx } = makeCtx();
    const result = await review(ctx, { action: 'cross-agent' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain('missing_prerequisite');
  });

  it('requires a beadId', async () => {
    const { ctx } = makeCtx();
    const result = await review(ctx, { action: 'cross-agent', beadId: '' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain('invalid_input');
  });
});
