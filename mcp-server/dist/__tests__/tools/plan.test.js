import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlan } from '../../tools/plan.js';
import { createMockExec, makeState } from '../helpers/mocks.js';
// Deep mode reads CASS memory through the host's real `cm` binary, which makes
// the prompt depend on this machine and blocks for seconds per call.
vi.mock('../../memory.js', () => ({ readMemory: () => '' }));
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
        // ── claude-orchestrator-ttk: source="picked-up-existing-plan" gates Step 5.45 ──
        it('records planSource="picked-up-existing-plan" when source arg is supplied', async () => {
            const planPath = join(tmpDir, 'plan.md');
            writeFileSync(planPath, '# Picked-up Plan\n');
            const { ctx, state } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, {
                cwd: tmpDir,
                planFile: 'plan.md',
                source: 'picked-up-existing-plan',
            });
            expect(result.isError).toBeUndefined();
            expect(state.planSource).toBe('picked-up-existing-plan');
            expect(result.structuredContent).toMatchObject({
                data: {
                    kind: 'plan_registered',
                    planSource: 'picked-up-existing-plan',
                    pickedUp: true,
                },
            });
            // Step 5.45 hint must appear in the user-facing text so the orchestrator
            // doesn't blindly jump to flywheel_approve_beads.
            expect(result.content[0].text).toContain('5.45');
        });
        it('does NOT set planSource when source arg is omitted (fresh plan path)', async () => {
            const planPath = join(tmpDir, 'plan.md');
            writeFileSync(planPath, '# Fresh Plan\n');
            const { ctx, state } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, planFile: 'plan.md' });
            expect(result.isError).toBeUndefined();
            expect(state.planSource).toBeUndefined();
            expect(result.structuredContent).toMatchObject({
                data: { pickedUp: false },
            });
            // Default text path → flywheel_approve_beads, not 5.45.
            expect(result.content[0].text).toContain('flywheel_approve_beads');
            expect(result.content[0].text).not.toContain('5.45');
        });
        it('returns error when planFile does not exist', async () => {
            const { ctx } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, planFile: 'missing.md' });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('planFile not found');
        });
        it('rejects planFile symlinks that resolve outside cwd', async () => {
            const outsideDir = mkdtempSync(join(tmpdir(), 'plan-outside-'));
            const outsidePlan = join(outsideDir, 'external.md');
            writeFileSync(outsidePlan, '# External Plan\n');
            symlinkSync(outsidePlan, join(tmpDir, 'plan.md'));
            try {
                const { ctx } = makeCtx({}, tmpDir);
                const result = await runPlan(ctx, { cwd: tmpDir, planFile: 'plan.md' });
                expect(result.isError).toBe(true);
                expect(result.content[0].text).toContain('planFile rejected by realpath guard');
                expect(result.structuredContent?.data?.error?.code).toBe('invalid_input');
            }
            finally {
                rmSync(outsideDir, { recursive: true, force: true });
            }
        });
        it('rejects planFile when a directory component is a symlink escaping cwd', async () => {
            const outsideDir = mkdtempSync(join(tmpdir(), 'plan-outside-dir-'));
            const outsidePlan = join(outsideDir, 'plan.md');
            writeFileSync(outsidePlan, '# External Plan\n');
            symlinkSync(outsideDir, join(tmpDir, 'subdir'));
            try {
                const { ctx } = makeCtx({}, tmpDir);
                const result = await runPlan(ctx, {
                    cwd: tmpDir,
                    planFile: 'subdir/plan.md',
                });
                expect(result.isError).toBe(true);
                expect(result.content[0].text).toContain('planFile rejected by realpath guard');
                expect(result.structuredContent?.data?.error?.code).toBe('invalid_input');
            }
            finally {
                rmSync(outsideDir, { recursive: true, force: true });
            }
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
        it('ignores another goal whose slug extends this one (add-caching-layer-v2)', async () => {
            writeBrainstorm('add-caching-layer-v2', '2026-04-23', '# V2-GOAL-BRAINSTORM');
            const { ctx } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, mode: 'standard' });
            expect(result.content[0].text).not.toContain('V2-GOAL-BRAINSTORM');
            expect(result.content[0].text).not.toContain('Phase 0.5 Brainstorm');
            const structured = result.structuredContent;
            expect(structured.data.brainstormDocument).toBeUndefined();
        });
        it('does not read a lone ambition charter as the brainstorm', async () => {
            writeBrainstorm('add-caching-layer', '2026-04-23-ambition', '# CHARTER-NOT-BRAINSTORM');
            const { ctx } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, mode: 'standard' });
            expect(result.content[0].text).not.toContain('CHARTER-NOT-BRAINSTORM');
            expect(result.content[0].text).not.toContain('Phase 0.5 Brainstorm');
            const structured = result.structuredContent;
            expect(structured.data.brainstormDocument).toBeUndefined();
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
        it('refuses brainstorm symlink that points outside cwd (security)', async () => {
            // Plant a symlink whose name matches the slug pattern, pointing at
            // an external file. statSync would follow it; lstatSync must reject.
            const dir = join(tmpDir, 'docs', 'brainstorms');
            mkdirSync(dir, { recursive: true });
            const externalDir = mkdtempSync(join(tmpdir(), 'plan-brainstorm-attacker-'));
            const externalFile = join(externalDir, 'leak.md');
            writeFileSync(externalFile, '# LEAKED-CONTENT\n\nshould not appear in prompt', 'utf8');
            try {
                symlinkSync(externalFile, join(dir, 'add-caching-layer-2099-12-31.md'));
                const { ctx } = makeCtx({}, tmpDir);
                const result = await runPlan(ctx, { cwd: tmpDir, mode: 'standard' });
                const text = result.content[0].text;
                expect(text).not.toContain('LEAKED-CONTENT');
                expect(text).not.toContain('Phase 0.5 Brainstorm');
                const structured = result.structuredContent;
                expect(structured.data.brainstormDocument).toBeUndefined();
            }
            finally {
                rmSync(externalDir, { recursive: true, force: true });
            }
        });
    });
    describe('ambition axis', () => {
        const SCOPED_ANCHOR = 'Anchor scope to the smallest version; reserve the 10x version as a "future direction" appendix, not a v1 requirement.';
        const AMBITIOUS_ANCHOR = "The ambition charter below supersedes this scope anchor: treat the smallest version as the floor, delivered first, and the charter's stretch target as the goal.";
        const CHARTER_PATH = 'docs/brainstorms/add-caching-layer-2026-04-24-ambition.md';
        const BRAINSTORM_PATH = 'docs/brainstorms/add-caching-layer-2026-04-23.md';
        let tmpDir;
        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'plan-ambition-'));
        });
        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });
        function writeArtifact(relPath, body) {
            mkdirSync(join(tmpDir, 'docs', 'brainstorms'), { recursive: true });
            writeFileSync(join(tmpDir, relPath), body, 'utf8');
        }
        const dataOf = (result) => result.structuredContent.data;
        it('standard ambitious injects the charter after the brainstorm and flips the scope anchor', async () => {
            writeArtifact(BRAINSTORM_PATH, '# Brainstorm\n\nSmallest: LRU on the hot path.');
            writeArtifact(CHARTER_PATH, '# Charter\n\nStretch target: p95 under 5ms on the replay benchmark.');
            const { ctx } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, mode: 'standard', ambition: 'ambitious' });
            const text = result.content[0].text;
            expect(result.isError).toBeUndefined();
            expect(text).toContain('Stretch target: p95 under 5ms on the replay benchmark.');
            expect(text).toContain(`Source: \`${CHARTER_PATH}\``);
            expect(text).toContain('1. Open the plan with `## Ambition charter`');
            expect(text).toContain('0. **Ambition charter** — target rung, stretch target, floor, outside judge (see Ambition mode above)\n1. **Executive Summary**');
            expect(text).toContain(AMBITIOUS_ANCHOR);
            expect(text).not.toContain(SCOPED_ANCHOR);
            expect(text.indexOf('## Phase 0.5 Brainstorm')).toBeGreaterThan(-1);
            expect(text.indexOf('## Phase 0.5 Brainstorm')).toBeLessThan(text.indexOf('## Ambition mode (read FIRST)'));
            expect(text.indexOf('## Ambition mode (read FIRST)')).toBeLessThan(text.indexOf('## Plan Document Requirements'));
            const data = dataOf(result);
            expect(data.ambition).toBe('ambitious');
            expect(data.ambitionDocument).toBe(CHARTER_PATH);
            expect(data.brainstormDocument).toBe(BRAINSTORM_PATH);
        });
        it('ambitious without a charter returns missing_prerequisite and leaves state untouched', async () => {
            writeArtifact(BRAINSTORM_PATH, '# Brainstorm only');
            const { ctx, state, saved } = makeCtx({ phase: 'idle' }, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, mode: 'standard', ambition: 'ambitious' });
            expect(result.isError).toBe(true);
            expect(dataOf(result).error.code).toBe('missing_prerequisite');
            expect(result.content[0].text).toContain('docs/brainstorms/add-caching-layer-<YYYY-MM-DD>-ambition.md');
            expect(dataOf(result).error.hint).toContain('skills/start/_planning.md');
            expect(state.phase).toBe('idle');
            expect(state.planDocument).toBeUndefined();
            expect(saved).toHaveLength(0);
        });
        it('rejects an unknown ambition value before mutating state', async () => {
            const { ctx, state, saved } = makeCtx({ phase: 'idle' }, tmpDir);
            const result = await runPlan(ctx, {
                cwd: tmpDir,
                mode: 'standard',
                ambition: 'moonshot',
            });
            expect(result.isError).toBe(true);
            expect(dataOf(result).error.code).toBe('invalid_input');
            expect(dataOf(result).error.hint).toContain('"scoped"');
            expect(dataOf(result).error.hint).toContain('"ambitious"');
            expect(state.phase).toBe('idle');
            expect(saved).toHaveLength(0);
        });
        it('scoped plans ignore a charter on disk', async () => {
            writeArtifact(BRAINSTORM_PATH, '# Brainstorm');
            writeArtifact(CHARTER_PATH, '# STALE-CHARTER');
            const { ctx } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, mode: 'standard' });
            const text = result.content[0].text;
            expect(text).not.toContain('STALE-CHARTER');
            expect(text).not.toContain('Ambition mode');
            expect(text).toContain(SCOPED_ANCHOR);
            expect(dataOf(result).ambition).toBe('scoped');
            expect(dataOf(result).ambitionDocument).toBeUndefined();
        });
        it.each(['standard', 'deep', 'duel'])('%s scoped output is identical with or without a charter on disk', async (mode) => {
            writeArtifact(BRAINSTORM_PATH, '# Brainstorm');
            const before = await runPlan(makeCtx({}, tmpDir).ctx, { cwd: tmpDir, mode });
            writeArtifact(CHARTER_PATH, '# STALE-CHARTER');
            const omitted = await runPlan(makeCtx({}, tmpDir).ctx, { cwd: tmpDir, mode });
            const explicit = await runPlan(makeCtx({}, tmpDir).ctx, { cwd: tmpDir, mode, ambition: 'scoped' });
            expect(omitted.content[0].text).toBe(before.content[0].text);
            expect(explicit.content[0].text).toBe(before.content[0].text);
            expect(omitted.structuredContent).toEqual(before.structuredContent);
        });
        it('deep ambitious threads the charter into every planner and the synthesis prompt', async () => {
            writeArtifact(CHARTER_PATH, '# Charter\n\nFloor: cache reads only.');
            const { ctx } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, mode: 'deep', ambition: 'ambitious' });
            const data = dataOf(result);
            expect(data.planAgents.length).toBeGreaterThanOrEqual(3);
            for (const agent of data.planAgents) {
                expect(agent.task).toContain('Floor: cache reads only.');
                expect(agent.task).toContain('### Ambitious plan requirements');
                expect(agent.task).not.toContain('Phase 0.5 Brainstorm');
            }
            expect(data.synthesisPrompt).toContain('Do not average ambition down.');
            expect(data.ambition).toBe('ambitious');
            expect(data.ambitionDocument).toBe(CHARTER_PATH);
            const json = JSON.parse(result.content[0].text);
            expect(json.ambition).toBe('ambitious');
            expect(json.ambitionDocument).toBe(CHARTER_PATH);
        });
        it('duel ambitious tells the orchestrator to pre-seed both agents with the charter', async () => {
            writeArtifact(CHARTER_PATH, '# Charter');
            const { ctx } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, mode: 'duel', ambition: 'ambitious' });
            expect(result.content[0].text).toContain(`Pre-seed each agent with the ambition charter at \`${CHARTER_PATH}\``);
            expect(dataOf(result).ambition).toBe('ambitious');
            expect(dataOf(result).ambitionDocument).toBe(CHARTER_PATH);
            expect(dataOf(result).duelCommand).not.toContain('ambition');
        });
        it('picks the latest-dated charter when several exist', async () => {
            writeArtifact('docs/brainstorms/add-caching-layer-2026-04-20-ambition.md', '# OLD-CHARTER');
            writeArtifact('docs/brainstorms/add-caching-layer-2026-04-26-ambition.md', '# NEWEST-CHARTER');
            writeArtifact('docs/brainstorms/add-caching-layer-2026-04-22-ambition.md', '# MIDDLE-CHARTER');
            const { ctx } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, mode: 'standard', ambition: 'ambitious' });
            const text = result.content[0].text;
            expect(text).toContain('NEWEST-CHARTER');
            expect(text).not.toContain('OLD-CHARTER');
            expect(text).not.toContain('MIDDLE-CHARTER');
            expect(dataOf(result).ambitionDocument).toBe('docs/brainstorms/add-caching-layer-2026-04-26-ambition.md');
        });
        it('refuses a charter symlink that points outside cwd (security)', async () => {
            mkdirSync(join(tmpDir, 'docs', 'brainstorms'), { recursive: true });
            const externalDir = mkdtempSync(join(tmpdir(), 'plan-charter-attacker-'));
            const externalFile = join(externalDir, 'leak.md');
            writeFileSync(externalFile, '# LEAKED-CHARTER', 'utf8');
            try {
                symlinkSync(externalFile, join(tmpDir, CHARTER_PATH));
                const { ctx, saved } = makeCtx({}, tmpDir);
                const result = await runPlan(ctx, { cwd: tmpDir, mode: 'standard', ambition: 'ambitious' });
                expect(result.isError).toBe(true);
                expect(dataOf(result).error.code).toBe('missing_prerequisite');
                expect(JSON.stringify(result)).not.toContain('LEAKED-CHARTER');
                expect(saved).toHaveLength(0);
            }
            finally {
                rmSync(externalDir, { recursive: true, force: true });
            }
        });
        it('planFile registration ignores ambition, so a missing charter does not block it', async () => {
            writeFileSync(join(tmpDir, 'plan.md'), '# Synthesized duel plan\n');
            const { ctx, state } = makeCtx({}, tmpDir);
            const result = await runPlan(ctx, { cwd: tmpDir, mode: 'duel', planFile: 'plan.md', ambition: 'ambitious' });
            expect(result.isError).toBeUndefined();
            expect(state.phase).toBe('awaiting_plan_approval');
            expect(state.planDocument).toBe('plan.md');
        });
    });
});
//# sourceMappingURL=plan.test.js.map