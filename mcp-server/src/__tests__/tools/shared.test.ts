import { describe, it, expect } from 'vitest';
import {
  slugifyGoal,
  computeConvergenceScore,
  computeBeadQualityScore,
  formatBeadQualityScore,
  resolveExecutionMode,
  pickRefinementModel,
  formatModelRef,
  makeChoiceOption,
  makeNextToolStep,
  makeToolError,
  makeToolResult,
} from '../../tools/shared.js';
import type { Bead } from '../../types.js';

// ─── slugifyGoal ───────────────────────────────────────────────

describe('slugifyGoal', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugifyGoal('Add Rate Limiting')).toBe('add-rate-limiting');
  });

  it('strips special characters', () => {
    expect(slugifyGoal('fix: bug #42 (urgent!)')).toBe('fix-bug-42-urgent');
  });

  it('removes leading and trailing hyphens', () => {
    expect(slugifyGoal('---hello---')).toBe('hello');
  });

  it('truncates to 60 characters', () => {
    const long = 'a'.repeat(100);
    expect(slugifyGoal(long).length).toBe(60);
  });

  it('returns "plan" for empty string after stripping', () => {
    expect(slugifyGoal('!!!')).toBe('plan');
    expect(slugifyGoal('')).toBe('plan');
  });

  it('collapses multiple non-alphanum runs into single hyphen', () => {
    expect(slugifyGoal('foo   bar___baz')).toBe('foo-bar-baz');
  });
});

// ─── computeConvergenceScore ───────────────────────────────────

describe('computeConvergenceScore', () => {
  it('returns 0 with fewer than 3 rounds', () => {
    expect(computeConvergenceScore([])).toBe(0);
    expect(computeConvergenceScore([5])).toBe(0);
    expect(computeConvergenceScore([5, 3])).toBe(0);
  });

  it('returns 1 when last 3 rounds have zero changes', () => {
    expect(computeConvergenceScore([10, 5, 0, 0, 0])).toBe(1);
    expect(computeConvergenceScore([0, 0, 0])).toBe(1);
  });

  it('returns a score between 0 and 1', () => {
    const score = computeConvergenceScore([10, 8, 5]);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('gives higher score for decreasing changes', () => {
    const decreasing = computeConvergenceScore([10, 5, 2]);
    const increasing = computeConvergenceScore([2, 5, 10]);
    expect(decreasing).toBeGreaterThan(increasing);
  });

  it('awards size stability bonus when output sizes are stable', () => {
    const withStable = computeConvergenceScore([3, 2, 1], [1000, 1001]);
    const withoutSizes = computeConvergenceScore([3, 2, 1]);
    expect(withStable).toBeGreaterThanOrEqual(withoutSizes);
  });

  it('handles large change counts gracefully', () => {
    const score = computeConvergenceScore([100, 100, 100]);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('only uses last 3 entries of polishChanges', () => {
    // Same last 3 entries should give same score regardless of earlier entries
    const a = computeConvergenceScore([99, 99, 3, 2, 1]);
    const b = computeConvergenceScore([0, 0, 3, 2, 1]);
    expect(a).toBe(b);
  });
});

// ─── computeBeadQualityScore ───────────────────────────────────

describe('computeBeadQualityScore', () => {
  const makeBead = (overrides: Partial<Bead> = {}): Bead => ({
    id: 'test-1',
    title: 'Add rate limiting to /api/submit',
    description: `**WHAT**: Add rate limiting middleware to protect the submit endpoint.
**WHY**: Prevent abuse from bots.
**HOW**: Modify src/middleware/rateLimit.ts to add per-IP throttling.

**Acceptance criteria:**
- Rate limit is 10 req/min per IP
- Returns 429 on excess`,
    status: 'open',
    priority: 2,
    type: 'task',
    labels: [],
    ...overrides,
  });

  it('returns score 0 and "no beads" label for empty array', () => {
    const result = computeBeadQualityScore([]);
    expect(result.score).toBe(0);
    expect(result.label).toContain('no beads');
  });

  it('returns score in 0-1 range', () => {
    const result = computeBeadQualityScore([makeBead()]);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('scores high for well-formed beads', () => {
    const result = computeBeadQualityScore([makeBead()]);
    expect(result.score).toBeGreaterThanOrEqual(0.7);
  });

  it('scores lower for weak beads (no verb title, short description, no files)', () => {
    const weak = makeBead({
      title: 'something',
      description: 'do stuff',
    });
    const result = computeBeadQualityScore([weak]);
    expect(result.score).toBeLessThan(0.5);
    expect(result.weakBeads.length).toBeGreaterThan(0);
  });

  it('identifies weak beads by ID', () => {
    const weak = makeBead({
      id: 'weak-bead-1',
      title: 'thing',
      description: 'short',
    });
    const result = computeBeadQualityScore([weak]);
    expect(result.weakBeads.some(w => w.includes('weak-bead-1'))).toBe(true);
  });

  it('averages scores across multiple beads', () => {
    const strong = makeBead({ id: 'strong' });
    const weak = makeBead({ id: 'weak', title: 'thing', description: 'x' });
    const mixed = computeBeadQualityScore([strong, weak]);
    const strongOnly = computeBeadQualityScore([strong]);
    const weakOnly = computeBeadQualityScore([weak]);
    // Mixed should be between the two
    expect(mixed.score).toBeLessThan(strongOnly.score);
    expect(mixed.score).toBeGreaterThan(weakOnly.score);
  });
});

// ─── formatBeadQualityScore ────────────────────────────────────

describe('formatBeadQualityScore', () => {
  it('includes numeric score in output', () => {
    const q = { score: 0.85, label: 'high quality', weakBeads: [] };
    const output = formatBeadQualityScore(q);
    expect(output).toContain('85/100');
  });

  it('includes the label', () => {
    const q = { score: 0.5, label: 'needs polish', weakBeads: [] };
    const output = formatBeadQualityScore(q);
    expect(output).toContain('needs polish');
  });

  it('includes weak bead info when present', () => {
    const q = { score: 0.4, label: 'needs polish', weakBeads: ['bead-1 (title not a verb phrase)'] };
    const output = formatBeadQualityScore(q);
    expect(output).toContain('bead-1');
  });

  it('shows progress bar characters', () => {
    const q = { score: 0.7, label: 'acceptable', weakBeads: [] };
    const output = formatBeadQualityScore(q);
    // Should contain filled and empty bar segments
    expect(output).toContain('█');
    expect(output).toContain('░');
  });
});

// ─── resolveExecutionMode ──────────────────────────────────────

describe('resolveExecutionMode', () => {
  it('returns "single-branch" when coordinationMode is single-branch', () => {
    expect(resolveExecutionMode('single-branch', false)).toBe('single-branch');
  });

  it('returns "worktree" when coordinationMode is worktree', () => {
    expect(resolveExecutionMode('worktree', true)).toBe('worktree');
  });

  it('returns "single-branch" when auto and hasAgentMail is true', () => {
    expect(resolveExecutionMode(undefined, true)).toBe('single-branch');
  });

  it('returns "worktree" when auto and hasAgentMail is false', () => {
    expect(resolveExecutionMode(undefined, false)).toBe('worktree');
  });
});

// ─── pickRefinementModel ───────────────────────────────────────

describe('pickRefinementModel', () => {
  it('rotates through models deterministically', () => {
    const m0 = pickRefinementModel(0);
    const m1 = pickRefinementModel(1);
    expect(m0).not.toBe(m1);
  });

  it('cycles back to first model after full rotation', () => {
    expect(pickRefinementModel(0)).toBe(pickRefinementModel(4));
  });

  it('always returns a string', () => {
    for (let i = 0; i < 8; i++) {
      expect(typeof pickRefinementModel(i)).toBe('string');
    }
  });
});

// ─── formatModelRef ────────────────────────────────────────────

describe('formatModelRef', () => {
  it('formats with provider prefix when provider exists', () => {
    expect(formatModelRef({ provider: 'anthropic', id: 'opus' })).toBe('anthropic/opus');
  });

  it('returns just id when no provider', () => {
    expect(formatModelRef({ id: 'sonnet' })).toBe('sonnet');
  });
});

// ─── shared structured tool result helpers ─────────────────────

describe('makeChoiceOption', () => {
  it('builds a choice option with optional metadata', () => {
    expect(makeChoiceOption('plan-first', 'Plan first', {
      description: 'Generate a standard plan',
      tool: 'orch_plan',
      args: { mode: 'standard' },
    })).toEqual({
      id: 'plan-first',
      label: 'Plan first',
      description: 'Generate a standard plan',
      tool: 'orch_plan',
      args: { mode: 'standard' },
    });
  });
});

describe('makeNextToolStep', () => {
  it('creates a structured next-step payload', () => {
    expect(makeNextToolStep('call_tool', 'Call orch_select next', {
      tool: 'orch_select',
      argsSchemaHint: { goal: 'string' },
      options: [
        makeChoiceOption('select-goal', 'Select a goal', { tool: 'orch_select' }),
      ],
    })).toEqual({
      type: 'call_tool',
      message: 'Call orch_select next',
      tool: 'orch_select',
      argsSchemaHint: { goal: 'string' },
      options: [
        {
          id: 'select-goal',
          label: 'Select a goal',
          tool: 'orch_select',
        },
      ],
    });
  });
});

describe('makeToolResult', () => {
  it('returns text content with structuredContent', () => {
    const structured = {
      tool: 'orch_profile',
      version: 1,
      status: 'ok',
      phase: 'discovering',
      data: { kind: 'profile_ready' },
    };

    expect(makeToolResult('Profile complete', structured)).toEqual({
      content: [{ type: 'text', text: 'Profile complete' }],
      structuredContent: structured,
    });
  });
});

describe('makeToolError', () => {
  it('returns a standard structured error result with isError set', () => {
    const result = makeToolError('orch_select', 'planning', 'invalid_input', 'Goal is required', {
      retryable: false,
      details: { field: 'goal' },
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Goal is required' }],
      isError: true,
      structuredContent: {
        tool: 'orch_select',
        version: 1,
        status: 'error',
        phase: 'planning',
        data: {
          kind: 'error',
          error: {
            code: 'invalid_input',
            message: 'Goal is required',
            retryable: false,
            details: { field: 'goal' },
          },
        },
      },
    });
  });
});
