/**
 * Tests for draftSolutionDoc (bead 71x).
 *
 * Invariants under test:
 *   S-1: degraded inputs (empty session) still yield a Zod-valid SolutionDoc
 *   S-2: frontmatter.entry_id is always populated from ctx.entryId
 *   S-3: path matches docs/solutions/<category>/<slug>-YYYY-MM-DD.md
 *   S-4: body re-uses post-mortem markdown
 *   reconciliation: entry_id flows through to rendered frontmatter
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  draftSolutionDoc,
  draftPostmortem,
  type PostmortemSessionContext,
} from '../episodic-memory.js';
import {
  SolutionDocSchema,
  renderSolutionDoc,
  inferSolutionCategory,
} from '../solution-doc-schema.js';

// ─── Mock agent-mail ───────────────────────────────────────────

vi.mock('../agent-mail.js', () => ({
  agentMailRPC: vi.fn(async () => ({ ok: true, data: { messages: [] } })),
  unwrapRPC: (r: any) => (r?.ok ? r.data : null),
}));

// ─── Exec mock helpers (mirror postmortem suite) ──────────────

interface ExecScript {
  match: (cmd: string, args: string[]) => boolean;
  result: { code: number; stdout: string; stderr: string };
}

function makeExec(scripts: ExecScript[]) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec = vi.fn(async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    for (const s of scripts) if (s.match(cmd, args)) return s.result;
    return { code: 1, stdout: '', stderr: 'not mocked' };
  });
  return { exec: exec as unknown as PostmortemSessionContext['exec'], calls };
}

function gitCatFileSucceeds(sha: string): ExecScript {
  return {
    match: (cmd, args) => cmd === 'git' && args[0] === 'cat-file' && args[2] === sha,
    result: { code: 0, stdout: '', stderr: '' },
  };
}

function gitLogCommits(range: string, subjects: Array<{ sha: string; subject: string }>): ExecScript {
  return {
    match: (cmd, args) => {
      if (cmd !== 'git' || args[0] !== 'log') return false;
      if (args[1] !== range) return false;
      return args.some((a) => a.startsWith('--pretty=format:%h|%s|%an'));
    },
    result: {
      code: 0,
      stdout: subjects.map((s) => `${s.sha}|${s.subject}|tester`).join('\n'),
      stderr: '',
    },
  };
}

function gitLogStat(files: Array<{ path: string; changes: number }>): ExecScript {
  return {
    match: (cmd, args) => cmd === 'git' && args[0] === 'log' && args.includes('--stat'),
    result: {
      code: 0,
      stdout: files.map((f) => ` ${f.path} | ${f.changes} +++--`).join('\n'),
      stderr: '',
    },
  };
}

function gitLogEmpty(): ExecScript {
  return {
    match: (cmd, args) =>
      cmd === 'git' && args[0] === 'log' && args.some((a) => a.startsWith('--pretty=format:%h|%s|%an')),
    result: { code: 0, stdout: '', stderr: '' },
  };
}

function makeCtx(partial: Partial<PostmortemSessionContext> & { exec: PostmortemSessionContext['exec'] }): PostmortemSessionContext {
  return {
    cwd: '/fake/cwd',
    goal: 'fix flaky test in CI',
    phase: 'complete',
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────

describe('draftSolutionDoc', () => {
  it('S-1 + S-2 + S-3: empty session still yields Zod-valid SolutionDoc with entry_id and conformant path', async () => {
    const { exec } = makeExec([
      gitCatFileSucceeds('abc123'),
      gitLogEmpty(),
    ]);

    const doc = await draftSolutionDoc({
      ...makeCtx({ exec, sessionStartSha: 'abc123' }),
      entryId: 'cass-empty-1',
    });

    expect(doc.frontmatter.entry_id).toBe('cass-empty-1');
    // Path regex enforced by SolutionDocSchema
    expect(doc.path).toMatch(/^docs\/solutions\/[a-z0-9-]+\/[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.md$/);
    // empty_session signal makes it into problem_type
    expect(doc.frontmatter.problem_type).toBe('empty_session');
    expect(() => SolutionDocSchema.parse(doc)).not.toThrow();
  });

  it('happy path: commits + flaky-test goal → category=test, problem_type=flaky_test', async () => {
    const { exec } = makeExec([
      gitCatFileSucceeds('abc'),
      gitLogCommits('abc..HEAD', [
        { sha: 'c1', subject: 'fix: flaky retry logic' },
      ]),
      gitLogStat([{ path: 'src/__tests__/retry.test.ts', changes: 12 }]),
    ]);

    const doc = await draftSolutionDoc({
      ...makeCtx({ exec, sessionStartSha: 'abc' }),
      entryId: 'cass-flaky-1',
    });

    expect(doc.path.startsWith('docs/solutions/test/')).toBe(true);
    expect(doc.frontmatter.problem_type).toBe('flaky_test');
    expect(doc.frontmatter.component).toBe('retry.test'); // basename minus extension
    expect(doc.frontmatter.tags).toContain('test');
    expect(doc.frontmatter.tags).toContain('flaky_test');
    expect(doc.frontmatter.tags).toContain('phase:complete');
  });

  it('S-4: body re-uses the post-mortem markdown narrative', async () => {
    const { exec } = makeExec([
      gitCatFileSucceeds('abc'),
      gitLogCommits('abc..HEAD', [{ sha: 'c1', subject: 'feat: add solution doc' }]),
      gitLogStat([{ path: 'src/episodic-memory.ts', changes: 50 }]),
    ]);

    const ctx = makeCtx({ exec, sessionStartSha: 'abc' });
    const pm = await draftPostmortem(ctx);
    const doc = await draftSolutionDoc({ ...ctx, entryId: 'cass-1', postmortem: pm });

    // Post-mortem heading + commit subject both present in body
    expect(doc.body).toContain('## What shipped');
    expect(doc.body).toContain('feat: add solution doc');
    // CASS provenance footer
    expect(doc.body).toContain('cass-1');
  });

  it('reconciliation: entry_id appears verbatim in renderSolutionDoc output', async () => {
    const { exec } = makeExec([
      gitCatFileSucceeds('abc'),
      gitLogCommits('abc..HEAD', [{ sha: 'c1', subject: 'chore: x' }]),
      gitLogStat([{ path: 'README.md', changes: 1 }]),
    ]);

    const doc = await draftSolutionDoc({
      ...makeCtx({ exec, sessionStartSha: 'abc' }),
      entryId: 'cass-7e3a-9f2b',
    });

    const rendered = renderSolutionDoc(doc);
    expect(rendered).toContain('entry_id: "cass-7e3a-9f2b"');
    // CASS footer in body
    expect(rendered).toContain('cass-7e3a-9f2b');
  });

  it('stale checkpoint warning routes to problem_type=stale_checkpoint', async () => {
    const { exec } = makeExec([
      // sha lookup fails
      {
        match: (cmd, args) =>
          cmd === 'git' && args[0] === 'cat-file' && args[2] === 'deadbeef',
        result: { code: 1, stdout: '', stderr: 'fatal' },
      },
      // merge-base also fails → HEAD~10..HEAD
      {
        match: (cmd, args) => cmd === 'git' && args[0] === 'merge-base',
        result: { code: 128, stdout: '', stderr: 'fatal' },
      },
      gitLogCommits('HEAD~10..HEAD', [{ sha: 'c1', subject: 'docs: x' }]),
      gitLogStat([{ path: 'README.md', changes: 1 }]),
    ]);

    const doc = await draftSolutionDoc({
      ...makeCtx({ exec, sessionStartSha: 'deadbeef' }),
      entryId: 'cass-stale-1',
    });

    expect(doc.frontmatter.problem_type).toBe('stale_checkpoint');
    expect(doc.frontmatter.applies_when).toContain('postmortem_checkpoint_stale');
  });

  it('category inference: README-only edit with docs goal → category=docs', () => {
    const cat = inferSolutionCategory('update readme with new flag', ['README.md']);
    expect(cat).toBe('docs');
  });
});
