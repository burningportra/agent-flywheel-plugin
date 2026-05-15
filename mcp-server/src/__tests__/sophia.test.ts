import { describe, expect, it, vi } from 'vitest';

import type { ExecFn } from '../exec.js';
import { parseSophiaResult } from '../parsers.js';
import {
  createCRFromPlan,
  type SophiaResult,
} from '../sophia.js';

type PlanStep = Parameters<typeof createCRFromPlan>[3][number];

const sophiaOk = (data: unknown = {}) => ({
  code: 0,
  stdout: JSON.stringify({ ok: true, data }),
  stderr: '',
});

describe('parseSophiaResult', () => {
  it('returns typed plan steps for valid Sophia output', () => {
    const steps: PlanStep[] = [
      {
        index: 1,
        description: 'Add parser coverage',
        acceptanceCriteria: ['valid JSON parses', 'malformed JSON fails'],
        artifacts: ['mcp-server/src/__tests__/sophia.test.ts'],
        dependsOn: [0],
      },
    ];

    const result = parseSophiaResult<PlanStep[]>(
      JSON.stringify({ ok: true, data: steps }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      index: 1,
      description: 'Add parser coverage',
      acceptanceCriteria: ['valid JSON parses', 'malformed JSON fails'],
      artifacts: ['mcp-server/src/__tests__/sophia.test.ts'],
      dependsOn: [0],
    });
  });

  it('returns an error for malformed JSON and Sophia error envelopes', () => {
    const malformed = parseSophiaResult<PlanStep[]>('{not json');
    expect(malformed.ok).toBe(false);
    if (malformed.ok) throw new Error('expected malformed parse to fail');
    expect(malformed.error).toContain('Invalid JSON');

    const rejected = parseSophiaResult<PlanStep[]>(
      JSON.stringify({ ok: false, error: { message: 'plan rejected' } }),
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('expected Sophia error envelope to fail');
    expect(rejected.error).toBe('sophia error: plan rejected');
  });

  it('treats an empty plan step array as a successful empty result', () => {
    const result = parseSophiaResult<PlanStep[]>(
      JSON.stringify({ ok: true, data: [] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toEqual([]);
  });
});

describe('SophiaResult', () => {
  it('preserves generic success and failure shapes', () => {
    const success: SophiaResult<{ taskIds: number[] }> = {
      ok: true,
      data: { taskIds: [101, 102] },
    };
    const failure: SophiaResult<{ taskIds: number[] }> = {
      ok: false,
      error: 'Sophia exec failed',
    };

    expect(success).toEqual({ ok: true, data: { taskIds: [101, 102] } });
    expect(failure).toEqual({ ok: false, error: 'Sophia exec failed' });
  });
});

describe('plan step interface', () => {
  it('creates Sophia tasks from typed plan steps and attaches task contracts', async () => {
    const exec = vi.fn(
      async (_cmd: string, args: string[], _opts?: { timeout?: number; cwd?: string; signal?: AbortSignal }) => {
        const joined = args.join(' ');
        if (joined.startsWith('cr add ')) {
          return sophiaOk({ cr: { id: 7, branch: 'sophia/cr-7', title: args[2] } });
        }
        if (joined.startsWith('cr contract set ')) {
          return sophiaOk({ saved: true });
        }
        if (joined.startsWith('cr task add ')) {
          return sophiaOk({ task: { id: 41, title: args[3] } });
        }
        if (joined.startsWith('cr task contract set ')) {
          return sophiaOk({ saved: true });
        }
        return sophiaOk();
      },
    );
    const steps: PlanStep[] = [
      {
        index: 2,
        description: 'Wire plan step contracts',
        acceptanceCriteria: ['task is created', 'contract captures acceptance criteria'],
        artifacts: ['mcp-server/src/sophia.ts', 'mcp-server/src/__tests__/sophia.test.ts'],
        dependsOn: [1],
      },
    ];

    const result = await createCRFromPlan(
      exec as ExecFn,
      '/repo',
      'Create Sophia task coverage',
      steps,
      ['use strict TypeScript'],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toBeDefined();
    const data = result.data!;
    expect(data.cr).toEqual({
      id: 7,
      branch: 'sophia/cr-7',
      title: 'Create Sophia task coverage',
    });
    expect([...data.taskIds.entries()]).toEqual([[2, 41]]);
    expect(exec).toHaveBeenCalledWith(
      'sophia',
      [
        'cr',
        'task',
        'contract',
        'set',
        '7',
        '41',
        '--intent',
        'Wire plan step contracts',
        '--acceptance',
        'task is created',
        '--acceptance',
        'contract captures acceptance criteria',
        '--scope',
        'mcp-server/src/sophia.ts',
        '--scope',
        'mcp-server/src/__tests__/sophia.test.ts',
      ],
      { timeout: 10000, cwd: '/repo' },
    );
  });
});
