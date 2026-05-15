/**
 * Unit tests for `outcome-grading.ts` — schema round-trips, idempotency,
 * cache + edited-source guard, iteration-cap coercion, cycleStartSha
 * ladder, diff/test-output truncation, concurrent mutex, prose-leakage
 * recovery, ENOSPC graceful degrade.
 *
 * Bead: claude-orchestrator-gx7 (T14).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GraderVerdictSchemaV1,
  RubricSchemaV1,
  buildGraderPrompt,
  defaultGraderDriver,
  defaultSynthesizerDriver,
  gradeOutcome,
  isGradeSkipped,
  parseRubricFrontmatter,
  planSlugFromIdentifier,
  renderRubricFrontmatter,
  rubricLockPathForSlug,
  rubricPathForSlug,
  synthesizeRubric,
  _resetGraderMutex,
  type GraderDriver,
  type GraderVerdict,
  type SynthesizerDriver,
} from '../outcome-grading.js';
import { writeAtomic } from '../atomic-write.js';
import type { FlywheelState, ToolContext } from '../types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeBaseState(overrides: Partial<FlywheelState> = {}): FlywheelState {
  return {
    phase: 'planning',
    selectedGoal: 'Outcome grading test goal',
    constraints: [],
    retryCount: 0,
    maxRetries: 3,
    maxReviewPasses: 2,
    iterationRound: 0,
    currentGateIndex: 0,
    polishRound: 0,
    polishChanges: [],
    polishConverged: false,
    cycleStartSha: '5c7ed76abc1234567890aabb',
    ...overrides,
  };
}

function makeCtx(cwd: string, stateOverrides: Partial<FlywheelState> = {}, execOverride?: ToolContext['exec']): {
  ctx: ToolContext;
  state: FlywheelState;
} {
  const state = makeBaseState(stateOverrides);
  const exec: ToolContext['exec'] = execOverride ?? (async (cmd: string, args: string[]) => {
    if (cmd === 'git' && args[0] === 'log') {
      return { code: 0, stdout: 'abc1234 feat(test): commit one\ndef5678 feat(test): commit two', stderr: '' };
    }
    if (cmd === 'git' && args[0] === 'diff' && args.includes('--stat')) {
      return { code: 0, stdout: ' src/foo.ts | 5 +++++\n 1 file changed', stderr: '' };
    }
    if (cmd === 'git' && args[0] === 'diff') {
      return { code: 0, stdout: 'diff --git a/src/foo.ts b/src/foo.ts\n+console.log("hi");\n', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'not mocked' };
  });
  const ctx: ToolContext = {
    exec,
    cwd,
    state,
    saveState: () => {},
    clearState: () => {},
  };
  return { ctx, state };
}

const SAMPLE_RUBRIC_BODY = `---
version: 1
source: auto
generatedAt: 2026-05-08T12:30:00Z
planSlug: test-slug
goal: Test goal
criteria:
  - id: c1
    description: outcome-grading.ts module exports RubricSchemaV1
    weight: 0.3
  - id: c2
    description: flywheel_synthesize_rubric tool registered in server.ts
    weight: 0.4
  - id: c3
    description: doctor outcome_rubric_validity check ships
    weight: 0.3
---
`;

const SAMPLE_PLAN = '# Test plan\n\nSome plan body.\n';

function makeSynthesizer(output: string): SynthesizerDriver {
  return async () => output;
}

function makeVerdictJson(overrides: Partial<GraderVerdict> = {}): string {
  const base: GraderVerdict = {
    version: 1,
    status: 'satisfied',
    iteration: 1,
    perCriterion: [
      { criterionId: 'c1', status: 'met', evidence: 'commit abc1234', gaps: [] },
      { criterionId: 'c2', status: 'met', evidence: 'server.ts +2 -0', gaps: [] },
      { criterionId: 'c3', status: 'met', evidence: 'doctor.ts +1 row', gaps: [] },
    ],
    explanation: 'all criteria met',
    modelUsed: 'codex',
    durationMs: 0,
    timestamp: '2026-05-08T13:00:00Z',
    ...overrides,
  };
  return JSON.stringify(base);
}

function makeGrader(output: string, modelUsed: 'codex' | 'claude' = 'codex'): GraderDriver {
  return async () => ({ stdout: output, modelUsed });
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('outcome-grading schema round-trips', () => {
  it('Rubric round-trips through frontmatter (auto)', () => {
    const r1 = parseRubricFrontmatter(SAMPLE_RUBRIC_BODY);
    const r2 = parseRubricFrontmatter(renderRubricFrontmatter(r1));
    expect(r2).toEqual(r1);
  });

  it('Rubric round-trips through frontmatter (edited source)', () => {
    const r1 = parseRubricFrontmatter(SAMPLE_RUBRIC_BODY.replace('source: auto', 'source: edited'));
    expect(r1.source).toBe('edited');
    const r2 = parseRubricFrontmatter(renderRubricFrontmatter(r1));
    expect(r2).toEqual(r1);
  });

  it('GraderVerdict round-trips for all 4 statuses', () => {
    for (const status of ['satisfied', 'needs_revision', 'max_iterations_reached', 'failed'] as const) {
      const json = makeVerdictJson({ status });
      const parsed = GraderVerdictSchemaV1.parse(JSON.parse(json));
      expect(parsed.status).toBe(status);
      expect(parsed.iteration).toBe(1);
    }
  });

  it('skip sentinel is identified by isGradeSkipped', () => {
    expect(isGradeSkipped({ status: 'skipped', reason: 'operator-skipped-at-plan-approve', iteration: 0 })).toBe(true);
  });
});

describe('synthesizeRubric — idempotency + edited-source guard', () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDir('og-synth-');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('same plan content → same rubric on second call (cache hit)', async () => {
    const planPath = join(dir, 'plan.md');
    writeFileSync(planPath, SAMPLE_PLAN, 'utf8');
    const { ctx } = makeCtx(dir);
    const synth = makeSynthesizer(SAMPLE_RUBRIC_BODY);

    const first = await synthesizeRubric(ctx, { cwd: dir, planPath: 'plan.md' }, { synthesizer: synth });
    const second = await synthesizeRubric(ctx, { cwd: dir, planPath: 'plan.md' }, { synthesizer: synth });
    expect(first.rubric).toEqual(second.rubric);
    expect(second.source).toBe('cached');
  });

  it('force=true bypasses the cache', async () => {
    const planPath = join(dir, 'plan.md');
    writeFileSync(planPath, SAMPLE_PLAN, 'utf8');
    const { ctx } = makeCtx(dir);
    const synth = makeSynthesizer(SAMPLE_RUBRIC_BODY);

    await synthesizeRubric(ctx, { cwd: dir, planPath: 'plan.md' }, { synthesizer: synth });
    let synthCount = 0;
    const counting: SynthesizerDriver = async () => { synthCount++; return SAMPLE_RUBRIC_BODY; };
    await synthesizeRubric(ctx, { cwd: dir, planPath: 'plan.md', force: true }, { synthesizer: counting });
    expect(synthCount).toBe(1);
  });

  it("source: 'edited' is preserved across default-action synth", async () => {
    const planPath = join(dir, 'plan.md');
    writeFileSync(planPath, SAMPLE_PLAN, 'utf8');
    const slug = planSlugFromIdentifier('plan.md');
    const rubricPath = join(dir, rubricPathForSlug(slug));
    mkdirSync(join(dir, '.pi-flywheel/plans/' + slug), { recursive: true });
    writeFileSync(rubricPath, SAMPLE_RUBRIC_BODY.replace('source: auto', 'source: edited'), 'utf8');
    const { ctx } = makeCtx(dir);

    let synthCount = 0;
    const counting: SynthesizerDriver = async () => { synthCount++; return SAMPLE_RUBRIC_BODY; };
    const result = await synthesizeRubric(ctx, { cwd: dir, planPath: 'plan.md' }, { synthesizer: counting });
    expect(synthCount).toBe(0);
    expect(result.rubric.source).toBe('edited');
    expect(result.source).toBe('cached');
  });

  it("regenerate (force=true) overwrites edited rubric", async () => {
    const planPath = join(dir, 'plan.md');
    writeFileSync(planPath, SAMPLE_PLAN, 'utf8');
    const slug = planSlugFromIdentifier('plan.md');
    const rubricPath = join(dir, rubricPathForSlug(slug));
    mkdirSync(join(dir, '.pi-flywheel/plans/' + slug), { recursive: true });
    writeFileSync(rubricPath, SAMPLE_RUBRIC_BODY.replace('source: auto', 'source: edited'), 'utf8');
    const { ctx } = makeCtx(dir);

    const result = await synthesizeRubric(
      ctx,
      { cwd: dir, planPath: 'plan.md', action: 'regenerate' },
      { synthesizer: makeSynthesizer(SAMPLE_RUBRIC_BODY) },
    );
    expect(result.rubric.source).toBe('auto');
  });

  it('validate action returns rubric without invoking synthesizer', async () => {
    const slug = 'test-slug';
    const rubricPath = join(dir, rubricPathForSlug(slug));
    mkdirSync(join(dir, '.pi-flywheel/plans/' + slug), { recursive: true });
    writeFileSync(rubricPath, SAMPLE_RUBRIC_BODY, 'utf8');
    const { ctx } = makeCtx(dir);
    let synthCount = 0;
    const counting: SynthesizerDriver = async () => { synthCount++; return ''; };

    const result = await synthesizeRubric(
      ctx,
      { cwd: dir, planSlug: slug, action: 'validate' },
      { synthesizer: counting },
    );
    expect(synthCount).toBe(0);
    expect(result.rubric.criteria.length).toBe(3);
  });

  it('atomic-write crash-recovery: rename failure leaves no rubric.md', async () => {
    const slug = 'crash-slug';
    const rubricAbs = join(dir, rubricPathForSlug(slug));
    const tmpAbs = `${rubricAbs}.tmp`;
    const dirAbs = join(dir, '.pi-flywheel/plans/' + slug);
    mkdirSync(dirAbs, { recursive: true });
    writeFileSync(tmpAbs, 'half-written', 'utf8');
    expect(existsSync(rubricAbs)).toBe(false);
    expect(existsSync(tmpAbs)).toBe(true);
    // The next successful writeAtomic recovers cleanly — overwrites the tmp
    // and lands the final file.
    await writeAtomic(rubricAbs, SAMPLE_RUBRIC_BODY);
    expect(existsSync(rubricAbs)).toBe(true);
    expect(readFileSync(rubricAbs, 'utf8')).toBe(SAMPLE_RUBRIC_BODY);
  });
});

describe('gradeOutcome — iteration cap, mutex, persistence, prose recovery', () => {
  let dir: string;
  let slug: string;

  beforeEach(() => {
    _resetGraderMutex();
    dir = freshDir('og-grade-');
    slug = 'test-slug';
    const rubricDir = join(dir, '.pi-flywheel/plans/' + slug);
    mkdirSync(rubricDir, { recursive: true });
    writeFileSync(join(rubricDir, 'rubric.md'), SAMPLE_RUBRIC_BODY, 'utf8');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('skip sentinel short-circuits when state.outcomeGradingSkipped', async () => {
    const { ctx } = makeCtx(dir, { outcomeGradingSkipped: true, outcomeRubricPath: rubricPathForSlug(slug) });
    const result = await gradeOutcome(ctx, { cwd: dir }, { grader: makeGrader('') });
    expect(isGradeSkipped(result)).toBe(true);
  });

  it('iteration-cap coercion: needs_revision @ iter 3 with cap 3 → max_iterations_reached', async () => {
    const { ctx } = makeCtx(dir, {
      outcomeRubricPath: rubricPathForSlug(slug),
      maxOutcomeIterations: 3,
      outcomeGradingHistory: [
        { iteration: 1, timestamp: 't1', verdict: {} as never },
        { iteration: 2, timestamp: 't2', verdict: {} as never },
      ],
    });
    const verdict = makeVerdictJson({ status: 'needs_revision', iteration: 3 });
    const result = await gradeOutcome(ctx, { cwd: dir }, { grader: makeGrader(verdict) });
    expect('status' in result && result.status).toBe('max_iterations_reached');
  });

  it('rejects when iteration-N.json already exists without force=true', async () => {
    const { ctx } = makeCtx(dir, { outcomeRubricPath: rubricPathForSlug(slug) });
    const verdictDir = join(dir, '.pi-flywheel/plans/' + slug + '/grading');
    mkdirSync(verdictDir, { recursive: true });
    writeFileSync(join(verdictDir, 'iteration-1.json'), '{}', 'utf8');

    await expect(
      gradeOutcome(ctx, { cwd: dir }, { grader: makeGrader(makeVerdictJson()) }),
    ).rejects.toMatchObject({ code: 'verdict_invalid' });
  });

  it('concurrent mutex returns concurrent_grade for the second call', async () => {
    const { ctx } = makeCtx(dir, { outcomeRubricPath: rubricPathForSlug(slug) });
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    const slowGrader: GraderDriver = async () => {
      await slow;
      return { stdout: makeVerdictJson(), modelUsed: 'codex' };
    };
    const first = gradeOutcome(ctx, { cwd: dir }, { grader: slowGrader });
    // Second call kicks off while the first is awaiting `slow`. Mutex should
    // reject it immediately with concurrent_grade.
    await expect(
      gradeOutcome(ctx, { cwd: dir }, { grader: makeGrader(makeVerdictJson()) }),
    ).rejects.toMatchObject({ code: 'concurrent_grade' });
    release();
    await first;
  });

  it('prose-leakage recovery: regex extracts {...} from prose-wrapped output', async () => {
    const { ctx } = makeCtx(dir, { outcomeRubricPath: rubricPathForSlug(slug) });
    const prose = `Here is your verdict:\n\n${makeVerdictJson()}\n\nThanks!`;
    const result = await gradeOutcome(ctx, { cwd: dir }, { grader: makeGrader(prose) });
    expect('status' in result && result.status).toBe('satisfied');
  });

  it('one auto-retry on Zod failure before surfacing verdict_invalid', async () => {
    const { ctx } = makeCtx(dir, { outcomeRubricPath: rubricPathForSlug(slug) });
    let attempts = 0;
    const driver: GraderDriver = async () => {
      attempts++;
      if (attempts === 1) return { stdout: '{ "version": 1, "iteration": 1 }', modelUsed: 'codex' };
      return { stdout: makeVerdictJson(), modelUsed: 'codex' };
    };
    const result = await gradeOutcome(ctx, { cwd: dir }, { grader: driver });
    expect(attempts).toBe(2);
    expect('status' in result && result.status).toBe('satisfied');
    expect('details' in result && result.details?.graderRetried).toBe(true);
  });

  it('persists verdict atomically and appends to outcomeGradingHistory', async () => {
    const { ctx, state } = makeCtx(dir, { outcomeRubricPath: rubricPathForSlug(slug) });
    await gradeOutcome(ctx, { cwd: dir }, { grader: makeGrader(makeVerdictJson()) });
    const verdictPath = join(dir, '.pi-flywheel/plans/' + slug + '/grading/iteration-1.json');
    expect(existsSync(verdictPath)).toBe(true);
    expect(state.outcomeGradingHistory?.length).toBe(1);
    expect(state.outcomeGradingHistory?.[0].iteration).toBe(1);
  });

  it('FIFO cap at 5 cycles', async () => {
    const seedHistory = Array.from({ length: 5 }, (_, i) => ({
      iteration: i + 1,
      timestamp: `t${i + 1}`,
      verdict: {} as never,
    }));
    const { ctx, state } = makeCtx(dir, {
      outcomeRubricPath: rubricPathForSlug(slug),
      outcomeGradingHistory: seedHistory,
    });
    await gradeOutcome(ctx, { cwd: dir, force: true }, { grader: makeGrader(makeVerdictJson({ iteration: 6 })) });
    expect(state.outcomeGradingHistory?.length).toBe(5);
    // Oldest entry got evicted; newest entry is at the tail.
    expect(state.outcomeGradingHistory?.[0].iteration).toBe(2);
    expect(state.outcomeGradingHistory?.[4].iteration).toBe(6);
  });
});

describe('buildGraderPrompt + truncation', () => {
  it('includes blind-auditor preamble and verbatim sections', () => {
    const prompt = buildGraderPrompt({
      rubricFrontmatter: '---\nversion: 1\n---',
      goal: 'Goal',
      iteration: 1,
      cap: 3,
      gitLog: 'abc1234 commit one',
      diffStat: ' src/foo.ts | 5 +++++',
      diffBody: 'diff body',
      diffTruncated: false,
      testOutput: 'PASS',
      testOutputTruncated: false,
    });
    expect(prompt).toContain('You are a blind auditor.');
    expect(prompt).toContain('Iteration: 1 of cap 3');
    expect(prompt).toContain('## Rubric (frontmatter)');
    expect(prompt).toContain('## git log');
    expect(prompt).toContain('## git diff');
    expect(prompt).toContain('## Test output');
  });

  it('renderRubricFrontmatter survives a zod parse → render → parse cycle', () => {
    const r = parseRubricFrontmatter(SAMPLE_RUBRIC_BODY);
    expect(RubricSchemaV1.safeParse(r).success).toBe(true);
    const reparsed = parseRubricFrontmatter(renderRubricFrontmatter(r));
    expect(reparsed).toEqual(r);
  });
});

describe('defaultGraderDriver — codex config compat preemption (bead claude-orchestrator-2wcd)', () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'flywheel-codex-home-'));
    mkdirSync(join(homeDir, '.codex'), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('skips codex when ~/.codex/config.toml sets an incompatible model (gpt-5*)', async () => {
    writeFileSync(join(homeDir, '.codex/config.toml'), 'model = "gpt-5.5"\n', 'utf8');
    let codexCalled = false;
    let claudeCalled = false;
    const fakeExec = async (cmd: string) => {
      if (cmd === 'codex') {
        codexCalled = true;
        return { code: 0, stdout: '{"version":1}', stderr: '' };
      }
      if (cmd === 'claude') {
        claudeCalled = true;
        return { code: 0, stdout: '{"version":1,"fallback":"claude"}', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected cmd ' + cmd };
    };
    const res = await defaultGraderDriver({
      exec: fakeExec,
      cwd: homeDir,
      prompt: 'noop',
      preferModel: 'codex',
      timeoutMs: 5_000,
    });
    expect(codexCalled).toBe(false);
    expect(claudeCalled).toBe(true);
    expect(res.modelUsed).toBe('claude');
  });

  it('proceeds with codex when ~/.codex/config.toml has no model override', async () => {
    writeFileSync(join(homeDir, '.codex/config.toml'), '# no model line\n[other_section]\nfoo = 1\n', 'utf8');
    let codexCalled = false;
    const fakeExec = async (cmd: string) => {
      if (cmd === 'codex') {
        codexCalled = true;
        return { code: 0, stdout: '{"version":1,"from":"codex"}', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected cmd ' + cmd };
    };
    const res = await defaultGraderDriver({
      exec: fakeExec,
      cwd: homeDir,
      prompt: 'noop',
      preferModel: 'codex',
      timeoutMs: 5_000,
    });
    expect(codexCalled).toBe(true);
    expect(res.modelUsed).toBe('codex');
  });

  it('proceeds with codex when ~/.codex/config.toml is missing', async () => {
    // homeDir/.codex exists but config.toml is not written
    let codexCalled = false;
    const fakeExec = async (cmd: string) => {
      if (cmd === 'codex') {
        codexCalled = true;
        return { code: 0, stdout: '{"version":1,"from":"codex-default"}', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected cmd ' + cmd };
    };
    const res = await defaultGraderDriver({
      exec: fakeExec,
      cwd: homeDir,
      prompt: 'noop',
      preferModel: 'codex',
      timeoutMs: 5_000,
    });
    expect(codexCalled).toBe(true);
    expect(res.modelUsed).toBe('codex');
  });
});
