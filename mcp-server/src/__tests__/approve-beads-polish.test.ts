/**
 * Bead agent-flywheel-plugin-jl5 — converge-polish loop, verify-bead action,
 * and Verify-triad quality boost.
 *
 * Coverage:
 *   - converge-polish: baseline round, change counting, convergence after
 *     2 consecutive zero-change rounds, round-cap convergence at 6,
 *     bvInsights enrichment (degraded bv → warning, still converges).
 *   - verify-bead: missing beadId, missing report, verified path (report +
 *     ledger written), patch-id failure path (verification-failed).
 *   - computeBeadQualityScore rewards Verify, unit/live/perf presence.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMockExec, makeState } from './helpers/mocks.js';
import type { Bead, FlywheelState } from '../types.js';
import { runApprove, MAX_POLISH_ROUNDS } from '../tools/approve.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const PATCH = 'c'.repeat(40);

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: 'bead-1',
    title: 'Add widget',
    description: 'WHAT: add a widget.\nWHY: needed.\nHOW: edit src/widget.ts.\nAcceptance criteria:\n- works',
    status: 'open',
    priority: 2,
    type: 'task',
    labels: [],
    ...overrides,
  };
}

function makePolishCtx(beads: Bead[], stateOverrides: Partial<FlywheelState> = {}, cwd = '/fake/cwd') {
  const exec = createMockExec([
    {
      cmd: 'br',
      args: ['list', '--all', '--limit', '0', '--json'],
      result: { code: 0, stdout: JSON.stringify(beads), stderr: '' },
    },
    {
      cmd: 'bv',
      args: ['--robot-insights'],
      result: { code: 0, stdout: JSON.stringify({ health: 'ok' }), stderr: '' },
    },
  ]);
  const state = makeState({
    selectedGoal: 'Polish loop',
    phase: 'awaiting_bead_approval',
    ...stateOverrides,
  });
  return {
    ctx: {
      exec,
      cwd,
      state,
      saveState: (s: FlywheelState) => {
        Object.assign(state, s);
      },
      clearState: () => {},
    },
    state,
  };
}

function dataOf(result: Awaited<ReturnType<typeof runApprove>>): Record<string, unknown> {
  return (result.structuredContent as { data: Record<string, unknown> }).data;
}

describe('converge-polish', () => {
  it('converges after 2 consecutive zero-change rounds', async () => {
    const beads = [makeBead()];
    const { ctx, state } = makePolishCtx(beads);
    // Round 1: compares against the snapshot primed earlier in the call.
    let r = await runApprove(ctx, { cwd: '/fake/cwd', action: 'converge-polish' });
    expect(dataOf(r).kind).toBe('polish_round_complete');
    expect(state.polishRound).toBe(1);
    expect(state.polishConverged).toBe(false);

    // Round 2 with identical beads: second consecutive zero → converged.
    const { ctx: ctx2 } = makePolishCtx(beads, {});
    Object.assign(ctx2.state, state);
    r = await runApprove(ctx2, { cwd: '/fake/cwd', action: 'converge-polish' });
    const d = dataOf(r);
    expect(d.kind).toBe('polish_converged');
    expect(d.polishConverged).toBe(true);
    expect(d.stop_reason).toBe('convergence_reached');
    expect(ctx2.state.polishConverged).toBe(true);
  });

  it('counts real changes and does not converge early', async () => {
    const { ctx } = makePolishCtx([makeBead()]);
    await runApprove(ctx, { cwd: '/fake/cwd', action: 'converge-polish' });
    const { ctx: ctx2 } = makePolishCtx([makeBead({ description: 'WHAT: changed entirely.\nWHY: x.\nHOW: edit src/other.ts.' })], {});
    Object.assign(ctx2.state, ctx.state);
    const r = await runApprove(ctx2, { cwd: '/fake/cwd', action: 'converge-polish' });
    const d = dataOf(r);
    expect(d.kind).toBe('polish_round_complete');
    expect((d.changes as number[]).at(-1)).toBeGreaterThan(0);
    expect(d.polishConverged).toBe(false);
  });

  it('converges at the round cap with max_rounds_hit', async () => {
    const { ctx, state } = makePolishCtx([makeBead()], {
      polishRound: MAX_POLISH_ROUNDS - 1,
      polishChanges: [3],
    });
    const r = await runApprove(ctx, { cwd: '/fake/cwd', action: 'converge-polish' });
    const d = dataOf(r);
    expect(d.kind).toBe('polish_converged');
    expect(d.polishRound).toBe(MAX_POLISH_ROUNDS);
    expect(d.stop_reason).toBe('max_rounds_hit');
    expect(state.polishConverged).toBe(true);
  });

  it('attaches bvInsights when bv is healthy and degrades with a warning when not', async () => {
    const { ctx } = makePolishCtx([makeBead()]);
    let d = dataOf(await runApprove(ctx, { cwd: '/fake/cwd', action: 'converge-polish' }));
    expect(d.bvInsights).toEqual({ health: 'ok' });
    expect(d.bvWarning).toBeUndefined();

    const execDown = createMockExec([
      {
        cmd: 'br',
        args: ['list', '--all', '--limit', '0', '--json'],
        result: { code: 0, stdout: JSON.stringify([makeBead()]), stderr: '' },
      },
      { cmd: 'bv', args: ['--robot-insights'], result: { code: 1, stdout: '', stderr: 'nope' } },
    ]);
    const state = makeState({ selectedGoal: 'Polish loop', phase: 'awaiting_bead_approval' });
    const ctxDown = {
      exec: execDown,
      cwd: '/fake/cwd',
      state,
      saveState: (s: FlywheelState) => {
        Object.assign(state, s);
      },
      clearState: () => {},
    };
    d = dataOf(await runApprove(ctxDown, { cwd: '/fake/cwd', action: 'converge-polish' }));
    expect(d.bvInsights).toBeNull();
    expect(d.bvWarning).toContain('exited 1');
  });

  it('rewards Verify triad presence in the quality score', async () => {
    const plain = makeBead();
    const triad = makeBead({
      description: `${plain.description}\n- **Verify, unit**: \`npm test\`\n- **Verify, live**: \`node x.js\`\n- **Verify, perf**: \`npm test\``,
    });
    const { ctx } = makePolishCtx([plain]);
    const plainScore = (dataOf(await runApprove(ctx, { cwd: '/fake/cwd', action: 'converge-polish' })).quality as { score: number }).score;
    const { ctx: ctx2 } = makePolishCtx([triad]);
    const triadScore = (dataOf(await runApprove(ctx2, { cwd: '/fake/cwd', action: 'converge-polish' })).quality as { score: number }).score;
    expect(triadScore).toBeGreaterThan(plainScore);
    expect(triadScore).toBeLessThanOrEqual(1);
  });
});

describe('verify-bead', () => {
  function writeReport(cwd: string, beadId: string): void {
    const dir = path.join(cwd, '.pi-flywheel', 'completion');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${beadId}.json`),
      JSON.stringify({
        version: 1,
        beadId,
        agentName: 'tester',
        status: 'closed',
        changedFiles: ['src/a.ts'],
        commits: ['abc123'],
        ubs: { ran: true, summary: 'clean' },
        verify: [],
        selfReview: { ran: true, summary: 'ok' },
        beadClosedVerified: true,
        createdAt: new Date().toISOString(),
      }),
    );
  }

  function makeVerifyCtx(cwd: string, shCode: number) {
    const exec = (async (cmd: string, args: string[]) => {
      if (cmd === 'git') return { code: 0, stdout: `${HEAD}\n`, stderr: '' };
      if (cmd === 'sh') return { code: shCode, stdout: shCode === 0 ? `${PATCH}  ${HEAD}\n` : '', stderr: shCode === 0 ? '' : 'diff failed' };
      throw new Error(`unexpected exec ${cmd} ${args.join(' ')}`);
    }) as import('../exec.js').ExecFn;
    const state = makeState({
      selectedGoal: 'Verify bead',
      phase: 'awaiting_bead_approval',
      cycleStartSha: BASE,
    });
    return {
      exec,
      cwd,
      state,
      saveState: (s: FlywheelState) => {
        Object.assign(state, s);
      },
      clearState: () => {},
    };
  }

  it('rejects a missing beadId', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'verify-bead-'));
    const ctx = makeVerifyCtx(cwd, 0);
    const r = await runApprove(ctx, { cwd, action: 'verify-bead' });
    expect((r.structuredContent as { status: string }).status).toBe('error');
  });

  it('reports not_found when the completion report is absent', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'verify-bead-'));
    const ctx = makeVerifyCtx(cwd, 0);
    const r = await runApprove(ctx, { cwd, action: 'verify-bead', beadId: 'ghost' });
    expect((r.structuredContent as { status: string }).status).toBe('error');
    expect(JSON.stringify(r.structuredContent)).toContain('not_found');
  });

  it('marks verified and writes report + ledger on a clean patch-id', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'verify-bead-'));
    writeReport(cwd, 'b1');
    const ctx = makeVerifyCtx(cwd, 0);
    const r = await runApprove(ctx, { cwd, action: 'verify-bead', beadId: 'b1' });
    const d = dataOf(r);
    expect(d.kind).toBe('bead_verified');
    expect(d.verdict).toBe('verified');
    expect(d.headSha).toBe(HEAD);
    expect(d.patchId).toBe(PATCH);
    const saved = JSON.parse(readFileSync(path.join(cwd, '.pi-flywheel', 'completion', 'b1.json'), 'utf8'));
    expect(saved.verification.verdict).toBe('verified');
    expect(saved.verification.patchId).toBe(PATCH);
    expect(existsSync(path.join(cwd, '.pi-flywheel', 'ledger.tsv'))).toBe(true);
  });

  it('marks verification-failed when patch-id fails', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'verify-bead-'));
    writeReport(cwd, 'b2');
    const ctx = makeVerifyCtx(cwd, 1);
    const r = await runApprove(ctx, { cwd, action: 'verify-bead', beadId: 'b2' });
    const d = dataOf(r);
    expect(d.kind).toBe('bead_verified');
    expect(d.verdict).toBe('verification-failed');
    const saved = JSON.parse(readFileSync(path.join(cwd, '.pi-flywheel', 'completion', 'b2.json'), 'utf8'));
    expect(saved.verification.verdict).toBe('verification-failed');
  });
});
