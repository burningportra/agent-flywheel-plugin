import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlan } from '../../tools/plan.js';
import { createMockExec, makeState } from '../helpers/mocks.js';
// ─── Helpers ──────────────────────────────────────────────────
function makeCtx(stateOverrides = {}, cwd = '/fake/cwd') {
    const exec = createMockExec();
    const state = makeState({ selectedGoal: 'Add caching layer', ...stateOverrides });
    const saved = [];
    const ctx = {
        exec,
        cwd,
        state,
        saveState: (s) => { saved.push(structuredClone(s)); },
        clearState: () => { },
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
        expect(result.structuredContent).toMatchObject({
            tool: 'flywheel_plan',
            version: 1,
            status: 'ok',
            phase: 'planning',
            data: {
                kind: 'plan_prompt',
                mode: 'standard',
                goal: 'Add caching layer',
            },
        });
        expect(text).toContain('Add caching layer');
        expect(text).toContain('Plan Document Requirements');
        expect(text).toContain('flywheel_approve_beads');
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
        let tmpDir;
        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'plan-test-'));
        });
        it('reads plan from disk and transitions to awaiting_plan_approval', async () => {
            const planPath = join(tmpDir, 'plan.md');
            writeFileSync(planPath, '# My Plan\n\nSome plan content here.\n');
            const { ctx, state } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, planFile: 'plan.md' });
            expect(result.isError).toBeUndefined();
            expect(result.structuredContent).toMatchObject({
                tool: 'flywheel_plan',
                version: 1,
                status: 'ok',
                phase: 'awaiting_plan_approval',
                data: {
                    kind: 'plan_registered',
                    source: 'plan_file',
                    goal: 'Add caching layer',
                    planDocument: 'plan.md',
                },
            });
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
        let tmpDir;
        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'plan-content-'));
        });
        it('writes plan to disk and transitions to awaiting_plan_approval', async () => {
            const { ctx, state } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, planContent: '# Plan\n\nContent here' });
            expect(result.isError).toBeUndefined();
            expect(result.structuredContent).toMatchObject({
                tool: 'flywheel_plan',
                version: 1,
                status: 'ok',
                phase: 'awaiting_plan_approval',
                data: {
                    kind: 'plan_registered',
                    source: 'inline_plan_content',
                    goal: 'Add caching layer',
                },
            });
            expect(state.phase).toBe('awaiting_plan_approval');
            expect(state.planDocument).toMatch(/docs\/plans\/.*synthesized\.md$/);
            expect(state.planRefinementRound).toBe(0);
            expect(result.content[0].text).toContain('Plan received and saved');
        });
        it('returns empty_plan error for whitespace-only planContent', async () => {
            const { ctx } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, planContent: '   ' });
            expect(result.isError).toBe(true);
            expect(result.structuredContent).toMatchObject({
                tool: 'flywheel_plan',
                status: 'error',
                data: { kind: 'error', error: { code: 'empty_plan' } },
            });
        });
        it('returns deep_plan_all_failed when planContent contains the failure sentinel', async () => {
            const { ctx } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, planContent: '(No planner outputs provided.)' });
            expect(result.isError).toBe(true);
            expect(result.structuredContent).toMatchObject({
                tool: 'flywheel_plan',
                status: 'error',
                data: {
                    kind: 'error',
                    error: {
                        code: 'deep_plan_all_failed',
                        hint: 'Retry with mode=standard as fallback.',
                    },
                },
            });
        });
        it('returns empty_plan when planContent is an agent failure sentinel', async () => {
            const { ctx } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, planContent: '(AGENT RETURNED EMPTY — correctness planner)' });
            expect(result.isError).toBe(true);
            expect(result.structuredContent).toMatchObject({
                tool: 'flywheel_plan',
                status: 'error',
                data: { kind: 'error', error: { code: 'empty_plan' } },
            });
        });
        it('restores planDocument when saveState returns false', async () => {
            const exec = createMockExec();
            const state = makeState({ selectedGoal: 'Add caching layer', planDocument: 'old-plan.md', phase: 'planning' });
            const ctx = {
                exec,
                cwd: tmpDir,
                state,
                saveState: (_s) => Promise.resolve(false),
                clearState: () => { },
            };
            await runPlan(ctx, { cwd: tmpDir, planContent: '# Plan\n\nContent here' });
            expect(state.planDocument).toBe('old-plan.md');
            expect(state.phase).toBe('planning');
        });
        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });
    });
    // ── Deep mode ────────────────────────────────────────────────
    it('returns agent spawn configs in deep mode', async () => {
        const { ctx } = makeCtx();
        const result = await runPlan(ctx, { cwd: '/fake/cwd', mode: 'deep' });
        expect(result.structuredContent).toMatchObject({
            tool: 'flywheel_plan',
            version: 1,
            status: 'ok',
            phase: 'planning',
            data: {
                kind: 'deep_plan_spawn',
                goal: 'Add caching layer',
            },
        });
        const structured = result.structuredContent;
        expect(structured.data.planAgents.length).toBeGreaterThanOrEqual(3);
    });
    it('includes correctness, robustness, and ergonomics perspectives in deep mode', async () => {
        const { ctx } = makeCtx();
        const result = await runPlan(ctx, { cwd: '/fake/cwd', mode: 'deep' });
        const structured = result.structuredContent;
        expect(structured.data.kind).toBe('deep_plan_spawn');
        const perspectives = structured.data.planAgents.map(a => a.perspective);
        expect(perspectives).toContain('correctness');
        expect(perspectives).toContain('robustness');
        expect(perspectives).toContain('ergonomics');
    });
    it('sets phase to planning in deep mode', async () => {
        const { ctx, state } = makeCtx();
        await runPlan(ctx, { cwd: '/fake/cwd', mode: 'deep' });
        expect(state.phase).toBe('planning');
    });
    it('each planAgent task contains "Use ultrathink." in deep mode', async () => {
        const { ctx } = makeCtx();
        const result = await runPlan(ctx, { cwd: '/fake/cwd', mode: 'deep' });
        const structured = result.structuredContent;
        for (const agent of structured.data.planAgents) {
            expect(agent.task).toContain('Use ultrathink.');
        }
    });
    it('synthesisPrompt contains "Use ultrathink." in deep mode', async () => {
        const { ctx } = makeCtx();
        const result = await runPlan(ctx, { cwd: '/fake/cwd', mode: 'deep' });
        const structured = result.structuredContent;
        expect(structured.data.synthesisPrompt).toContain('Use ultrathink.');
    });
    // ── Phase 0.5 brainstorm artifact handoff ────────────────────
    // _planning.md §4.5 writes docs/brainstorms/<goal-slug>-<date>.md.
    // flywheel_plan must auto-detect the latest match and inject it into the
    // planner prompt for both standard and deep modes — see plan.ts
    // readLatestBrainstorm + formatBrainstormSection.
    describe('Phase 0.5 brainstorm handoff', () => {
        let tmpDir;
        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'plan-brainstorm-'));
        });
        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });
        function writeBrainstorm(slug, date, body) {
            const dir = join(tmpDir, 'docs', 'brainstorms');
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, `${slug}-${date}.md`), body, 'utf8');
        }
        it('standard mode includes brainstorm section when artifact exists', async () => {
            writeBrainstorm('add-caching-layer', '2026-04-23', '# Brainstorm\n\nFraming: cache the hot path only.');
            const { ctx } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, mode: 'standard' });
            const text = result.content[0].text;
            expect(text).toContain('## Phase 0.5 Brainstorm');
            expect(text).toContain('docs/brainstorms/add-caching-layer-2026-04-23.md');
            expect(text).toContain('cache the hot path only');
            const structured = result.structuredContent;
            expect(structured.data.brainstormDocument).toBe('docs/brainstorms/add-caching-layer-2026-04-23.md');
        });
        it('standard mode omits brainstorm section when no artifact exists', async () => {
            const { ctx } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, mode: 'standard' });
            const text = result.content[0].text;
            expect(text).not.toContain('Phase 0.5 Brainstorm');
            const structured = result.structuredContent;
            expect(structured.data.brainstormDocument).toBeUndefined();
        });
        it('picks the lexically-greatest brainstorm when multiple dates exist', async () => {
            writeBrainstorm('add-caching-layer', '2026-04-20', '# OLD');
            writeBrainstorm('add-caching-layer', '2026-04-23', '# NEWEST');
            writeBrainstorm('add-caching-layer', '2026-04-21', '# MIDDLE');
            const { ctx } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, mode: 'standard' });
            expect(result.content[0].text).toContain('NEWEST');
            expect(result.content[0].text).not.toContain('OLD');
            expect(result.content[0].text).not.toContain('MIDDLE');
        });
        it('ignores brainstorms whose slug does not match the current goal', async () => {
            writeBrainstorm('some-other-goal', '2026-04-23', '# IRRELEVANT');
            const { ctx } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, mode: 'standard' });
            expect(result.content[0].text).not.toContain('IRRELEVANT');
            expect(result.content[0].text).not.toContain('Phase 0.5 Brainstorm');
        });
        it('deep mode threads brainstorm into every planner agent prompt', async () => {
            writeBrainstorm('add-caching-layer', '2026-04-23', '# Brainstorm\n\nSmallest: just LRU.');
            const { ctx } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, mode: 'deep' });
            const structured = result.structuredContent;
            expect(structured.data.brainstormDocument).toBe('docs/brainstorms/add-caching-layer-2026-04-23.md');
            for (const agent of structured.data.planAgents) {
                expect(agent.task).toContain('Phase 0.5 Brainstorm');
                expect(agent.task).toContain('Smallest: just LRU.');
            }
        });
    });
});
//# sourceMappingURL=plan.test.js.map