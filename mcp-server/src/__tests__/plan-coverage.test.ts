import { describe, it, expect } from 'vitest';
import {
  parsePlanSections,
  planCoverageScoringPrompt,
  parsePlanCoverageResult,
  coverageFromKeywordAudit,
  formatPlanCoverage,
} from '../plan-coverage.js';
import type { Bead } from '../types.js';
import type { PlanToBeadAudit, PlanAuditSection } from '../beads.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: 'br-1',
    title: 'Test bead',
    description: 'A test bead description',
    status: 'open',
    priority: 1,
    type: 'task',
    labels: [],
    ...overrides,
  };
}

// ─── parsePlanSections ──────────────────────────────────────────

describe('parsePlanSections', () => {
  it('parses valid markdown into sections', () => {
    const plan = `
# Section 1
This is the body for section 1. It is long enough to be included.

## Section 2
Body for section 2. Also long enough to be included.

### Section 3
Short body.
`;
    const sections = parsePlanSections(plan);
    expect(sections).toHaveLength(2); // Section 3 is too short (< 20 chars)
    expect(sections[0].heading).toBe('Section 1');
    expect(sections[0].body).toContain('section 1');
    expect(sections[1].heading).toBe('Section 2');
    expect(sections[1].body).toContain('section 2');
  });

  it('filters out empty or trivial sections', () => {
    const plan = `
# Empty Section

# Short Section
Too short.
`;
    const sections = parsePlanSections(plan);
    expect(sections).toHaveLength(0);
  });

  it('handles plan with no headings', () => {
    const plan = 'Just some text without any headings.';
    const sections = parsePlanSections(plan);
    expect(sections).toHaveLength(0);
  });
});

// ─── planCoverageScoringPrompt ──────────────────────────────────

describe('planCoverageScoringPrompt', () => {
  it('generates a prompt with sections and beads', () => {
    const sections = [
      { heading: 'Setup', body: 'Install dependencies and configure tools for the project.' },
    ];
    const beads = [
      makeBead({ id: 'br-1', title: 'Install deps', description: 'Run npm install' }),
    ];
    const prompt = planCoverageScoringPrompt(sections, beads);
    expect(prompt).toContain('Plan-to-Bead Coverage Assessment');
    expect(prompt).toContain('Setup');
    expect(prompt).toContain('Install deps');
    expect(prompt).toContain('br-1');
  });
});

// ─── parsePlanCoverageResult ────────────────────────────────────

describe('parsePlanCoverageResult', () => {
  const sections = [
    { heading: 'Setup', body: 'Install dependencies and configure tools.' },
    { heading: 'Implementation', body: 'Build the core logic and components.' },
  ];

  it('parses valid LLM output', () => {
    const output = JSON.stringify([
      { heading: 'Setup', score: 100, matchedBeadIds: ['br-1'], gap: '' },
      { heading: 'Implementation', score: 40, matchedBeadIds: [], gap: 'Missing components' },
    ]);
    const result = parsePlanCoverageResult(output, sections);
    expect(result.overall).toBe(70);
    expect(result.totalSections).toBe(2);
    expect(result.coveredSections).toBe(1);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].heading).toBe('Implementation');
  });

  it('handles fuzzy matching for headings', () => {
    const output = JSON.stringify([
      { heading: 'setup', score: 90, matchedBeadIds: ['br-1'] },
      { heading: 'Core Implementation', score: 10, matchedBeadIds: [] },
    ]);
    const result = parsePlanCoverageResult(output, sections);
    expect(result.sections[0].score).toBe(90); // matched 'Setup' to 'setup'
    expect(result.sections[1].score).toBe(10); // 'Core Implementation' includes 'Implementation'
  });

  it('handles fuzzy matching (reversed)', () => {
    const output = JSON.stringify([
      { heading: 'Implementation Details', score: 80, matchedBeadIds: ['br-2'] },
    ]);
    const result = parsePlanCoverageResult(output, [sections[1]]);
    expect(result.sections[0].score).toBe(80);
  });

  it('returns "no data" result for invalid output', () => {
    const result = parsePlanCoverageResult('invalid json', sections);
    expect(result.overall).toBe(0);
    expect(result.coveredSections).toBe(0);
    expect(result.gaps).toHaveLength(2);
  });
});

// ─── coverageFromKeywordAudit ───────────────────────────────────

describe('coverageFromKeywordAudit', () => {
  it('converts PlanToBeadAudit to PlanCoverageResult', () => {
    const apiSection: PlanAuditSection = {
      heading: 'API',
      summary: 'Build REST endpoints',
      matches: [],
    };
    const audit: PlanToBeadAudit = {
      sections: [
        {
          heading: 'Database',
          summary: 'Setup postgres',
          matches: [{ beadId: 'br-1', title: 'DB Task', score: 0.8 }],
        },
        apiSection,
      ],
      uncoveredSections: [apiSection],
      weakMappings: [],
    };
    const result = coverageFromKeywordAudit(audit);
    expect(result.overall).toBe(40); // (80 + 0) / 2
    expect(result.totalSections).toBe(2);
    expect(result.coveredSections).toBe(1);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].heading).toBe('API');
  });
});

// ─── formatPlanCoverage ─────────────────────────────────────────

describe('formatPlanCoverage', () => {
  it('formats full coverage correctly', () => {
    const result = {
      overall: 100,
      sections: [],
      gaps: [],
      totalSections: 5,
      coveredSections: 5,
    };
    const formatted = formatPlanCoverage(result);
    expect(formatted).toContain('Plan Coverage: 100%');
    expect(formatted).toContain('✅');
    expect(formatted).toContain('5/5 sections');
  });

  it('formats partial coverage with gaps', () => {
    const result = {
      overall: 45,
      sections: [],
      gaps: [
        { heading: 'Auth', preview: 'Implement login', score: 10, matchedBeadIds: [], uncovered: true },
      ],
      totalSections: 2,
      coveredSections: 1,
    };
    const formatted = formatPlanCoverage(result);
    expect(formatted).toContain('Plan Coverage: 45%');
    expect(formatted).toContain('⛔');
    expect(formatted).toContain('Gaps (1):');
    expect(formatted).toContain('Auth');
  });

  it('returns empty string for zero sections', () => {
    const result = {
      overall: 0,
      sections: [],
      gaps: [],
      totalSections: 0,
      coveredSections: 0,
    };
    expect(formatPlanCoverage(result)).toBe('');
  });
});
