import { describe, it, expect } from 'vitest';
import {
  isValidBeadId,
  findNonStandardIds,
  auditPlanToBeads,
  extractArtifacts,
  getBeadsSummary,
} from '../beads.js';
import type { Bead } from '../types.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: 'test-1',
    title: 'Test bead',
    description: 'A test bead description',
    status: 'open',
    priority: 1,
    type: 'task',
    labels: [],
    ...overrides,
  };
}

// ─── isValidBeadId ──────────────────────────────────────────────

describe('isValidBeadId', () => {
  // Regex: /^[a-z][a-z0-9]*-\d+$/
  it.each([
    ['abc-123', true],
    ['z9g-0', true],
    ['br-42', true],
    ['a-1', true],
    ['ab3c-999', true],
  ])('valid ID "%s" -> %s', (id, expected) => {
    expect(isValidBeadId(id)).toBe(expected);
  });

  it.each([
    ['agent-flywheel-1ru', false],  // multi-hyphen, last segment not all digits
    ['123', false],                       // starts with digit
    ['BD-123', false],                    // uppercase
    ['', false],                          // empty
    ['abc', false],                       // no hyphen-digits
    ['-123', false],                      // starts with hyphen
    ['abc-', false],                      // no digits after hyphen
    ['ABC-123', false],                   // all uppercase prefix
  ])('invalid ID "%s" -> %s', (id, expected) => {
    expect(isValidBeadId(id)).toBe(expected);
  });
});

// ─── findNonStandardIds ─────────────────────────────────────────

describe('findNonStandardIds', () => {
  it('returns empty for all valid IDs', () => {
    const beads = [makeBead({ id: 'br-1' }), makeBead({ id: 'abc-42' })];
    expect(findNonStandardIds(beads)).toEqual([]);
  });

  it('filters non-standard IDs from mixed list', () => {
    const beads = [
      makeBead({ id: 'br-1' }),
      makeBead({ id: 'INVALID' }),
      makeBead({ id: 'abc-42' }),
      makeBead({ id: '' }),
    ];
    expect(findNonStandardIds(beads)).toEqual(['INVALID', '']);
  });

  it('returns empty for empty array', () => {
    expect(findNonStandardIds([])).toEqual([]);
  });
});

// ─── auditPlanToBeads ───────────────────────────────────────────

describe('auditPlanToBeads', () => {
  it('returns empty sections for empty plan', () => {
    const result = auditPlanToBeads('', []);
    expect(result.sections).toEqual([]);
    expect(result.uncoveredSections).toEqual([]);
    expect(result.weakMappings).toEqual([]);
  });

  it('returns empty sections for whitespace-only plan', () => {
    const result = auditPlanToBeads('   \n  ', []);
    expect(result.sections).toEqual([]);
  });

  it('parses plan with headings into sections', () => {
    const plan = `# Setup\nInstall dependencies and configure\n\n# Implementation\nBuild the feature`;
    const beads = [makeBead({ id: 'br-1', title: 'Setup task', description: 'Install dependencies and configure tools' })];
    const result = auditPlanToBeads(plan, beads);
    expect(result.sections.length).toBeGreaterThan(0);
    expect(result.sections.some(s => s.heading === 'Setup')).toBe(true);
  });

  it('scores token matches > 0 for matching beads', () => {
    const plan = `# Database Migration\nAdd migration scripts for the database schema changes`;
    const beads = [
      makeBead({
        id: 'br-1',
        title: 'Database migration scripts',
        description: 'Create migration scripts for database schema changes',
      }),
    ];
    const result = auditPlanToBeads(plan, beads);
    const dbSection = result.sections.find(s => s.heading === 'Database Migration');
    expect(dbSection).toBeDefined();
    expect(dbSection!.matches.length).toBeGreaterThan(0);
    expect(dbSection!.matches[0].score).toBeGreaterThan(0);
  });

  it('reports uncoveredSections when no bead matches', () => {
    const plan = `# Frontend\nBuild React components for dashboard\n\n# Backend\nImplement API endpoints`;
    const result = auditPlanToBeads(plan, []);
    expect(result.uncoveredSections.length).toBe(result.sections.length);
  });

  it('reports weakMappings when best score < 0.35', () => {
    const plan = `# Performance Optimization\nProfile and optimize database query performance bottlenecks`;
    const beads = [
      makeBead({
        id: 'br-1',
        title: 'Fix typo',
        description: 'Fix a typo in the readme file',
      }),
    ];
    const result = auditPlanToBeads(plan, beads);
    const perfSection = result.sections.find(s => s.heading === 'Performance Optimization');
    if (perfSection && perfSection.matches.length > 0) {
      expect(result.weakMappings.length).toBeGreaterThan(0);
    }
  });
});

// ─── extractArtifacts ───────────────────────────────────────────

describe('extractArtifacts', () => {
  it('extracts paths from ### Files: section', () => {
    const bead = makeBead({
      description: `Some intro text\n### Files:\n  config/settings.yaml\n  app/main.py\n\n### Other section`,
    });
    const artifacts = extractArtifacts(bead);
    expect(artifacts).toContain('config/settings.yaml');
    expect(artifacts).toContain('app/main.py');
  });

  it('extracts bullet file paths (- src/foo.ts)', () => {
    const bead = makeBead({
      description: `Overview\n- src/foo.ts\n- src/bar.ts\n- lib/utils.js`,
    });
    const artifacts = extractArtifacts(bead);
    expect(artifacts).toContain('src/foo.ts');
    expect(artifacts).toContain('src/bar.ts');
    expect(artifacts).toContain('lib/utils.js');
  });

  it('extracts paths from both bullet lines and ### Files: section', () => {
    const bead = makeBead({
      description: `- src/a.ts\n### Files:\n  docs/readme.md`,
    });
    const artifacts = extractArtifacts(bead);
    expect(artifacts).toContain('src/a.ts');
    expect(artifacts).toContain('docs/readme.md');
  });

  it('returns empty array for empty description', () => {
    const bead = makeBead({ description: '' });
    expect(extractArtifacts(bead)).toEqual([]);
  });

  it('returns empty array for description with no file paths', () => {
    const bead = makeBead({ description: 'Just some text without any file references.' });
    expect(extractArtifacts(bead)).toEqual([]);
  });

  it('does not duplicate paths found in both bullet and ### Files:', () => {
    const bead = makeBead({
      description: `- src/foo.ts\n### Files:\n  src/foo.ts`,
    });
    const artifacts = extractArtifacts(bead);
    const fooCount = artifacts.filter(p => p === 'src/foo.ts').length;
    expect(fooCount).toBe(1);
  });
});

// ─── getBeadsSummary ────────────────────────────────────────────

describe('getBeadsSummary', () => {
  it('returns "no beads tracked" for empty array', () => {
    expect(getBeadsSummary([])).toBe('no beads tracked');
  });

  it('returns correct counts for mixed statuses', () => {
    const beads = [
      makeBead({ status: 'closed' }),
      makeBead({ status: 'closed' }),
      makeBead({ status: 'in_progress' }),
      makeBead({ status: 'open' }),
      makeBead({ status: 'deferred' }),
    ];
    const summary = getBeadsSummary(beads);
    expect(summary).toContain('2 closed');
    expect(summary).toContain('1 in-progress');
    expect(summary).toContain('1 open');
    expect(summary).toContain('1 deferred');
  });

  it('only includes statuses that have > 0 count', () => {
    const beads = [makeBead({ status: 'open' }), makeBead({ status: 'open' })];
    const summary = getBeadsSummary(beads);
    expect(summary).toBe('2 open');
    expect(summary).not.toContain('closed');
    expect(summary).not.toContain('in-progress');
    expect(summary).not.toContain('deferred');
  });

  it('handles all-closed beads', () => {
    const beads = [makeBead({ status: 'closed' }), makeBead({ status: 'closed' }), makeBead({ status: 'closed' })];
    expect(getBeadsSummary(beads)).toBe('3 closed');
  });
});
