/**
 * Chaos test: two draftPostmortem calls racing on the same session context.
 *
 * Invariants under test (determinism, I6):
 *   - Both Promise.all results resolve to valid PostmortemDraft objects.
 *   - Both drafts are byte-equal (same markdown, same warnings).
 *   - No throw from either invocation.
 *   - Each draft passes PostmortemDraftSchema.parse().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  draftPostmortem,
  type PostmortemSessionContext,
} from '../../episodic-memory.js';
import { PostmortemDraftSchema } from '../../types.js';

// ─── Mock agent-mail (same pattern as episodic-memory.postmortem.test.ts) ──

vi.mock('../../agent-mail.js', () => ({
  agentMailRPC: vi.fn(async (_exec: unknown, toolName: string) => {
    if (toolName === 'fetch_inbox') {
      return { ok: true, data: { messages: [] } };
    }
    return { ok: true, data: null };
  }),
  unwrapRPC: (r: unknown) => {
    if (r && typeof r === 'object' && 'ok' in r && (r as Record<string, unknown>)['ok'] === true) {
      return (r as Record<string, unknown>)['data'] ?? null;
    }
    return null;
  },
}));

// ─── Exec mock helpers ────────────────────────────────────────

interface ExecScript {
  match: (cmd: string, args: string[]) => boolean;
  result: { code: number; stdout: string; stderr: string };
}

function makeExecFn(scripts: ExecScript[]): PostmortemSessionContext['exec'] {
  const fn = vi.fn(async (cmd: string, args: string[]) => {
    for (const s of scripts) {
      if (s.match(cmd, args)) return s.result;
    }
    return { code: 1, stdout: '', stderr: 'not mocked' };
  });
  return fn as unknown as PostmortemSessionContext['exec'];
}

function gitCatFileSucceeds(sha: string): ExecScript {
  return {
    match: (cmd, args) =>
      cmd === 'git' && args[0] === 'cat-file' && args[1] === '-e' && args[2] === sha,
    result: { code: 0, stdout: '', stderr: '' },
  };
}

function gitLogEmpty(): ExecScript {
  return {
    match: (cmd, args) =>
      cmd === 'git' &&
      args[0] === 'log' &&
      args.some((a) => a.startsWith('--pretty=format:%h|%s|%an')),
    result: { code: 0, stdout: '', stderr: '' },
  };
}

// ─── Context factory ──────────────────────────────────────────

function makeCtx(
  partial: Partial<PostmortemSessionContext> & { exec: PostmortemSessionContext['exec'] },
): PostmortemSessionContext {
  return {
    cwd: '/fake/cwd',
    goal: 'Ship T13 chaos harness',
    phase: 'complete',
    ...partial,
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe('chaos/postmortem-concurrent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('two concurrent draftPostmortem calls both resolve, no throw', async () => {
    const exec = makeExecFn([
      gitCatFileSucceeds('abc123'),
      gitLogEmpty(),
    ]);
    const ctx = makeCtx({ exec, sessionStartSha: 'abc123' });

    let threw = false;
    let results: [Awaited<ReturnType<typeof draftPostmortem>>, Awaited<ReturnType<typeof draftPostmortem>>] | undefined;
    try {
      results = await Promise.all([draftPostmortem(ctx), draftPostmortem(ctx)]);
    } catch {
      threw = true;
    }

    expect(threw, 'draftPostmortem must never throw').toBe(false);
    expect(results).toBeDefined();
    expect(results![0]).toBeDefined();
    expect(results![1]).toBeDefined();
  });

  it('both drafts pass PostmortemDraftSchema.parse()', async () => {
    const exec = makeExecFn([
      gitCatFileSucceeds('def456'),
      gitLogEmpty(),
    ]);
    const ctx = makeCtx({ exec, sessionStartSha: 'def456' });

    const [d1, d2] = await Promise.all([draftPostmortem(ctx), draftPostmortem(ctx)]);

    expect(() => PostmortemDraftSchema.parse(d1)).not.toThrow();
    expect(() => PostmortemDraftSchema.parse(d2)).not.toThrow();
  });

  it('concurrent drafts are byte-equal (determinism invariant)', async () => {
    const exec = makeExecFn([
      gitCatFileSucceeds('ghi789'),
      gitLogEmpty(),
    ]);
    const ctx = makeCtx({ exec, sessionStartSha: 'ghi789' });

    const [d1, d2] = await Promise.all([draftPostmortem(ctx), draftPostmortem(ctx)]);

    // Both markdown outputs must be identical — determinism guarantee.
    expect(d1.markdown).toBe(d2.markdown);
    // Warnings must match.
    expect(d1.warnings).toEqual(d2.warnings);
  });

  it('four concurrent calls all resolve to valid drafts', async () => {
    const exec = makeExecFn([
      gitCatFileSucceeds('jkl000'),
      gitLogEmpty(),
    ]);
    const ctx = makeCtx({ exec, sessionStartSha: 'jkl000' });

    const drafts = await Promise.all([
      draftPostmortem(ctx),
      draftPostmortem(ctx),
      draftPostmortem(ctx),
      draftPostmortem(ctx),
    ]);

    for (const d of drafts) {
      expect(() => PostmortemDraftSchema.parse(d)).not.toThrow();
      expect(d.markdown).toBe(drafts[0]!.markdown);
    }
  });
});
