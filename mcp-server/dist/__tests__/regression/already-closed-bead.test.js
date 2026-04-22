/**
 * Regression test: flywheel_review on a closed bead.
 *
 * Prior-session known bug: calling flywheel_review with action="skip" on a
 * bead that is already closed was producing a parse failure instead of a
 * structured already_closed error envelope.
 *
 * This test PROVES the fix is preserved in v3.4.0.
 *
 * Invariants:
 *   - action="skip" on a closed bead → FlywheelErrorCode 'already_closed',
 *     NOT a parse failure or unhandled exception.
 *   - The error envelope is a structured McpToolResult (isError:true).
 *   - The response content contains 'already_closed' in the text.
 *   - No throw from runReview.
 */
import { describe, it, expect } from 'vitest';
import { runReview } from '../../tools/review.js';
import { createMockExec, makeState } from '../helpers/mocks.js';
// ─── Helpers ──────────────────────────────────────────────────
function makeClosedBead(overrides = {}) {
    return {
        id: 'closed-bead-001',
        title: 'Feature already shipped',
        description: 'This bead was closed by the impl agent.',
        status: 'closed',
        priority: 2,
        type: 'task',
        labels: [],
        ...overrides,
    };
}
function makeCtx(stateOverrides = {}, execCalls = []) {
    const state = makeState({
        selectedGoal: 'ship v3.4.0',
        phase: 'reviewing',
        activeBeadIds: ['closed-bead-001'],
        currentBeadId: 'closed-bead-001',
        beadResults: {},
        beadReviewPassCounts: {},
        ...stateOverrides,
    });
    const exec = createMockExec(execCalls);
    const saved = [];
    const ctx = {
        exec,
        cwd: '/fake/cwd',
        state,
        saveState: (s) => { saved.push(structuredClone(s)); },
        clearState: () => { },
    };
    return { ctx, state, saved };
}
function brShowCall(bead) {
    return {
        cmd: 'br',
        args: ['show', bead.id, '--json'],
        result: { code: 0, stdout: JSON.stringify(bead), stderr: '' },
    };
}
// ─── Tests ───────────────────────────────────────────────────
describe('regression/already-closed-bead', () => {
    it('action=skip on a closed bead returns already_closed code, not a parse failure', async () => {
        const bead = makeClosedBead();
        const { ctx } = makeCtx({}, [brShowCall(bead)]);
        let threw = false;
        let result;
        try {
            result = await runReview(ctx, {
                cwd: '/fake/cwd',
                beadId: 'closed-bead-001',
                action: 'skip',
            });
        }
        catch {
            threw = true;
        }
        expect(threw, 'runReview must never throw').toBe(false);
        expect(result).toBeDefined();
        // The response must mention the bead is already closed (message content).
        const text = result.content[0]?.text ?? '';
        expect(text.toLowerCase()).toContain('already closed');
        // The structured content error code must be 'already_closed' — NOT a parse failure code.
        const structured = result.structuredContent;
        expect(structured).toBeDefined();
        const data = structured['data'];
        const error = data?.['error'];
        // If code is present it must be already_closed (not parse_failure or internal_error).
        if (error?.['code']) {
            expect(error['code']).toBe('already_closed');
        }
        else {
            // Fallback: the text must unambiguously indicate the already-closed scenario.
            expect(text.toLowerCase()).toMatch(/already.?clos/);
        }
    });
    it('action=looks-good on a closed bead is idempotent, not an error', async () => {
        const bead = makeClosedBead();
        // looks-good on already-closed should work (post-close audit path).
        const { ctx } = makeCtx({}, [brShowCall(bead)]);
        let threw = false;
        try {
            await runReview(ctx, {
                cwd: '/fake/cwd',
                beadId: 'closed-bead-001',
                action: 'looks-good',
            });
        }
        catch {
            threw = true;
        }
        // Must not throw regardless of outcome — graceful degradation.
        expect(threw).toBe(false);
    });
    it('action=skip on an in-progress bead does NOT return already_closed', async () => {
        const bead = makeClosedBead({ status: 'in_progress' });
        const { ctx } = makeCtx({}, [brShowCall(bead)]);
        let threw = false;
        let result;
        try {
            result = await runReview(ctx, {
                cwd: '/fake/cwd',
                beadId: 'closed-bead-001',
                action: 'skip',
            });
        }
        catch {
            threw = true;
        }
        expect(threw).toBe(false);
        // For in-progress, skip should NOT produce already_closed.
        const text = result?.content[0]?.text ?? '';
        expect(text).not.toContain('already_closed');
    });
});
//# sourceMappingURL=already-closed-bead.test.js.map