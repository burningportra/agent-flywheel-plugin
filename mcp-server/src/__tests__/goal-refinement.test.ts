import { describe, it, expect } from 'vitest';
import {
  synthesizeGoal,
  extractConstraints,
  parseQuestionsJSON,
} from '../goal-refinement.js';
import type { RefinementAnswer, RefinementQuestion } from '../goal-refinement.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeAnswer(overrides: Partial<RefinementAnswer> = {}): RefinementAnswer {
  return {
    id: 'test',
    value: 'test-value',
    label: 'Test label',
    wasCustom: false,
    ...overrides,
  };
}

// ─── synthesizeGoal ─────────────────────────────────────────────

describe('synthesizeGoal', () => {
  it('produces output with just the goal when answers is empty', () => {
    const result = synthesizeGoal('Build a widget', []);
    expect(result).toContain('## Goal');
    expect(result).toContain('Build a widget');
    // Should NOT have any other sections
    expect(result).not.toContain('## Scope');
    expect(result).not.toContain('## Constraints');
    expect(result).not.toContain('## Non-Goals');
  });

  it('places scope answers in Scope section', () => {
    const answers = [makeAnswer({ id: 'target-layer', label: 'Backend only' })];
    const result = synthesizeGoal('Build a widget', answers);
    expect(result).toContain('## Scope');
    expect(result).toContain('Backend only');
  });

  it('places constraint answers in Constraints section', () => {
    const answers = [makeAnswer({ id: 'constraint-perf', label: 'Must be under 100ms' })];
    const result = synthesizeGoal('Build a widget', answers);
    expect(result).toContain('## Constraints');
    expect(result).toContain('Must be under 100ms');
  });

  it('places non-goal/avoid answers in Non-Goals section', () => {
    const answers = [
      makeAnswer({ id: 'non-goal-ui', label: 'No UI changes' }),
      makeAnswer({ id: 'exclude-legacy', label: 'Exclude legacy support' }),
      makeAnswer({ id: 'misc', value: 'avoid-breaking', label: 'Avoid breaking changes' }),
    ];
    const result = synthesizeGoal('Build a widget', answers);
    expect(result).toContain('## Non-Goals');
    expect(result).toContain('No UI changes');
    expect(result).toContain('Exclude legacy support');
    expect(result).toContain('Avoid breaking changes');
  });

  it('places success/criteria/quality answers in Success Criteria section', () => {
    const answers = [makeAnswer({ id: 'success-metric', label: '100% test pass rate' })];
    const result = synthesizeGoal('Build a widget', answers);
    expect(result).toContain('## Success Criteria');
    expect(result).toContain('100% test pass rate');
  });

  it('places miscellaneous answers in Implementation Notes section', () => {
    const answers = [makeAnswer({ id: 'approach', label: 'Use functional style' })];
    const result = synthesizeGoal('Build a widget', answers);
    expect(result).toContain('## Implementation Notes');
    expect(result).toContain('approach');
    expect(result).toContain('Use functional style');
  });

  it('handles mixed bucket answers correctly', () => {
    const answers = [
      makeAnswer({ id: 'scope-api', label: 'API layer' }),
      makeAnswer({ id: 'constraint-time', label: 'Due by Friday' }),
      makeAnswer({ id: 'non-goal-docs', label: 'Skip docs' }),
      makeAnswer({ id: 'quality-bar', label: '80% coverage' }),
      makeAnswer({ id: 'approach', label: 'TDD' }),
    ];
    const result = synthesizeGoal('Full stack feature', answers);
    expect(result).toContain('## Scope');
    expect(result).toContain('## Constraints');
    expect(result).toContain('## Non-Goals');
    expect(result).toContain('## Success Criteria');
    expect(result).toContain('## Implementation Notes');
  });
});

// ─── extractConstraints ─────────────────────────────────────────

describe('extractConstraints', () => {
  it('returns only constraint/non-goal/avoid/exclude bucket answers', () => {
    const answers = [
      makeAnswer({ id: 'scope-api', label: 'API layer' }),
      makeAnswer({ id: 'constraint-time', label: 'Due by Friday' }),
      makeAnswer({ id: 'non-goal-docs', label: 'Skip docs' }),
      makeAnswer({ id: 'avoid-breaking', label: 'No breaking changes' }),
      makeAnswer({ id: 'exclude-legacy', label: 'No legacy' }),
      makeAnswer({ id: 'approach', label: 'TDD' }),
    ];
    const result = extractConstraints(answers);
    expect(result).toEqual(['Due by Friday', 'Skip docs', 'No breaking changes', 'No legacy']);
  });

  it('returns empty array for empty input', () => {
    expect(extractConstraints([])).toEqual([]);
  });

  it('returns empty when no answers match constraint buckets', () => {
    const answers = [
      makeAnswer({ id: 'scope-api', label: 'API layer' }),
      makeAnswer({ id: 'approach', label: 'TDD' }),
    ];
    expect(extractConstraints(answers)).toEqual([]);
  });
});

// ─── parseQuestionsJSON ─────────────────────────────────────────

describe('parseQuestionsJSON', () => {
  it('parses a valid JSON array of question objects', () => {
    const questions = [
      {
        id: 'scope',
        label: 'Scope',
        prompt: 'What is the scope?',
        options: [{ value: 'small', label: 'Small' }],
        allowOther: true,
      },
    ];
    const result = parseQuestionsJSON(JSON.stringify(questions));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('scope');
    expect(result[0].prompt).toBe('What is the scope?');
    expect(result[0].options).toHaveLength(1);
    expect(result[0].allowOther).toBe(true);
  });

  it('strips markdown fences and parses', () => {
    const questions = [
      {
        id: 'approach',
        label: 'Approach',
        prompt: 'How?',
        options: [{ value: 'a', label: 'Option A' }],
      },
    ];
    const output = '```json\n' + JSON.stringify(questions) + '\n```';
    const result = parseQuestionsJSON(output);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('approach');
  });

  it('returns fallback question(s) for invalid JSON', () => {
    const result = parseQuestionsJSON('this is not json');
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].id).toBe('approach');
    expect(result[0].options.length).toBeGreaterThan(0);
  });

  it('returns empty array for "[]"', () => {
    const result = parseQuestionsJSON('[]');
    expect(result).toEqual([]);
  });

  it('defaults allowOther to true when field is missing', () => {
    const questions = [
      {
        id: 'q1',
        label: 'Question 1',
        prompt: 'Ask something',
        options: [{ value: 'a', label: 'A' }],
        // allowOther is intentionally missing
      },
    ];
    const result = parseQuestionsJSON(JSON.stringify(questions));
    expect(result).toHaveLength(1);
    expect(result[0].allowOther).toBe(true);
  });

  it('respects allowOther: false', () => {
    const questions = [
      {
        id: 'q1',
        label: 'Question 1',
        prompt: 'Ask something',
        options: [{ value: 'a', label: 'A' }],
        allowOther: false,
      },
    ];
    const result = parseQuestionsJSON(JSON.stringify(questions));
    expect(result).toHaveLength(1);
    expect(result[0].allowOther).toBe(false);
  });

  it('filters out questions missing required fields', () => {
    const questions = [
      { id: 'valid', prompt: 'Ask?', options: [{ value: 'a', label: 'A' }] },
      { id: 'no-prompt', options: [{ value: 'a', label: 'A' }] },  // missing prompt
      { id: 'no-options', prompt: 'Ask?' },  // missing options
      { prompt: 'Ask?', options: [{ value: 'a', label: 'A' }] },  // missing id
    ];
    const result = parseQuestionsJSON(JSON.stringify(questions));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('valid');
  });

  it('filters out options missing value or label', () => {
    const questions = [
      {
        id: 'q1',
        prompt: 'Ask?',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b' },           // missing label
          { label: 'C' },           // missing value
          { value: 'd', label: 'D' },
        ],
      },
    ];
    const result = parseQuestionsJSON(JSON.stringify(questions));
    expect(result).toHaveLength(1);
    expect(result[0].options).toHaveLength(2);
    expect(result[0].options[0].value).toBe('a');
    expect(result[0].options[1].value).toBe('d');
  });
});
