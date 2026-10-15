import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseDuelReport,
  resolveDuelProvenanceInstructions,
} from '../duel-provenance.js';
import type { CandidateIdea } from '../types.js';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('parseDuelReport', () => {
  it('parses report metadata, score-matrix values, critiques, steelman text, and contested state', () => {
    const report = parseDuelReport(fixture('duel-report-valid.md'));

    expect(report).toEqual({
      mode: 'architecture',
      runAt: '2026-10-15T14:22:00Z',
      decisions: [
        {
          title: 'Durable provenance',
          agentScores: { cc: 'self', cod: 920, gmi: 860 },
          survivingCritique: 'The embedded ```json block can close a fixed-width prompt fence.',
          steelman: 'Derive provenance from the report at bead-creation time instead of copying it into checkpoint state.',
          contested: false,
        },
        {
          title: 'Shared cache',
          agentScores: { cc: 900, cod: 510, gmi: 'n/a' },
          survivingCritique: 'Cache invalidation still has no single owner.',
          contested: true,
        },
      ],
    });
  });

  it('returns an empty decision list for an unrecognized report without throwing', () => {
    expect(parseDuelReport(fixture('duel-report-malformed.md'))).toEqual({ decisions: [] });
  });
});

describe('resolveDuelProvenanceInstructions', () => {
  it('renders parsed report values in a fence longer than embedded backtick runs', () => {
    const instructions = resolveDuelProvenanceInstructions(
      { planSource: 'duel', selectedGoal: 'Durable provenance', candidateIdeas: [] },
      {
        path: 'docs/plans/2026-10-15-durable-provenance-duel.md',
        content: fixture('duel-report-valid.md'),
      },
    );

    expect(instructions).toContain('````markdown\n## Provenance');
    expect(instructions).toContain('- **Agent scores:** cc=self, cod=920, gmi=860');
    expect(instructions).toContain('- **Contested:** false');
  });

  it.each([
    'DUELING_WIZARDS_REPORT.md',
    'docs/plans/2026-10-15-durable-provenance-duel.md',
    'docs/duels/planning-durable-provenance-2026-10-15.md',
  ])('uses parsed values when the active duel report is at %s', path => {
    const instructions = resolveDuelProvenanceInstructions(
      { planSource: 'duel', selectedGoal: 'Durable provenance', candidateIdeas: [] },
      { path, content: fixture('duel-report-valid.md') },
    );

    expect(instructions).toContain('- **Agent scores:** cc=self, cod=920, gmi=860');
    expect(instructions).toContain(`Read missing provenance values from \`${path}\``);
  });

  it('renders placeholders and the report path when a duel report is malformed', () => {
    const instructions = resolveDuelProvenanceInstructions(
      { planSource: 'duel', selectedGoal: 'Durable provenance', candidateIdeas: [] },
      {
        path: 'DUELING_WIZARDS_REPORT.md',
        content: fixture('duel-report-malformed.md'),
      },
    );

    expect(instructions).toContain('- **Agent scores:** cc=<0-1000 or n/a>, cod=<0-1000 or n/a>, gmi=<0-1000 or n/a>');
    expect(instructions).toContain('Read missing provenance values from `DUELING_WIZARDS_REPORT.md`');
    expect(instructions).toContain('Never invent scores.');
  });

  it('uses the selected discovery idea provenance for direct-to-beads prompts', () => {
    const selectedIdea: CandidateIdea = {
      id: 'durable-provenance',
      title: 'Durable provenance',
      description: 'Carry duel evidence into implementation.',
      category: 'reliability',
      effort: 'medium',
      impact: 'high',
      rationale: 'Reviewers need the adversarial context.',
      tier: 'top',
      provenance: {
        source: 'reality-check-duel',
        runAt: '2026-10-15T14:22:00Z',
        agentScores: { cc: 880, cod: 910 },
        contested: true,
        survivingCritique: 'The selected goal still needs a rollback path.',
        steelman: 'Treat rollback as part of the feature contract.',
      },
    };

    const instructions = resolveDuelProvenanceInstructions({
      selectedGoal: 'Durable provenance',
      candidateIdeas: [selectedIdea],
    });

    expect(instructions).toContain('mode=reliability');
    expect(instructions).toContain('cc=880, cod=910, gmi=<0-1000 or n/a>');
    expect(instructions).toContain('The selected goal still needs a rollback path.');
    expect(instructions).toContain('- **Contested:** true');
  });

  it('returns undefined when neither the plan nor the selected idea came from a duel', () => {
    expect(resolveDuelProvenanceInstructions({
      planSource: 'standard',
      selectedGoal: 'Ordinary task',
      candidateIdeas: [],
    })).toBeUndefined();
  });
});
