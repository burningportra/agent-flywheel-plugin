import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendRevision,
  computeRevisionMetrics,
  ConvergenceStateSchema,
  type ConvergenceState,
} from '../convergence.js';
import {
  convergencePath,
  readConvergenceFromDisk,
  runConvergence,
  writeConvergenceToDisk,
  planSlugFromIdentifier,
} from '../tools/convergence-tool.js';
import {
  loadFlywheelConfig,
  DEFAULT_CONFIG,
} from '../flywheel-config.js';
import { writeCheckpoint } from '../checkpoint.js';
import { runObserve } from '../tools/observe.js';
import { runAdvanceWave } from '../tools/advance-wave.js';
import { runDoctorChecks } from '../tools/doctor.js';
import type { FlywheelState, ToolContext } from '../types.js';
import type { FlywheelObserveReport } from '../tools/observe.js';

function makeState(overrides: Partial<FlywheelState> = {}): FlywheelState {
  return {
    phase: 'idle',
    activeBeadIds: [],
    selectedGoal: undefined,
    planDocument: undefined,
    ...overrides,
  } as FlywheelState;
}

function makeCtx(cwd: string, state: FlywheelState = makeState()): ToolContext {
  return {
    cwd,
    state,
    saveState: () => {},
    clearState: () => {},
    exec: (async () => ({ code: 0, stdout: '', stderr: '' })) as unknown as ToolContext['exec'],
    signal: new AbortController().signal,
  };
}

function buildConvergenceFixture(planSlug: string, score: number): ConvergenceState {
  // Synthesize a state directly so we can pin the score precisely. This
  // mirrors what writeConvergenceToDisk would persist.
  const state: ConvergenceState = {
    version: 1,
    planSlug,
    scoreVersion: 1,
    revisions: [],
    signals: { outputSizeTrend: 0, changeVelocity: 0, similarityTrend: 1 },
    oscillation: { signFlips: 0, detected: false },
    score,
    status:
      score >= 0.9
        ? 'converged'
        : score >= 0.75
          ? 'nearly_converged'
          : score >= 0.5
            ? 'approaching'
            : 'diverging',
    estimatedRoundsRemaining: null,
    computedAt: '2026-05-05T00:00:00.000Z',
  };
  return ConvergenceStateSchema.parse(state);
}

describe('B-AC2 — flywheel_convergence MCP tool', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'conv-tool-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('happy path: writes a fixture state, then reads it back via the tool handler', async () => {
    const slug = 'happy-plan';
    const fixture = buildConvergenceFixture(slug, 0.65);
    await writeConvergenceToDisk(tmpRoot, fixture);

    const ctx = makeCtx(tmpRoot);
    const result = await runConvergence(ctx, { cwd: tmpRoot, planSlug: slug });
    const structured = (result as { structuredContent: unknown }).structuredContent as {
      tool: string;
      version: number;
      status: string;
      data: { kind: string; state: ConvergenceState } | null;
    };
    expect(structured.tool).toBe('flywheel_convergence');
    expect(structured.version).toBe(1);
    expect(structured.status).toBe('ok');
    expect(structured.data).not.toBeNull();
    expect(structured.data!.state).toEqual(fixture);
  });

  it('not_found path: returns status="not_found" cleanly when the file is absent', async () => {
    const ctx = makeCtx(tmpRoot);
    const result = await runConvergence(ctx, { cwd: tmpRoot, planSlug: 'never-existed' });
    const structured = (result as { structuredContent: unknown }).structuredContent as {
      status: string;
      data: unknown;
      message: string;
    };
    expect(structured.status).toBe('not_found');
    expect(structured.data).toBeNull();
    expect(structured.message).toMatch(/never-existed/);
  });

  it('score_version_mismatch: state with scoreVersion=2 returns code score_version_mismatch', async () => {
    const slug = 'stale-plan';
    const filePath = convergencePath(tmpRoot, slug);
    mkdirSync(join(tmpRoot, '.pi-flywheel/plans/stale-plan'), { recursive: true });
    const stale = {
      version: 1,
      planSlug: slug,
      scoreVersion: 2,
      revisions: [],
      signals: { outputSizeTrend: 0, changeVelocity: 0, similarityTrend: 1 },
      oscillation: { signFlips: 0, detected: false },
      score: 0.5,
      status: 'approaching',
      estimatedRoundsRemaining: null,
      computedAt: '2026-05-05T00:00:00.000Z',
    };
    writeFileSync(filePath, JSON.stringify(stale, null, 2), 'utf8');

    const result = await readConvergenceFromDisk(tmpRoot, slug);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('score_version_mismatch');
    }
  });

  it('writeConvergenceToDisk refuses to write a state with mismatched scoreVersion', async () => {
    const slug = 'bad-write';
    const malformed = buildConvergenceFixture(slug, 0.5);
    (malformed as unknown as { scoreVersion: number }).scoreVersion = 999;
    await expect(writeConvergenceToDisk(tmpRoot, malformed as ConvergenceState)).rejects.toThrow();
  });

  it('rejects empty planSlug input with code=invalid_input', async () => {
    const ctx = makeCtx(tmpRoot);
    const result = await runConvergence(ctx, { cwd: tmpRoot, planSlug: '' });
    const structured = (result as { structuredContent: unknown }).structuredContent as {
      status: string;
      code?: string;
    };
    expect(structured.status).toBe('error');
    expect(structured.code).toBe('invalid_input');
  });
});

describe('B-AC2 — flywheel_observe schema parity + convergence wiring', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'conv-obs-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('observe report has unchanged required fields and convergence is opt-in (absent without state)', async () => {
    const ctx = makeCtx(tmpRoot);
    const result = await runObserve(ctx, { cwd: tmpRoot });
    const structured = (result as { structuredContent: unknown }).structuredContent as {
      data: { report: FlywheelObserveReport };
    };
    const report = structured.data.report;

    // Pre-existing fields — name + presence parity.
    const required = [
      'version',
      'cwd',
      'timestamp',
      'elapsedMs',
      'git',
      'checkpoint',
      'beads',
      'agentMail',
      'ntm',
      'artifacts',
      'attestations',
      'hints',
    ];
    for (const k of required) {
      expect(report, `field ${k}`).toHaveProperty(k);
    }
    // No active plan → convergence absent.
    expect(report.convergence).toBeUndefined();
    // convergenceGated defaults to true (kill-switch on, default config).
    expect(report.convergenceGated).toBe(true);
  });

  it('convergence appears in report when a plan is registered AND state file exists', async () => {
    // Set up a checkpoint pointing at a plan
    const planPath = 'docs/plans/test-plan.md';
    await writeCheckpoint(tmpRoot, makeState({ phase: 'planning', planDocument: planPath }));

    const slug = planSlugFromIdentifier(planPath);
    await writeConvergenceToDisk(tmpRoot, buildConvergenceFixture(slug, 0.81));

    const ctx = makeCtx(tmpRoot, makeState({ phase: 'planning', planDocument: planPath }));
    const result = await runObserve(ctx, { cwd: tmpRoot });
    const structured = (result as { structuredContent: unknown }).structuredContent as {
      data: { report: FlywheelObserveReport };
    };
    const report = structured.data.report;
    expect(report.convergence).toBeDefined();
    expect(report.convergence?.score).toBeCloseTo(0.81, 5);
    expect(report.convergence?.status).toBe('nearly_converged');
  });

  it('convergenceGated reflects flywheel.config.yaml kill-switch state', async () => {
    writeFileSync(
      join(tmpRoot, 'flywheel.config.yaml'),
      'convergence:\n  gate_advance_wave: false\n',
      'utf8',
    );
    const ctx = makeCtx(tmpRoot);
    const result = await runObserve(ctx, { cwd: tmpRoot });
    const structured = (result as { structuredContent: unknown }).structuredContent as {
      data: { report: FlywheelObserveReport };
    };
    expect(structured.data.report.convergenceGated).toBe(false);
  });
});

describe('B-AC2 — flywheel.config.yaml kill switch loader', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'conv-cfg-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns DEFAULT_CONFIG when no file exists', () => {
    const cfg = loadFlywheelConfig(tmpRoot);
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it('parses gate_advance_wave: false', () => {
    writeFileSync(
      join(tmpRoot, 'flywheel.config.yaml'),
      'convergence:\n  gate_advance_wave: false\n',
      'utf8',
    );
    const cfg = loadFlywheelConfig(tmpRoot);
    expect(cfg.convergence.gate_advance_wave).toBe(false);
  });

  it('parses gate_advance_wave: true (explicit) the same as default', () => {
    writeFileSync(
      join(tmpRoot, 'flywheel.config.yaml'),
      'convergence:\n  gate_advance_wave: true\n',
      'utf8',
    );
    const cfg = loadFlywheelConfig(tmpRoot);
    expect(cfg.convergence.gate_advance_wave).toBe(true);
  });

  it('falls back to defaults on malformed YAML', () => {
    writeFileSync(join(tmpRoot, 'flywheel.config.yaml'), '!!! not yaml :: ::', 'utf8');
    const cfg = loadFlywheelConfig(tmpRoot);
    expect(cfg.convergence.gate_advance_wave).toBe(true);
  });
});

describe('B-AC2 — flywheel_advance_wave convergence gating', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'conv-aw-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function setupFixture(opts: {
    score: number;
    killSwitchOn: boolean;
  }): Promise<void> {
    writeFileSync(
      join(tmpRoot, 'flywheel.config.yaml'),
      `convergence:\n  gate_advance_wave: ${opts.killSwitchOn ? 'true' : 'false'}\n`,
      'utf8',
    );
    const planPath = 'docs/plans/active.md';
    await writeCheckpoint(tmpRoot, makeState({ phase: 'planning', planDocument: planPath }));
    const slug = planSlugFromIdentifier(planPath);
    await writeConvergenceToDisk(tmpRoot, buildConvergenceFixture(slug, opts.score));
  }

  it('gate ON + score 0.91: convergence.armed=true, reason=auto_approve_recommended', async () => {
    await setupFixture({ score: 0.91, killSwitchOn: true });
    const ctx = makeCtx(tmpRoot);
    const result = await runAdvanceWave(ctx, { cwd: tmpRoot, closedBeadIds: ['bogus-id'] });
    const structured = (result as { structuredContent: unknown }).structuredContent as {
      data: { convergence?: { armed: boolean; reason: string; score: number | null } };
    };
    // verify-beads will fail/route through stragglers since the bead doesn't exist;
    // in either case convergence rec must still appear.
    expect(structured.data.convergence).toBeDefined();
    if (structured.data.convergence) {
      expect(structured.data.convergence.armed).toBe(true);
      expect(structured.data.convergence.reason).toBe('auto_approve_recommended');
    }
  });

  it('gate OFF + score 0.91: convergence.armed=false, reason=kill_switch_off', async () => {
    await setupFixture({ score: 0.91, killSwitchOn: false });
    const ctx = makeCtx(tmpRoot);
    const result = await runAdvanceWave(ctx, { cwd: tmpRoot, closedBeadIds: ['bogus-id'] });
    const structured = (result as { structuredContent: unknown }).structuredContent as {
      data: { convergence?: { armed: boolean; reason: string } };
    };
    expect(structured.data.convergence).toBeDefined();
    if (structured.data.convergence) {
      expect(structured.data.convergence.armed).toBe(false);
      expect(structured.data.convergence.reason).toBe('kill_switch_off');
    }
  });

  it('gate ON + score 0.85 (below threshold): convergence.armed=false, reason=below_threshold', async () => {
    await setupFixture({ score: 0.85, killSwitchOn: true });
    const ctx = makeCtx(tmpRoot);
    const result = await runAdvanceWave(ctx, { cwd: tmpRoot, closedBeadIds: ['bogus-id'] });
    const structured = (result as { structuredContent: unknown }).structuredContent as {
      data: { convergence?: { armed: boolean; reason: string; score: number | null } };
    };
    expect(structured.data.convergence).toBeDefined();
    if (structured.data.convergence) {
      expect(structured.data.convergence.armed).toBe(false);
      expect(structured.data.convergence.reason).toBe('below_threshold');
      expect(structured.data.convergence.score).toBeCloseTo(0.85, 5);
    }
  });

  it('no plan: convergence.reason=no_active_plan (absent state regardless of kill switch)', async () => {
    writeFileSync(
      join(tmpRoot, 'flywheel.config.yaml'),
      'convergence:\n  gate_advance_wave: true\n',
      'utf8',
    );
    const ctx = makeCtx(tmpRoot);
    const result = await runAdvanceWave(ctx, { cwd: tmpRoot, closedBeadIds: ['bogus-id'] });
    const structured = (result as { structuredContent: unknown }).structuredContent as {
      data: { convergence?: { armed: boolean; reason: string } };
    };
    if (structured.data.convergence) {
      expect(structured.data.convergence.armed).toBe(false);
      expect(['no_active_plan', 'no_state']).toContain(structured.data.convergence.reason);
    }
  });
});

describe('B-AC2 — flywheel_doctor convergence_state_validity check', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'conv-doc-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('green when no plan in flight', async () => {
    const report = await runDoctorChecks(tmpRoot, undefined, { totalBudgetMs: 5000 });
    const check = report.checks.find((c) => c.name === 'convergence_state_validity');
    expect(check).toBeDefined();
    expect(check?.severity).toBe('green');
  });

  it('green when plan in flight and on-disk state is valid', async () => {
    const planPath = 'docs/plans/p.md';
    await writeCheckpoint(tmpRoot, makeState({ phase: 'planning', planDocument: planPath }));
    const slug = planSlugFromIdentifier(planPath);
    await writeConvergenceToDisk(tmpRoot, buildConvergenceFixture(slug, 0.6));

    const report = await runDoctorChecks(tmpRoot, undefined, { totalBudgetMs: 5000 });
    const check = report.checks.find((c) => c.name === 'convergence_state_validity');
    expect(check?.severity).toBe('green');
  });

  it('red when on-disk state has scoreVersion mismatch', async () => {
    const planPath = 'docs/plans/p.md';
    await writeCheckpoint(tmpRoot, makeState({ phase: 'planning', planDocument: planPath }));
    const slug = planSlugFromIdentifier(planPath);
    const filePath = convergencePath(tmpRoot, slug);
    mkdirSync(join(tmpRoot, '.pi-flywheel/plans', slug), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          version: 1,
          planSlug: slug,
          scoreVersion: 999,
          revisions: [],
          signals: { outputSizeTrend: 0, changeVelocity: 0, similarityTrend: 1 },
          oscillation: { signFlips: 0, detected: false },
          score: 0.5,
          status: 'approaching',
          estimatedRoundsRemaining: null,
          computedAt: '2026-05-05T00:00:00.000Z',
        },
        null,
        2,
      ),
      'utf8',
    );

    const report = await runDoctorChecks(tmpRoot, undefined, { totalBudgetMs: 5000 });
    const check = report.checks.find((c) => c.name === 'convergence_state_validity');
    expect(check?.severity).toBe('red');
    expect(check?.message).toMatch(/score_version_mismatch/);
  });

  it('red when state file is corrupt JSON', async () => {
    const planPath = 'docs/plans/p.md';
    await writeCheckpoint(tmpRoot, makeState({ phase: 'planning', planDocument: planPath }));
    const slug = planSlugFromIdentifier(planPath);
    const filePath = convergencePath(tmpRoot, slug);
    mkdirSync(join(tmpRoot, '.pi-flywheel/plans', slug), { recursive: true });
    writeFileSync(filePath, '{ not json', 'utf8');

    const report = await runDoctorChecks(tmpRoot, undefined, { totalBudgetMs: 5000 });
    const check = report.checks.find((c) => c.name === 'convergence_state_validity');
    expect(check?.severity).toBe('red');
  });
});

describe('B-AC2 — round-trip via writeConvergenceToDisk + readConvergenceFromDisk', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'conv-rt-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('append→write→read returns an equivalent ConvergenceState', async () => {
    const slug = 'rt-plan';
    const m1 = computeRevisionMetrics('a\nb\nc\n', null, {
      revisionId: 'r0',
      timestamp: '2026-05-05T00:00:00.000Z',
    });
    const s1 = appendRevision(null, m1, slug, { computedAt: '2026-05-05T00:00:00.000Z' });
    await writeConvergenceToDisk(tmpRoot, s1);
    const result = await readConvergenceFromDisk(tmpRoot, slug);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.data.state).toEqual(s1);
    }
  });
});

describe('B-AC2 — Step 5.45 question-text contract (skill renderer expectation)', () => {
  // The skill drives the actual AskUserQuestion render; we can't render it
  // here, but we can assert the *contract* the skill needs: when convergence
  // state is loaded, the score+status fields are present and formatted in the
  // shape Step 5.45 expects (a number with 2 fractional digits, plus a
  // ConvergenceStatus enum string).
  it('score formats to 2dp; status is one of the known enum values', () => {
    const s = buildConvergenceFixture('p', 0.823);
    const formatted = `(score ${s.score.toFixed(2)}, ${s.status})`;
    expect(formatted).toBe('(score 0.82, nearly_converged)');
    expect([
      'diverging',
      'approaching',
      'nearly_converged',
      'converged',
      'oscillating',
    ]).toContain(s.status);
  });
});
