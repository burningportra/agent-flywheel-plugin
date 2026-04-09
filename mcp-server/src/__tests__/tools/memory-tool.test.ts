import { describe, it, expect } from 'vitest';
import { runMemory } from '../../tools/memory-tool.js';
import { createMockExec, makeState } from '../helpers/mocks.js';
import type { OrchestratorState } from '../../types.js';
import type { ExecCall } from '../helpers/mocks.js';

// ─── Helpers ──────────────────────────────────────────────────

function makeCtx(execCalls: ExecCall[] = [], stateOverrides: Partial<OrchestratorState> = {}) {
  const exec = createMockExec(execCalls);
  const state = makeState(stateOverrides);
  const saved: OrchestratorState[] = [];
  const ctx = {
    exec,
    cwd: '/fake/cwd',
    state,
    saveState: (s: OrchestratorState) => { saved.push(structuredClone(s)); },
    clearState: () => {},
  };
  return { ctx, state, saved };
}

function cmVersionCall(available: boolean): ExecCall {
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

    expect(result.content[0].text).toContain('not available');
    expect(result.content[0].text).toContain('npm install');
  });

  // ── search operation (default) ───────────────────────────────

  it('lists recent entries when no query given', async () => {
    const { ctx } = makeCtx([
      cmVersionCall(true),
      {
        cmd: 'cm',
        args: ['list', '--limit', '10'],
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
        args: ['list', '--limit', '10'],
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
        args: ['list', '--limit', '10'],
        result: { code: 1, stdout: '', stderr: 'db error' },
      },
    ]);

    const result = await runMemory(ctx, { cwd: '/fake/cwd' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to list memory');
  });

  it('searches with query', async () => {
    const { ctx } = makeCtx([
      cmVersionCall(true),
      {
        cmd: 'cm',
        args: ['search', 'auth middleware'],
        result: { code: 0, stdout: 'Found: auth middleware refactor note', stderr: '' },
      },
    ]);

    const result = await runMemory(ctx, { cwd: '/fake/cwd', query: 'auth middleware' });

    expect(result.content[0].text).toContain('auth middleware');
    expect(result.content[0].text).toContain('Found:');
  });

  it('returns message when search finds no matches', async () => {
    const { ctx } = makeCtx([
      cmVersionCall(true),
      {
        cmd: 'cm',
        args: ['search', 'nonexistent'],
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
        args: ['search', 'test'],
        result: { code: 1, stdout: '', stderr: 'search error' },
      },
    ]);

    const result = await runMemory(ctx, { cwd: '/fake/cwd', query: 'test' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Search failed');
  });

  it('trims whitespace from query', async () => {
    const { ctx } = makeCtx([
      cmVersionCall(true),
      {
        cmd: 'cm',
        args: ['search', 'trimmed query'],
        result: { code: 0, stdout: 'result', stderr: '' },
      },
    ]);

    const result = await runMemory(ctx, { cwd: '/fake/cwd', query: '  trimmed query  ' });

    expect(result.content[0].text).toContain('result');
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
        args: ['list', '--limit', '10'],
        result: { code: 0, stdout: 'entry', stderr: '' },
      },
    ]);

    // No operation specified — should default to search
    const result = await runMemory(ctx, { cwd: '/fake/cwd' });

    expect(result.content[0].text).toContain('Recent CASS memory');
  });
});
