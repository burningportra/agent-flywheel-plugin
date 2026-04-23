/**
 * Tests for the draft_solution_doc branch of runMemory (bead 71x).
 *
 * Coverage:
 *   - missing entryId → invalid_input error envelope
 *   - happy path → structuredContent.data.kind === 'solution_doc_draft'
 *   - rendered markdown contains the entry_id (reconciliation join key)
 *   - never invokes `cm` CLI (no CASS write side-effect)
 */
import { describe, it, expect, vi } from 'vitest';
import { runMemory } from '../../tools/memory-tool.js';
import { makeState } from '../helpers/mocks.js';
vi.mock('../../agent-mail.js', () => ({
    agentMailRPC: vi.fn(async () => ({ ok: true, data: { messages: [] } })),
    unwrapRPC: (r) => (r?.ok ? r.data : null),
}));
function makeMemoryCtx(stateOverrides = {}) {
    // exec mock — supports only the git calls draftPostmortem makes.
    const calls = [];
    const exec = vi.fn(async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'git' && args[0] === 'cat-file') {
            return { code: 0, stdout: '', stderr: '' };
        }
        if (cmd === 'git' && args[0] === 'log' && args.some((a) => a.startsWith('--pretty=format:%h|%s|%an'))) {
            return { code: 0, stdout: 'c1|feat: x|tester', stderr: '' };
        }
        if (cmd === 'git' && args[0] === 'log' && args.includes('--stat')) {
            return { code: 0, stdout: ' src/episodic-memory.ts | 5 +++--', stderr: '' };
        }
        if (cmd === 'git' && args[0] === 'merge-base') {
            return { code: 0, stdout: 'abc\n', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: 'not mocked' };
    });
    const state = makeState({
        selectedGoal: 'add solution doc store',
        sessionStartSha: 'abc123',
        phase: 'complete',
        ...stateOverrides,
    });
    const ctx = {
        exec: exec,
        cwd: '/fake/cwd',
        state,
        saveState: (_s) => { },
        clearState: () => { },
    };
    return { ctx, calls };
}
describe('runMemory(operation=draft_solution_doc)', () => {
    it('returns invalid_input when entryId is missing', async () => {
        const { ctx } = makeMemoryCtx();
        const result = await runMemory(ctx, {
            cwd: '/fake/cwd',
            operation: 'draft_solution_doc',
            // entryId omitted
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent?.data?.error?.code).toBe('invalid_input');
        expect(result.structuredContent?.data?.error?.hint).toContain('store');
    });
    it('returns invalid_input when entryId is whitespace-only', async () => {
        const { ctx } = makeMemoryCtx();
        const result = await runMemory(ctx, {
            cwd: '/fake/cwd',
            operation: 'draft_solution_doc',
            entryId: '   ',
        });
        expect(result.structuredContent?.data?.error?.code).toBe('invalid_input');
    });
    it('happy path: returns SolutionDoc + rendered markdown structuredContent', async () => {
        const { ctx } = makeMemoryCtx();
        const result = await runMemory(ctx, {
            cwd: '/fake/cwd',
            operation: 'draft_solution_doc',
            entryId: 'cass-tooltest-1',
        });
        expect(result.isError).toBeFalsy();
        const data = result.structuredContent?.data;
        expect(data?.kind).toBe('solution_doc_draft');
        expect(data?.doc?.frontmatter?.entry_id).toBe('cass-tooltest-1');
        expect(data?.doc?.path).toMatch(/^docs\/solutions\/[a-z0-9-]+\/[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.md$/);
        // The rendered text contains entry_id (reconciliation join key)
        expect(data?.rendered).toContain('entry_id: "cass-tooltest-1"');
        // Frontmatter delimiters
        expect(data?.rendered.startsWith('---\n')).toBe(true);
        // Text preview surfaces the path so the wrap-up skill can find it
        expect(result.content[0]?.text).toContain(data?.doc?.path);
    });
    it('does not invoke cm CLI (no CASS write)', async () => {
        const { ctx, calls } = makeMemoryCtx();
        await runMemory(ctx, {
            cwd: '/fake/cwd',
            operation: 'draft_solution_doc',
            entryId: 'cass-no-cm',
        });
        const cmCalls = calls.filter((c) => c.cmd === 'cm');
        expect(cmCalls).toHaveLength(0);
    });
});
//# sourceMappingURL=memory-tool.solution-doc.test.js.map