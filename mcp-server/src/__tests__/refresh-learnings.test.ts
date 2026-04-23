/**
 * Tests for the compound-engineering refresh sweep (bead `bve`).
 *
 * Invariants under test:
 *   R-1: Delete is NEVER emitted without staleProbe AND a high stale score.
 *   R-2: scoreOverlap is symmetric (a,b) === (b,a).
 *   R-3: refreshLearnings does NOT mutate input docs (we don't even hand it
 *        any — but classifyGroup re-uses the input array; we assert).
 *   R-4: Replace requires staleProbe AND consolidate-level overlap.
 *   parser: round-trips a renderSolutionDoc-shaped string.
 *   archive directory paths are skipped during the sweep.
 *   unparseable docs surface in `unparseable[]` and never abort the sweep.
 */

import { describe, it, expect } from 'vitest';
import {
  parseSolutionDocMarkdown,
  scoreOverlap,
  groupSolutionDocs,
  classifyGroup,
  refreshLearnings,
  type RefreshFs,
} from '../refresh-learnings.js';
import {
  renderSolutionDoc,
  type SolutionDoc,
} from '../solution-doc-schema.js';

// ─── Helpers ───────────────────────────────────────────────────

function makeDoc(overrides: Partial<SolutionDoc['frontmatter']> & {
  path?: string;
  body?: string;
}): SolutionDoc {
  const {
    path = 'docs/solutions/test/sample-2026-04-23.md',
    body = '## What shipped\n\nFixed it.',
    ...fm
  } = overrides;
  return {
    path,
    frontmatter: {
      entry_id: 'cass-1',
      problem_type: 'flaky_test',
      component: 'retry',
      tags: ['test'],
      applies_when: 'on CI flake',
      created_at: '2026-04-23',
      ...fm,
    },
    body,
  };
}

const DEFAULT_OPTS = {
  consolidateThreshold: 0.75,
  replaceThreshold: 0.85,
  deleteThreshold: 0.9,
};

// ─── Frontmatter parser ────────────────────────────────────────

describe('parseSolutionDocMarkdown', () => {
  it('round-trips a renderSolutionDoc-shaped string', () => {
    const original = makeDoc({});
    const rendered = renderSolutionDoc(original);
    const parsed = parseSolutionDocMarkdown(rendered);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.entry_id).toBe(original.frontmatter.entry_id);
    expect(parsed!.frontmatter.problem_type).toBe(original.frontmatter.problem_type);
    expect(parsed!.frontmatter.component).toBe(original.frontmatter.component);
    expect(parsed!.frontmatter.tags).toEqual(original.frontmatter.tags);
    expect(parsed!.frontmatter.applies_when).toBe(original.frontmatter.applies_when);
    expect(parsed!.frontmatter.created_at).toBe(original.frontmatter.created_at);
    expect(parsed!.body.trim()).toContain('Fixed it.');
  });

  it('handles colons in JSON-quoted strings', () => {
    const doc = makeDoc({ applies_when: 'mode: aggressive, retries: 3' });
    const parsed = parseSolutionDocMarkdown(renderSolutionDoc(doc));
    expect(parsed?.frontmatter.applies_when).toBe('mode: aggressive, retries: 3');
  });

  it('returns null on missing frontmatter fence', () => {
    expect(parseSolutionDocMarkdown('# no frontmatter')).toBeNull();
  });

  it('returns null when entry_id is empty (schema gates)', () => {
    const broken = `---
entry_id: ""
problem_type: "x"
component: "y"
tags: []
applies_when: ""
created_at: 2026-04-23
---
body
`;
    expect(parseSolutionDocMarkdown(broken)).toBeNull();
  });

  it('returns null on bad created_at format', () => {
    const broken = `---
entry_id: "cass-1"
problem_type: "x"
component: "y"
tags: []
applies_when: ""
created_at: 04/23/2026
---
body
`;
    expect(parseSolutionDocMarkdown(broken)).toBeNull();
  });

  it('accepts CRLF line endings', () => {
    const doc = makeDoc({});
    const rendered = renderSolutionDoc(doc).replace(/\n/g, '\r\n');
    const parsed = parseSolutionDocMarkdown(rendered);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.entry_id).toBe('cass-1');
  });
});

// ─── 5-vector scorer ───────────────────────────────────────────

describe('scoreOverlap', () => {
  it('R-2: symmetric — score(a,b) == score(b,a)', () => {
    const a = makeDoc({
      problem_type: 'flaky_test',
      body: '## What shipped\n\nFixed retry timing in src/retry.ts because of race condition.',
    });
    const b = makeDoc({
      problem_type: 'flaky_test',
      body: '## What shipped\n\nResolved retry race in src/retry.ts; root cause was timing.',
    });
    const ab = scoreOverlap(a, b);
    const ba = scoreOverlap(b, a);
    expect(ab.overall).toBeCloseTo(ba.overall, 10);
    expect(ab.problem).toBeCloseTo(ba.problem, 10);
    expect(ab.files).toBeCloseTo(ba.files, 10);
  });

  it('identical docs score 1.0 overall', () => {
    const a = makeDoc({
      body: '## Root cause\n\nbecause of timing in src/retry.ts. Fix: switch to fake timers.',
    });
    const score = scoreOverlap(a, a);
    expect(score.overall).toBeCloseTo(1.0, 5);
    expect(score.problem).toBe(1);
    expect(score.files).toBe(1);
  });

  it('orthogonal docs score low', () => {
    const a = makeDoc({
      problem_type: 'flaky_test',
      component: 'retry',
      body: 'Fix flaky retry test in src/retry.test.ts because of race.',
    });
    const b = makeDoc({
      problem_type: 'docs_rot',
      component: 'readme',
      body: 'Updated README.md to mention new flag.',
    });
    const score = scoreOverlap(a, b);
    expect(score.overall).toBeLessThan(0.3);
  });

  it('produces per-dimension scores in [0,1]', () => {
    const a = makeDoc({});
    const b = makeDoc({ body: 'completely different content with no shared tokens' });
    const score = scoreOverlap(a, b);
    for (const dim of ['problem', 'rootCause', 'solution', 'files', 'prevention', 'overall'] as const) {
      expect(score[dim]).toBeGreaterThanOrEqual(0);
      expect(score[dim]).toBeLessThanOrEqual(1);
    }
  });
});

// ─── Grouping ──────────────────────────────────────────────────

describe('groupSolutionDocs', () => {
  it('groups by (problem_type, component)', () => {
    const docs = [
      makeDoc({ problem_type: 'flaky_test', component: 'retry' }),
      makeDoc({ problem_type: 'flaky_test', component: 'retry', path: 'docs/solutions/test/sample2-2026-04-23.md' }),
      makeDoc({ problem_type: 'docs_rot', component: 'readme', path: 'docs/solutions/docs/r-2026-04-23.md' }),
    ];
    const groups = groupSolutionDocs(docs);
    expect(groups).toHaveLength(2);
    const flakyGroup = groups.find((g) => g[0].frontmatter.problem_type === 'flaky_test');
    expect(flakyGroup).toHaveLength(2);
  });

  it('returns empty array on empty input', () => {
    expect(groupSolutionDocs([])).toEqual([]);
  });
});

// ─── Classification ────────────────────────────────────────────

describe('classifyGroup', () => {
  it('singleton with no probe → Keep', async () => {
    const decision = await classifyGroup([makeDoc({})], DEFAULT_OPTS);
    expect(decision.classification).toBe('Keep');
    expect(decision.archiveCandidates).toEqual([]);
  });

  it('R-1: singleton + high stale → Delete only when staleProbe present', async () => {
    const doc = makeDoc({});
    const noProbe = await classifyGroup([doc], DEFAULT_OPTS);
    expect(noProbe.classification).toBe('Keep');

    const withProbe = await classifyGroup([doc], {
      ...DEFAULT_OPTS,
      staleProbe: async () => 0.95,
    });
    expect(withProbe.classification).toBe('Delete');
    expect(withProbe.archiveCandidates).toEqual([doc.path]);
  });

  it('singleton + low stale → Keep even with probe present', async () => {
    const doc = makeDoc({});
    const decision = await classifyGroup([doc], {
      ...DEFAULT_OPTS,
      staleProbe: async () => 0.1,
    });
    expect(decision.classification).toBe('Keep');
  });

  it('high-overlap pair → Consolidate (no stale required)', async () => {
    const sharedBody = `
## Root cause
because of timing in src/retry.ts and tests in src/__tests__/retry.test.ts.

## What shipped
Fix: switched retry to fake timers; resolved race condition.

## Prevention
Going forward, prefer fake timers in retry tests to avoid flakes.
`;
    const a = makeDoc({ body: sharedBody, created_at: '2026-04-20', path: 'docs/solutions/test/a-2026-04-20.md' });
    const b = makeDoc({ body: sharedBody, created_at: '2026-04-23', path: 'docs/solutions/test/b-2026-04-23.md' });

    const decision = await classifyGroup([a, b], DEFAULT_OPTS);
    expect(decision.classification).toBe('Consolidate');
    expect(decision.primary).toBe(1); // newer
    expect(decision.archiveCandidates).toEqual([a.path]);
  });

  it('R-4: Replace requires staleProbe AND high overlap AND non-primary stale', async () => {
    const sharedBody = 'Fixed retry timing in src/old-retry.ts because of race condition. Going forward use fake timers.';
    const a = makeDoc({ body: sharedBody, created_at: '2026-04-20', path: 'docs/solutions/test/a-2026-04-20.md' });
    const b = makeDoc({ body: sharedBody, created_at: '2026-04-23', path: 'docs/solutions/test/b-2026-04-23.md' });

    // Without probe → falls back to Consolidate.
    const noProbe = await classifyGroup([a, b], DEFAULT_OPTS);
    expect(noProbe.classification).toBe('Consolidate');

    // With probe marking the older doc stale → Replace.
    const withProbe = await classifyGroup([a, b], {
      ...DEFAULT_OPTS,
      staleProbe: async (d) => (d.path === a.path ? 0.95 : 0.0),
    });
    expect(withProbe.classification).toBe('Replace');
    expect(withProbe.archiveCandidates).toEqual([a.path]);
    expect(withProbe.primary).toBe(1);
  });

  it('related but low-overlap group → Update', async () => {
    const a = makeDoc({
      body: 'Completely about timing and clocks.',
      created_at: '2026-04-20',
      path: 'docs/solutions/test/a-2026-04-20.md',
    });
    const b = makeDoc({
      body: 'Totally orthogonal content about networking and tcp sockets.',
      created_at: '2026-04-23',
      path: 'docs/solutions/test/b-2026-04-23.md',
    });
    const decision = await classifyGroup([a, b], DEFAULT_OPTS);
    expect(decision.classification).toBe('Update');
    expect(decision.archiveCandidates).toEqual([]);
  });

  it('R-3: does NOT mutate the input docs array', async () => {
    const docs = [makeDoc({})];
    const snapshot = JSON.stringify(docs);
    await classifyGroup(docs, DEFAULT_OPTS);
    expect(JSON.stringify(docs)).toBe(snapshot);
  });
});

// ─── End-to-end refreshLearnings ───────────────────────────────

describe('refreshLearnings', () => {
  function makeFs(files: Record<string, string>): RefreshFs {
    return {
      listMarkdown: async () => Object.keys(files),
      readFile: async (abs: string) => {
        // abs comes back as `${root}/${rel}` — strip the root.
        for (const rel of Object.keys(files)) {
          if (abs.endsWith('/' + rel)) return files[rel];
        }
        throw new Error(`no such file: ${abs}`);
      },
    };
  }

  it('classifies a corpus end-to-end and returns a report', async () => {
    const docA = makeDoc({
      body: 'Root cause: timing in src/retry.ts. Fix: fake timers. Prevention: fake timers.',
      created_at: '2026-04-20',
      path: 'docs/solutions/test/a-2026-04-20.md',
    });
    const docB = makeDoc({
      body: 'Root cause: timing in src/retry.ts. Fix: fake timers. Prevention: fake timers.',
      created_at: '2026-04-23',
      path: 'docs/solutions/test/b-2026-04-23.md',
    });
    const docC = makeDoc({
      problem_type: 'docs_rot',
      component: 'readme',
      body: 'Updated README.md.',
      created_at: '2026-04-23',
      path: 'docs/solutions/docs/c-2026-04-23.md',
    });

    const fs = makeFs({
      'test/a-2026-04-20.md': renderSolutionDoc(docA),
      'test/b-2026-04-23.md': renderSolutionDoc(docB),
      'docs/c-2026-04-23.md': renderSolutionDoc(docC),
    });

    const report = await refreshLearnings('docs/solutions', fs);
    expect(report.decisions).toHaveLength(2);
    const consolidate = report.decisions.find((d) => d.classification === 'Consolidate');
    const keep = report.decisions.find((d) => d.classification === 'Keep');
    expect(consolidate).toBeDefined();
    expect(keep).toBeDefined();
    expect(report.unparseable).toEqual([]);
  });

  it('skips _archive/ entries during the sweep', async () => {
    const archived = makeDoc({ path: 'docs/solutions/_archive/x-2026-04-20.md' });
    const fs = makeFs({
      '_archive/x-2026-04-20.md': renderSolutionDoc(archived),
    });
    const report = await refreshLearnings('docs/solutions', fs);
    expect(report.decisions).toEqual([]);
  });

  it('surfaces unparseable docs without aborting', async () => {
    const fs = makeFs({
      'test/good-2026-04-23.md': renderSolutionDoc(makeDoc({})),
      'test/bad-2026-04-23.md': '# not frontmatter',
    });
    const report = await refreshLearnings('docs/solutions', fs);
    expect(report.unparseable).toHaveLength(1);
    expect(report.unparseable[0].path).toBe('test/bad-2026-04-23.md');
    expect(report.decisions).toHaveLength(1); // good doc still classified
  });

  it('R-1 + R-4: Delete + Replace never appear without staleProbe', async () => {
    const sharedBody = 'Root cause: timing. Fix: fake timers. Prevention: fake timers.';
    const docA = makeDoc({
      body: sharedBody,
      created_at: '2026-04-20',
      path: 'docs/solutions/test/a-2026-04-20.md',
    });
    const docB = makeDoc({
      body: sharedBody,
      created_at: '2026-04-23',
      path: 'docs/solutions/test/b-2026-04-23.md',
    });
    const fs = makeFs({
      'test/a-2026-04-20.md': renderSolutionDoc(docA),
      'test/b-2026-04-23.md': renderSolutionDoc(docB),
    });
    const report = await refreshLearnings('docs/solutions', fs);
    for (const d of report.decisions) {
      expect(d.classification).not.toBe('Delete');
      expect(d.classification).not.toBe('Replace');
    }
  });

  it('records elapsedMs and treats malformed paths as unparseable', async () => {
    const doc = makeDoc({ path: 'docs/solutions/test/x-2026-04-23.md' });
    const fs = makeFs({
      'BAD_PATH.md': renderSolutionDoc(doc), // root-level — no category dir
      'test/x-2026-04-23.md': renderSolutionDoc(doc),
    });
    const report = await refreshLearnings('docs/solutions', fs);
    expect(report.unparseable.find((u) => u.path === 'BAD_PATH.md')).toBeDefined();
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
