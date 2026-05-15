import { describe, it, expect } from 'vitest';
import type { Bead } from '../types.js';
import {
  countUncertaintySignals,
  detectSpaceViolations,
  extractBeadFiles,
  formatSpaceViolations,
} from '../space-detector.js';

function makeBead(description: string): Bead {
  return {
    id: 'test-bead',
    title: 'test',
    description,
    status: 'open',
    priority: 2,
  };
}

describe('extractBeadFiles', () => {
  it('returns empty for a bead with no description', () => {
    expect(extractBeadFiles({ ...makeBead(''), description: '' })).toEqual([]);
  });

  it('extracts files from a ### Files: section (comma list)', () => {
    const bead = makeBead('Some context\n\n### Files: src/foo.ts, src/bar.ts\n\nmore text');
    expect(extractBeadFiles(bead)).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('extracts files from a ### Files: bullet list', () => {
    const bead = makeBead('### Files:\n- src/a.ts\n- src/b.ts\n\n### Other');
    expect(extractBeadFiles(bead)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('picks up inline backtick file refs like `src/foo.ts`', () => {
    const bead = makeBead('We will modify `src/foo.ts` and `tests/bar.test.ts`.');
    expect(extractBeadFiles(bead)).toEqual(['src/foo.ts', 'tests/bar.test.ts']);
  });

  it('does not duplicate when same file appears in both Files: section and inline', () => {
    const bead = makeBead('### Files: src/foo.ts\n\nWe edit `src/foo.ts` here.');
    expect(extractBeadFiles(bead)).toEqual(['src/foo.ts']);
  });

  it('ignores non-file noise inside Files: section', () => {
    const bead = makeBead('### Files: src/foo.ts, just some prose without dot');
    expect(extractBeadFiles(bead)).toEqual(['src/foo.ts']);
  });
});

describe('countUncertaintySignals', () => {
  it('returns 0 for confident prose', () => {
    expect(countUncertaintySignals('Implementation lands cleanly with all tests green.')).toBe(0);
  });

  it('counts a single signal once', () => {
    expect(countUncertaintySignals('I think this is correct.')).toBe(1);
  });

  it('counts distinct patterns separately', () => {
    const text = 'I think we might need this. Not sure if it works. This is probably a workaround.';
    // patterns hit: "i think", "might need", "not sure if", "probably", "workaround" => 5
    expect(countUncertaintySignals(text)).toBe(5);
  });

  it('is case-insensitive', () => {
    expect(countUncertaintySignals('PROBABLY this is right.')).toBeGreaterThan(0);
  });

  it('does NOT double-count the same pattern across multiple matches', () => {
    // "probably" appearing twice still counts as one distinct pattern hit.
    expect(countUncertaintySignals('probably yes, probably no')).toBe(1);
  });
});

describe('detectSpaceViolations', () => {
  const summary = 'All clean.';
  const feedback = 'LGTM.';

  it('returns empty when the bead has no file list (cannot compare)', () => {
    const bead = makeBead('No files mentioned.');
    expect(detectSpaceViolations(bead, summary, feedback, ['src/foo.ts'])).toEqual([]);
  });

  it('returns empty when changed files match the bead file list exactly', () => {
    const bead = makeBead('### Files: src/foo.ts');
    expect(detectSpaceViolations(bead, summary, feedback, ['src/foo.ts'])).toEqual([]);
  });

  it('flags architecture_invention when many unexpected files modified', () => {
    const bead = makeBead('### Files: src/foo.ts');
    const changed = ['src/foo.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    const out = detectSpaceViolations(bead, summary, feedback, changed);
    const arch = out.find((v) => v.type === 'architecture_invention');
    expect(arch).toBeDefined();
    expect(['warning', 'critical']).toContain(arch!.severity);
    expect(arch!.evidence).toContain('files modified outside bead scope');
  });

  it('flags scope_creep when total files >> bead list', () => {
    const bead = makeBead('### Files: src/foo.ts');
    // 6 files, bead lists 1 → 6x expansion (>=5 absolute, >3x), critical.
    const changed = ['src/foo.ts', 'a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    const out = detectSpaceViolations(bead, summary, feedback, changed);
    const creep = out.find((v) => v.type === 'scope_creep');
    expect(creep).toBeDefined();
    expect(creep!.evidence).toMatch(/Bead lists 1 files but 6 were changed/);
    expect(creep!.severity).toBe('critical');
  });

  it('does NOT flag scope_creep when expansion is small (under threshold)', () => {
    const bead = makeBead('### Files: src/foo.ts');
    const changed = ['src/foo.ts', 'src/bar.ts']; // 2 files only, < 5 absolute
    const out = detectSpaceViolations(bead, summary, feedback, changed);
    expect(out.find((v) => v.type === 'scope_creep')).toBeUndefined();
  });

  it('flags uncertainty when summary/feedback contain >=3 hedging patterns', () => {
    const bead = makeBead('### Files: src/foo.ts');
    const hedgeSummary = 'I think this might need work. Not sure if it is right. Probably a workaround.';
    const out = detectSpaceViolations(bead, hedgeSummary, '', ['src/foo.ts']);
    const uncert = out.find((v) => v.type === 'uncertainty');
    expect(uncert).toBeDefined();
    expect(uncert!.evidence).toMatch(/uncertainty signals/);
  });

  it('marks uncertainty critical when 5+ signals present', () => {
    const bead = makeBead('### Files: src/foo.ts');
    const hedge =
      "I think this might need work. Not sure if it works. Probably a workaround. Maybe we should rethink. I'm not confident.";
    const out = detectSpaceViolations(bead, hedge, '', ['src/foo.ts']);
    const uncert = out.find((v) => v.type === 'uncertainty');
    expect(uncert).toBeDefined();
    expect(uncert!.severity).toBe('critical');
  });

  it('matches via basename fuzzy when changed path is prefixed differently', () => {
    const bead = makeBead('### Files: foo.ts');
    // 'src/foo.ts' basename matches bead's 'foo.ts' — should NOT count as unexpected.
    const changed = ['src/foo.ts'];
    const out = detectSpaceViolations(bead, summary, feedback, changed);
    expect(out.find((v) => v.type === 'architecture_invention')).toBeUndefined();
  });
});

describe('formatSpaceViolations', () => {
  it('returns empty string for no violations', () => {
    expect(formatSpaceViolations([])).toBe('');
  });

  it('renders a Space Violation header, type label, severity emoji, evidence, and suggestion', () => {
    const out = formatSpaceViolations([
      {
        type: 'scope_creep',
        severity: 'critical',
        evidence: 'evidence text',
        suggestion: 'do this',
      },
    ]);
    expect(out).toContain('Space Violation Detected');
    expect(out).toContain('Scope Creep');
    expect(out).toContain('evidence text');
    expect(out).toContain('do this');
    expect(out).toContain('🔴');
  });

  it('handles multiple violations cleanly', () => {
    const out = formatSpaceViolations([
      { type: 'architecture_invention', severity: 'warning', evidence: 'e1', suggestion: 's1' },
      { type: 'uncertainty', severity: 'info', evidence: 'e2', suggestion: 's2' },
    ]);
    expect(out).toContain('Architecture Invention');
    expect(out).toContain('Uncertainty Detected');
    expect(out).toContain('⚠️');
    expect(out).toContain('ℹ️');
  });
});
