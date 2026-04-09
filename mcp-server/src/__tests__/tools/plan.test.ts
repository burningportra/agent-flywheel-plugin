import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlan } from '../../tools/plan.js';
import { createMockExec, makeState } from '../helpers/mocks.js';
import type { OrchestratorState } from '../../types.js';

// ─── Helpers ──────────────────────────────────────────────────

function makeCtx(stateOverrides: Partial<OrchestratorState> = {}, cwd = '/fake/cwd') {
  const exec = createMockExec();
  const state = makeState({ selectedGoal: 'Add caching layer', ...stateOverrides });
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

// ─── Tests ────────────────────────────────────────────────────

describe('runPlan', () => {
  // ── Error cases ──────────────────────────────────────────────

  it('returns error when no selectedGoal', async () => {
    const { ctx } = makeCtx({ selectedGoal: undefined });

    const result = await runPlan(ctx, { cwd: '/fake/cwd' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No goal selected');
  });

  // ── Standard mode (no planFile, no planContent) ──────────────

  it('returns planning prompt in standard mode', async () => {
    const { ctx } = makeCtx();

    const result = await runPlan(ctx, { cwd: '/fake/cwd', mode: 'standard' });

    const text = result.content[0].text;
    expect(text).toContain('Add caching layer');
    expect(text).toContain('Plan Document Requirements');
    expect(text).toContain('orch_approve_beads');
  });

  it('sets phase to planning in standard mode', async () => {
    const { ctx, state } = makeCtx();

    await runPlan(ctx, { cwd: '/fake/cwd', mode: 'standard' });

    expect(state.phase).toBe('planning');
    expect(state.planRefinementRound).toBe(0);
  });

  it('sets planDocument path in standard mode', async () => {
    const { ctx, state } = makeCtx();

    await runPlan(ctx, { cwd: '/fake/cwd', mode: 'standard' });

    expect(state.planDocument).toMatch(/^docs\/plans\/.*add-caching-layer\.md$/);
  });

  it('defaults to standard mode when mode not specified', async () => {
    const { ctx } = makeCtx();

    const result = await runPlan(ctx, { cwd: '/fake/cwd' });

    const text = result.content[0].text;
    expect(text).toContain('Plan Document Requirements');
  });

  it('includes constraints in output when present', async () => {
    const { ctx } = makeCtx({ constraints: ['no breaking changes'] });

    const result = await runPlan(ctx, { cwd: '/fake/cwd', mode: 'standard' });

    expect(result.content[0].text).toContain('no breaking changes');
  });

  it('includes repo profile context when available', async () => {
    const { ctx } = makeCtx({
      repoProfile: {
        name: 'myrepo',
        languages: ['TypeScript'],
        frameworks: ['Express'],
        structure: '',
        entrypoints: [],
        recentCommits: [],
        hasTests: true,
        hasDocs: false,
        hasCI: false,
        todos: [],
        keyFiles: {},
      },
    });

    const result = await runPlan(ctx, { cwd: '/fake/cwd', mode: 'standard' });

    const text = result.content[0].text;
    expect(text).toContain('TypeScript');
    expect(text).toContain('Express');
  });

  it('calls saveState twice in standard mode', async () => {
    const { ctx, saved } = makeCtx();

    await runPlan(ctx, { cwd: '/fake/cwd', mode: 'standard' });

    // First save sets phase/planRefinementRound, second save sets planDocument
    expect(saved.length).toBe(2);
  });

  // ── planFile provided ────────────────────────────────────────

  describe('with planFile', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'plan-test-'));
    });

    it('reads plan from disk and transitions to awaiting_plan_approval', async () => {
      const planPath = join(tmpDir, 'plan.md');
      writeFileSync(planPath, '# My Plan\n\nSome plan content here.\n');

      const { ctx, state } = makeCtx({}, tmpDir);

      const result = await runPlan(ctx, { cwd: tmpDir, planFile: 'plan.md' });

      expect(result.isError).toBeUndefined();
      expect(state.phase).toBe('awaiting_plan_approval');
      expect(state.planDocument).toBe('plan.md');
      expect(state.planRefinementRound).toBe(0);
      expect(result.content[0].text).toContain('Plan loaded from');
    });

    it('returns error when planFile does not exist', async () => {
      const { ctx } = makeCtx({}, tmpDir);

      const result = await runPlan(ctx, { cwd: tmpDir, planFile: 'missing.md' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('planFile not found');
    });

    it('reports plan stats (chars, lines) in output', async () => {
      const content = 'line1\nline2\nline3\n';
      const planPath = join(tmpDir, 'plan.md');
      writeFileSync(planPath, content);

      const { ctx } = makeCtx({}, tmpDir);

      const result = await runPlan(ctx, { cwd: tmpDir, planFile: 'plan.md' });

      expect(result.content[0].text).toContain(`${content.length} chars`);
      expect(result.content[0].text).toContain('4 lines'); // 3 lines + trailing newline split
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  // ── planContent provided inline ──────────────────────────────

  describe('with planContent', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'plan-content-'));
    });

    it('writes plan to disk and transitions to awaiting_plan_approval', async () => {
      const { ctx, state } = makeCtx({}, tmpDir);

      const result = await runPlan(ctx, { cwd: tmpDir, planContent: '# Plan\n\nContent here' });

      expect(result.isError).toBeUndefined();
      expect(state.phase).toBe('awaiting_plan_approval');
      expect(state.planDocument).toMatch(/docs\/plans\/.*synthesized\.md$/);
      expect(state.planRefinementRound).toBe(0);
      expect(result.content[0].text).toContain('Plan received and saved');
    });

    it('ignores empty/whitespace planContent', async () => {
      const { ctx } = makeCtx({}, tmpDir);

      const result = await runPlan(ctx, { cwd: tmpDir, planContent: '   ' });

      // Should fall through to standard mode prompt
      expect(result.content[0].text).toContain('Plan Document Requirements');
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  // ── Deep mode ────────────────────────────────────────────────

  it('returns agent spawn configs in deep mode', async () => {
    const { ctx } = makeCtx();

    const result = await runPlan(ctx, { cwd: '/fake/cwd', mode: 'deep' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.action).toBe('spawn-plan-agents');
    expect(parsed.goal).toBe('Add caching layer');
    expect(parsed.planAgents.length).toBeGreaterThanOrEqual(3);
  });

  it('includes correctness, robustness, and ergonomics perspectives in deep mode', async () => {
    const { ctx } = makeCtx();

    const result = await runPlan(ctx, { cwd: '/fake/cwd', mode: 'deep' });

    const parsed = JSON.parse(result.content[0].text);
    const perspectives = parsed.planAgents.map((a: { perspective: string }) => a.perspective);
    expect(perspectives).toContain('correctness');
    expect(perspectives).toContain('robustness');
    expect(perspectives).toContain('ergonomics');
  });

  it('sets phase to planning in deep mode', async () => {
    const { ctx, state } = makeCtx();

    await runPlan(ctx, { cwd: '/fake/cwd', mode: 'deep' });

    expect(state.phase).toBe('planning');
  });
});
