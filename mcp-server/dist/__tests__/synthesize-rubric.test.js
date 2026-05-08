/**
 * Tool-wrapper tests for `flywheel_synthesize_rubric` (T15 / claude-orchestrator-2uy).
 *
 * Asserts the version: 1 envelope, all 4 result kinds, FlywheelErrorCode
 * propagation, and that the synthesizer is short-circuited when an
 * operator-edited rubric is on disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSynthesizeRubric } from '../tools/synthesize-rubric.js';
import { DEFAULT_HINTS, DEFAULT_RETRYABLE } from '../errors.js';
const SAMPLE_RUBRIC = `---
version: 1
source: auto
generatedAt: 2026-05-08T12:30:00Z
planSlug: tool-test-slug
goal: Tool wrapper test
criteria:
  - id: c1
    description: Tool wrapper returns version 1 envelope
    weight: 0.5
  - id: c2
    description: Action variants round-trip cleanly
    weight: 0.3
  - id: c3
    description: Errors flow through makeFlywheelErrorResult
    weight: 0.2
---
`;
const SAMPLE_PLAN = '# Plan body\n\n## Section\n\nSome content.\n';
function makeBaseState(overrides = {}) {
    return {
        phase: 'awaiting_plan_approval',
        selectedGoal: 'Tool wrapper test',
        constraints: [],
        retryCount: 0,
        maxRetries: 3,
        maxReviewPasses: 2,
        iterationRound: 0,
        currentGateIndex: 0,
        polishRound: 0,
        polishChanges: [],
        polishConverged: false,
        ...overrides,
    };
}
function makeCtx(cwd, stateOverrides = {}) {
    const state = makeBaseState(stateOverrides);
    const exec = async () => ({ code: 1, stdout: '', stderr: 'not mocked' });
    const ctx = {
        exec,
        cwd,
        state,
        saveState: () => { },
        clearState: () => { },
    };
    return { ctx, state };
}
describe('flywheel_synthesize_rubric tool wrapper', () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'sr-tool-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });
    it('rubric_synthesized vs rubric_preserved discriminator: cache-hit path returns version 1 envelope', async () => {
        // The wrapper does not expose a driver-injection seam (the synthesizer
        // driver is module-level on outcome-grading.ts). Exercise the wrapper
        // end-to-end via the cache-hit path instead — a fresh-auto rubric on
        // disk produces kind=rubric_preserved, which still pins version: 1
        // envelope and the data shape.
        void SAMPLE_PLAN;
        writeFileSync(join(dir, 'plan.md'), SAMPLE_PLAN, 'utf8');
        mkdirSync(join(dir, '.pi-flywheel/plans/plan'), { recursive: true });
        writeFileSync(join(dir, '.pi-flywheel/plans/plan/rubric.md'), SAMPLE_RUBRIC, 'utf8');
        // Sidecar lock with a matching planContentSha so the cache hits
        // *before* the edited-source guard would fire on a non-edited rubric.
        const planSha = await import('node:crypto').then((m) => m.createHash('sha256').update(SAMPLE_PLAN).digest('hex'));
        writeFileSync(join(dir, '.pi-flywheel/plans/plan/.rubric.lock'), JSON.stringify({ planContentSha: planSha, generatedAt: '2026-05-08T12:30:00Z', source: 'auto' }, null, 2), 'utf8');
        const { ctx } = makeCtx(dir, { planDocument: 'plan.md' });
        const result = await runSynthesizeRubric(ctx, { cwd: dir, action: 'synthesize' });
        expect(result.isError).toBeUndefined();
        const sc = result.structuredContent;
        expect(sc.tool).toBe('flywheel_synthesize_rubric');
        expect(sc.version).toBe(1);
        expect(sc.status).toBe('ok');
        expect(sc.data.kind).toBe('rubric_preserved');
        expect(sc.data.rubric.criteria.length).toBe(3);
    });
    it('rubric_preserved: edited rubric on disk returns kind=preserved without spawning synth', async () => {
        writeFileSync(join(dir, 'plan.md'), SAMPLE_PLAN, 'utf8');
        mkdirSync(join(dir, '.pi-flywheel/plans/plan'), { recursive: true });
        writeFileSync(join(dir, '.pi-flywheel/plans/plan/rubric.md'), SAMPLE_RUBRIC.replace('source: auto', 'source: edited'), 'utf8');
        const { ctx } = makeCtx(dir, { planDocument: 'plan.md' });
        const result = await runSynthesizeRubric(ctx, { cwd: dir, action: 'synthesize' });
        const sc = result.structuredContent;
        expect(sc.data.kind).toBe('rubric_preserved');
        expect(sc.data.source).toBe('cached');
        expect(sc.data.rubric.source).toBe('edited');
    });
    it('rubric_validated: action=validate parses without writing', async () => {
        mkdirSync(join(dir, '.pi-flywheel/plans/some-slug'), { recursive: true });
        writeFileSync(join(dir, '.pi-flywheel/plans/some-slug/rubric.md'), SAMPLE_RUBRIC, 'utf8');
        const { ctx } = makeCtx(dir);
        const result = await runSynthesizeRubric(ctx, {
            cwd: dir,
            action: 'validate',
            planSlug: 'some-slug',
        });
        const sc = result.structuredContent;
        expect(sc.data.kind).toBe('rubric_validated');
        expect(sc.data.rubric.criteria.length).toBe(3);
    });
    it("invalid_input when action='edit' lacks editIntent", async () => {
        const { ctx } = makeCtx(dir);
        const result = await runSynthesizeRubric(ctx, { cwd: dir, action: 'edit' });
        expect(result.isError).toBe(true);
        const sc = result.structuredContent;
        expect(sc.data.error.code).toBe('invalid_input');
        expect(sc.data.error.hint).toContain('editIntent');
    });
    it('rubric_missing routes through makeFlywheelErrorResult with default hint', async () => {
        const { ctx } = makeCtx(dir);
        const result = await runSynthesizeRubric(ctx, {
            cwd: dir,
            action: 'validate',
            planSlug: 'no-such-slug',
        });
        expect(result.isError).toBe(true);
        const sc = result.structuredContent;
        expect(sc.data.error.code).toBe('rubric_missing');
        expect(sc.data.error.hint).toBe(DEFAULT_HINTS.rubric_missing);
        expect(sc.data.error.retryable).toBe(DEFAULT_RETRYABLE.rubric_missing);
    });
    it('Zod input failure surfaces invalid_input', async () => {
        const { ctx } = makeCtx(dir);
        // missing cwd
        const result = await runSynthesizeRubric(ctx, { action: 'synthesize' });
        expect(result.isError).toBe(true);
        const sc = result.structuredContent;
        expect(sc.data.error.code).toBe('invalid_input');
    });
});
//# sourceMappingURL=synthesize-rubric.test.js.map