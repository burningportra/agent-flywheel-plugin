import { describe, it, expect } from 'vitest';
import { createInitialState, PostmortemDraftSchema } from '../types.js';
describe('createInitialState', () => {
    it('returns an object with all required fields', () => {
        const state = createInitialState();
        expect(state).toHaveProperty('phase');
        expect(state).toHaveProperty('constraints');
        expect(state).toHaveProperty('retryCount');
        expect(state).toHaveProperty('maxRetries');
        expect(state).toHaveProperty('maxReviewPasses');
        expect(state).toHaveProperty('iterationRound');
        expect(state).toHaveProperty('currentGateIndex');
        expect(state).toHaveProperty('polishRound');
        expect(state).toHaveProperty('polishChanges');
        expect(state).toHaveProperty('polishConverged');
    });
    it('starts in idle phase', () => {
        expect(createInitialState().phase).toBe('idle');
    });
    it('starts with empty constraints', () => {
        expect(createInitialState().constraints).toEqual([]);
    });
    it('starts with zero counters', () => {
        const state = createInitialState();
        expect(state.retryCount).toBe(0);
        expect(state.iterationRound).toBe(0);
        expect(state.currentGateIndex).toBe(0);
        expect(state.polishRound).toBe(0);
    });
    it('starts with default max values', () => {
        const state = createInitialState();
        expect(state.maxRetries).toBe(3);
        expect(state.maxReviewPasses).toBe(2);
    });
    it('starts with empty polishChanges and polishConverged false', () => {
        const state = createInitialState();
        expect(state.polishChanges).toEqual([]);
        expect(state.polishConverged).toBe(false);
    });
});
describe('FlywheelToolName', () => {
    it('includes flywheel_memory so shared contracts cover the full flywheel tool surface', () => {
        const toolName = 'flywheel_memory';
        expect(toolName).toBe('flywheel_memory');
    });
});
// ─── P1-1: PostmortemDraftSchema.markdown length bound (v3.4.1) ─
//
// Prior behavior: `markdown` was `z.string()` with no max. A pathological
// post-mortem (e.g., huge concatenated stderr) could push MB of payload
// through cross-process messages and the memory store.
// Fixed behavior: `markdown` is bounded at 200_000 chars (~200KB UTF-8).
describe('PostmortemDraftSchema — P1-1 markdown length bound', () => {
    const baseline = {
        version: 1,
        goal: 'test goal',
        phase: 'test phase',
        hasWarnings: false,
        warnings: [],
    };
    it('accepts a markdown payload just under the 200_000-char cap', () => {
        const markdown = 'x'.repeat(199_999);
        const result = PostmortemDraftSchema.safeParse({ ...baseline, markdown });
        expect(result.success).toBe(true);
    });
    it('accepts a markdown payload exactly at the 200_000-char cap', () => {
        const markdown = 'x'.repeat(200_000);
        const result = PostmortemDraftSchema.safeParse({ ...baseline, markdown });
        expect(result.success).toBe(true);
    });
    it('rejects a markdown payload that exceeds the 200_000-char cap', () => {
        const markdown = 'x'.repeat(200_001);
        const result = PostmortemDraftSchema.safeParse({ ...baseline, markdown });
        expect(result.success).toBe(false);
    });
});
//# sourceMappingURL=types.test.js.map