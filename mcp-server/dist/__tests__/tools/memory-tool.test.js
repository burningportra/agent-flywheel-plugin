import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { runMemory } from '../../tools/memory-tool.js';
import { createMockExec, makeState } from '../helpers/mocks.js';
// ─── Helpers ──────────────────────────────────────────────────
function makeCtx(execCalls = [], stateOverrides = {}, cwd = '/fake/cwd') {
    const exec = createMockExec(execCalls);
    const state = makeState(stateOverrides);
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
function cmVersionCall(available) {
    return {
        cmd: 'cm',
        args: ['--version'],
        result: available
            ? { code: 0, stdout: 'cm 1.0.0', stderr: '' }
            : { code: 1, stdout: '', stderr: 'not found' },
    };
}
// ─── Tests ────────────────────────────────────────────────────
describe('runMemory', () => {
    // ── cm unavailable ───────────────────────────────────────────
    it('returns guidance when cm is not available', async () => {
        const { ctx } = makeCtx([cmVersionCall(false)]);
        const result = await runMemory(ctx, { cwd: '/fake/cwd' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('not available');
        expect(result.structuredContent?.data?.error?.code).toBe('cli_not_available');
        expect(result.structuredContent?.data?.error?.hint).toContain('npm install -g @cass/cm');
    });
    it('returns cli_not_available when cm version check throws', async () => {
        const exec = vi.fn().mockRejectedValueOnce(new Error('spawn cm ENOENT'));
        const state = makeState();
        const ctx = {
            exec,
            cwd: '/fake/cwd',
            state,
            saveState: (_s) => { },
            clearState: () => { },
        };
        const result = await runMemory(ctx, { cwd: '/fake/cwd' });
        expect(result.isError).toBe(true);
        expect(result.structuredContent?.data?.error?.code).toBe('cli_not_available');
    });
    it('returns cli_failure when search exec throws', async () => {
        const exec = vi.fn()
            .mockResolvedValueOnce({ code: 0, stdout: 'cm 1.0.0', stderr: '' })
            .mockRejectedValueOnce(new Error('context crashed'));
        const state = makeState();
        const ctx = {
            exec,
            cwd: '/fake/cwd',
            state,
            saveState: (_s) => { },
            clearState: () => { },
        };
        const result = await runMemory(ctx, { cwd: '/fake/cwd', query: 'test' });
        expect(result.isError).toBe(true);
        expect(result.structuredContent?.data?.error?.code).toBe('cli_failure');
    });
    // ── search operation (default, no query → cm ls) ─────────────
    it('lists recent entries when no query given', async () => {
        const { ctx } = makeCtx([
            cmVersionCall(true),
            {
                cmd: 'cm',
                args: ['ls', '--limit', '10'],
                result: { code: 0, stdout: 'entry 1\nentry 2\n', stderr: '' },
            },
        ]);
        const result = await runMemory(ctx, { cwd: '/fake/cwd' });
        expect(result.content[0].text).toContain('Recent CASS memory');
        expect(result.content[0].text).toContain('entry 1');
    });
    it('returns message when no entries exist', async () => {
        const { ctx } = makeCtx([
            cmVersionCall(true),
            {
                cmd: 'cm',
                args: ['ls', '--limit', '10'],
                result: { code: 0, stdout: '', stderr: '' },
            },
        ]);
        const result = await runMemory(ctx, { cwd: '/fake/cwd' });
        expect(result.content[0].text).toContain('No memory entries found');
    });
    it('returns error when list fails', async () => {
        const { ctx } = makeCtx([
            cmVersionCall(true),
            {
                cmd: 'cm',
                args: ['ls', '--limit', '10'],
                result: { code: 1, stdout: '', stderr: 'db error' },
            },
        ]);
        const result = await runMemory(ctx, { cwd: '/fake/cwd' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Failed to list memory');
    });
    // ── search with query (cm context) ──────────────────────────
    it('searches with query using cm context', async () => {
        const contextResponse = JSON.stringify({
            success: true,
            command: 'context',
            data: {
                task: 'auth middleware',
                relevantBullets: [
                    { id: 'b-123', category: 'architecture', content: 'Auth middleware refactor note', finalScore: 2.5 },
                ],
                antiPatterns: [],
                historySnippets: [],
            },
        });
        const { ctx } = makeCtx([
            cmVersionCall(true),
            {
                cmd: 'cm',
                args: ['context', 'auth middleware', '--json'],
                result: { code: 0, stdout: contextResponse, stderr: '' },
            },
        ]);
        const result = await runMemory(ctx, { cwd: '/fake/cwd', query: 'auth middleware' });
        expect(result.content[0].text).toContain('auth middleware');
        expect(result.content[0].text).toContain('b-123');
        expect(result.content[0].text).toContain('Auth middleware refactor note');
    });
    it('returns message when search finds no matches', async () => {
        const { ctx } = makeCtx([
            cmVersionCall(true),
            {
                cmd: 'cm',
                args: ['context', 'nonexistent', '--json'],
                result: { code: 0, stdout: '', stderr: '' },
            },
        ]);
        const result = await runMemory(ctx, { cwd: '/fake/cwd', query: 'nonexistent' });
        expect(result.content[0].text).toContain('No memory entries match');
    });
    it('returns error when search fails', async () => {
        const { ctx } = makeCtx([
            cmVersionCall(true),
            {
                cmd: 'cm',
                args: ['context', 'test', '--json'],
                result: { code: 1, stdout: '', stderr: 'search error' },
            },
        ]);
        const result = await runMemory(ctx, { cwd: '/fake/cwd', query: 'test' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Search failed');
    });
    it('trims whitespace from query', async () => {
        const contextResponse = JSON.stringify({
            success: true,
            data: {
                relevantBullets: [{ id: 'b-1', content: 'result', finalScore: 1.0 }],
            },
        });
        const { ctx } = makeCtx([
            cmVersionCall(true),
            {
                cmd: 'cm',
                args: ['context', 'trimmed query', '--json'],
                result: { code: 0, stdout: contextResponse, stderr: '' },
            },
        ]);
        const result = await runMemory(ctx, { cwd: '/fake/cwd', query: '  trimmed query  ' });
        expect(result.content[0].text).toContain('result');
    });
    it('formats anti-patterns and history snippets', async () => {
        const contextResponse = JSON.stringify({
            success: true,
            data: {
                relevantBullets: [{ id: 'b-1', category: 'testing', content: 'Always test edge cases', finalScore: 3.0 }],
                antiPatterns: [{ id: 'b-2', content: 'Never mock the database in integration tests' }],
                historySnippets: [{ snippet: 'Previous session used real DB successfully' }],
            },
        });
        const { ctx } = makeCtx([
            cmVersionCall(true),
            {
                cmd: 'cm',
                args: ['context', 'testing', '--json'],
                result: { code: 0, stdout: contextResponse, stderr: '' },
            },
        ]);
        const result = await runMemory(ctx, { cwd: '/fake/cwd', query: 'testing' });
        expect(result.content[0].text).toContain('Relevant Rules');
        expect(result.content[0].text).toContain('Anti-Patterns');
        expect(result.content[0].text).toContain('History');
        expect(result.content[0].text).toContain('Never mock the database');
    });
    it('handles raw output when JSON parse fails', async () => {
        const { ctx } = makeCtx([
            cmVersionCall(true),
            {
                cmd: 'cm',
                args: ['context', 'broken', '--json'],
                result: { code: 0, stdout: 'not valid json but has results', stderr: '' },
            },
        ]);
        const result = await runMemory(ctx, { cwd: '/fake/cwd', query: 'broken' });
        // Falls back to raw output
        expect(result.content[0].text).toContain('not valid json but has results');
    });
    // ── store operation ──────────────────────────────────────────
    it('stores memory content', async () => {
        const { ctx } = makeCtx([
            cmVersionCall(true),
            {
                cmd: 'cm',
                args: ['add', 'remember this important fact'],
                result: { code: 0, stdout: 'Stored: id-123', stderr: '' },
            },
        ]);
        const result = await runMemory(ctx, {
            cwd: '/fake/cwd',
            operation: 'store',
            content: 'remember this important fact',
        });
        expect(result.content[0].text).toContain('Memory stored successfully');
        expect(result.content[0].text).toContain('Stored: id-123');
    });
    it('returns error when store content is empty', async () => {
        const { ctx } = makeCtx([cmVersionCall(true)]);
        const result = await runMemory(ctx, { cwd: '/fake/cwd', operation: 'store', content: '' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('content is required');
    });
    it('returns error when store content is whitespace only', async () => {
        const { ctx } = makeCtx([cmVersionCall(true)]);
        const result = await runMemory(ctx, { cwd: '/fake/cwd', operation: 'store', content: '   ' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('content is required');
    });
    it('returns error when store content is missing', async () => {
        const { ctx } = makeCtx([cmVersionCall(true)]);
        const result = await runMemory(ctx, { cwd: '/fake/cwd', operation: 'store' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('content is required');
    });
    it('returns error when cm add fails', async () => {
        const { ctx } = makeCtx([
            cmVersionCall(true),
            {
                cmd: 'cm',
                args: ['add', 'some content'],
                result: { code: 1, stdout: '', stderr: 'write error' },
            },
        ]);
        const result = await runMemory(ctx, { cwd: '/fake/cwd', operation: 'store', content: 'some content' });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Failed to store memory');
    });
    it('trims content before storing', async () => {
        const { ctx } = makeCtx([
            cmVersionCall(true),
            {
                cmd: 'cm',
                args: ['add', 'trimmed content'],
                result: { code: 0, stdout: 'Stored', stderr: '' },
            },
        ]);
        const result = await runMemory(ctx, { cwd: '/fake/cwd', operation: 'store', content: '  trimmed content  ' });
        expect(result.content[0].text).toContain('Memory stored successfully');
    });
    // ── Default operation ────────────────────────────────────────
    it('defaults to search operation', async () => {
        const { ctx } = makeCtx([
            cmVersionCall(true),
            {
                cmd: 'cm',
                args: ['ls', '--limit', '10'],
                result: { code: 0, stdout: 'entry', stderr: '' },
            },
        ]);
        // No operation specified — should default to search (list mode)
        const result = await runMemory(ctx, { cwd: '/fake/cwd' });
        expect(result.content[0].text).toContain('Recent CASS memory');
    });
    it('returns structured not_found when refreshRoot does not exist', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'memory-refresh-'));
        try {
            const { ctx } = makeCtx([], {}, cwd);
            const result = await runMemory(ctx, {
                cwd,
                operation: 'refresh_learnings',
                refreshRoot: 'docs/solutions',
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toBe(`refreshRoot not found: ${join(cwd, 'docs', 'solutions')}`);
            expect(result.structuredContent?.data?.error?.code).toBe('not_found');
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('rejects refreshRoot symlinks that resolve outside cwd', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'memory-refresh-'));
        const outsideDir = mkdtempSync(join(tmpdir(), 'memory-outside-'));
        try {
            mkdirSync(join(cwd, 'docs'), { recursive: true });
            writeFileSync(join(outsideDir, 'note.md'), '# External\n');
            symlinkSync(outsideDir, join(cwd, 'docs', 'solutions'));
            const { ctx } = makeCtx([], {}, cwd);
            const result = await runMemory(ctx, {
                cwd,
                operation: 'refresh_learnings',
                refreshRoot: 'docs/solutions',
            });
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('refreshRoot rejected by realpath guard');
            expect(result.structuredContent?.data?.error?.code).toBe('invalid_input');
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
            rmSync(outsideDir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=memory-tool.test.js.map