import { describe, it, expect } from 'vitest';
import { selectStrategy, selectMode } from '../coordination.js';
// ─── Helpers ────────────────────────────────────────────────────
function makeBackend(overrides = {}) {
    return {
        beads: false,
        agentMail: false,
        sophia: false,
        preCommitGuardInstalled: false,
        ...overrides,
    };
}
// ─── selectStrategy ─────────────────────────────────────────────
describe('selectStrategy', () => {
    it('returns "beads+agentmail" when beads and agentMail are both available', () => {
        const backend = makeBackend({ beads: true, agentMail: true });
        expect(selectStrategy(backend)).toBe('beads+agentmail');
    });
    it('returns "sophia" when sophia backend is available', () => {
        const backend = makeBackend({ sophia: true });
        expect(selectStrategy(backend)).toBe('sophia');
    });
    it('returns "worktrees" when only beads is available (no agentMail)', () => {
        const backend = makeBackend({ beads: true, agentMail: false });
        expect(selectStrategy(backend)).toBe('worktrees');
    });
    it('returns "worktrees" when nothing is available', () => {
        const backend = makeBackend();
        expect(selectStrategy(backend)).toBe('worktrees');
    });
});
// ─── selectMode ─────────────────────────────────────────────────
describe('selectMode', () => {
    it('returns "single-branch" when agentMail is available', () => {
        const backend = makeBackend({ agentMail: true });
        expect(selectMode(backend)).toBe('single-branch');
    });
    it('returns "worktree" when agentMail is not available', () => {
        const backend = makeBackend({ agentMail: false });
        expect(selectMode(backend)).toBe('worktree');
    });
});
//# sourceMappingURL=coordination.test.js.map