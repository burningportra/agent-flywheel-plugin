/**
 * Smoke tests for episodic-memory.ts public surface (bead claude-orchestrator-22dx).
 *
 * Deeper coverage lives in the sibling files:
 *   - episodic-memory.postmortem.test.ts (draftPostmortem, formatPostmortemMarkdown)
 *   - episodic-memory.solution-doc.test.ts (draftSolutionDoc)
 *   - refresh-learnings.test.ts (refreshLearnings end-to-end)
 *
 * This file pins the 5 happy-path invariants from the bead's acceptance
 * criteria so a future refactor that breaks them is caught at the canonical
 * test-file path the bead names.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../agent-mail.js', () => ({
  agentMailRPC: vi.fn(async () => ({ ok: true, data: { messages: [] } })),
  unwrapRPC: (r: { ok: boolean; data: unknown }) => (r?.ok ? r.data : null),
}));

import * as episodic from '../episodic-memory.js';
import type { ExecFn } from '../exec.js';
import { PostmortemDraftSchema } from '../types.js';
import { SolutionDocSchema } from '../solution-doc-schema.js';
import { refreshLearnings, type RefreshFs } from '../refresh-learnings.js';

const baseExecScript: ExecFn = vi.fn(async (cmd, args) => {
  // sessionStartSha existence probe → succeed; everything else empty.
  if (cmd === 'git' && args[0] === 'cat-file' && args[1] === '-e') {
    return { code: 0, stdout: '', stderr: '' };
  }
  return { code: 0, stdout: '', stderr: '' };
});

describe('mempalace detection', () => {
  it('detects mempalace presence (boolean result)', () => {
    episodic.resetMempalaceDetection();
    expect(typeof episodic.detectMempalace()).toBe('boolean');
  });

  it('searchEpisodic returns empty string when mempalace unavailable', () => {
    vi.spyOn(episodic, 'detectMempalace').mockReturnValue(false);
    expect(episodic.searchEpisodic('test')).toBe('');
  });

  it('getEpisodicStats returns a shape with available + drawerCount fields', () => {
    const stats = episodic.getEpisodicStats();
    expect(typeof stats.available).toBe('boolean');
    expect(typeof stats.drawerCount).toBe('number');
  });
});

describe('draftPostmortem (bead 22dx criterion 1+2)', () => {
  it('returns a Zod-valid PostmortemDraft when invoked with a healthy mocked exec', async () => {
    const draft = await episodic.draftPostmortem({
      cwd: '/tmp/repo',
      goal: 'add unit tests',
      phase: 'implementing',
      sessionStartSha: 'abc1234',
      exec: baseExecScript,
    });
    expect(() => PostmortemDraftSchema.parse(draft)).not.toThrow();
    expect(draft.version).toBe(1);
    expect(draft.goal).toBe('add unit tests');
    expect(typeof draft.markdown).toBe('string');
  });

  it('degrades gracefully (no throw) when cm/agent-mail are unavailable and no commits land', async () => {
    // Every git command returns non-zero / empty → empty session path.
    const brokenExec: ExecFn = vi.fn(async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'cat-file') {
        return { code: 1, stdout: '', stderr: 'fatal' };
      }
      return { code: 1, stdout: '', stderr: 'not available' };
    });
    const draft = await episodic.draftPostmortem({
      cwd: '/tmp/repo',
      goal: 'goal',
      phase: 'implementing',
      exec: brokenExec,
    });
    expect(draft.hasWarnings).toBe(true);
    expect(draft.warnings.length).toBeGreaterThan(0);
    expect(() => PostmortemDraftSchema.parse(draft)).not.toThrow();
  });
});

describe('draftSolutionDoc (bead 22dx criterion 3)', () => {
  it('returns a Zod-valid SolutionDoc with the supplied CASS entryId in frontmatter', async () => {
    const doc = await episodic.draftSolutionDoc({
      cwd: '/tmp/repo',
      goal: 'fix flaky test in worker pool',
      phase: 'implementing',
      sessionStartSha: 'abc1234',
      exec: baseExecScript,
      entryId: 'b-cass-12345',
    });
    expect(() => SolutionDocSchema.parse(doc)).not.toThrow();
    expect(doc.frontmatter.entry_id).toBe('b-cass-12345');
    expect(doc.path).toMatch(/^docs\/solutions\/[a-z0-9-]+\/[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.md$/);
    expect(typeof doc.body).toBe('string');
    expect(doc.body).toContain('b-cass-12345');
  });
});

describe('refreshLearnings (bead 22dx criterion 4+5)', () => {
  function makeFs(files: Record<string, string>): RefreshFs {
    return {
      async listMarkdown(_root: string) {
        return Object.keys(files);
      },
      async readFile(absPath: string) {
        // absPath comes in as `${root}/${rel}` — strip the root prefix when matching.
        for (const key of Object.keys(files)) {
          if (absPath.endsWith('/' + key) || absPath === key) return files[key];
        }
        throw new Error('not found: ' + absPath);
      },
    };
  }

  it('returns an empty decisions list when docs/solutions/ is empty', async () => {
    const fs = makeFs({});
    const report = await refreshLearnings('docs/solutions', fs);
    expect(report.decisions).toEqual([]);
    expect(report.unparseable).toEqual([]);
    expect(typeof report.elapsedMs).toBe('number');
  });

  it('classifies each parseable solution doc exactly once', async () => {
    // Synthesise two well-formed solution docs that match the path regex.
    const mk = (slug: string, entryId: string) => [
      '---',
      `entry_id: "${entryId}"`,
      'problem_type: "bug_fix"',
      'component: "x"',
      'tags: ["bug_fix"]',
      'applies_when: "test"',
      'created_at: "2026-01-01"',
      '---',
      '# body',
      slug,
    ].join('\n');

    const fs = makeFs({
      'bug-fix/foo-2026-01-01.md': mk('foo', 'b-1'),
      'bug-fix/bar-2026-01-02.md': mk('bar', 'b-2'),
    });
    const report = await refreshLearnings('docs/solutions', fs);
    // Each doc lands in either decisions or unparseable; never both.
    const decisionCount = report.decisions.reduce((n, d) => n + (d.docs?.length ?? 0), 0);
    expect(decisionCount + report.unparseable.length).toBe(2);
    // Every decision references at least one doc.
    for (const d of report.decisions) {
      expect(d.docs?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
