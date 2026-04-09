import { describe, it, expect } from 'vitest';
import {
  parsePlanQualityScore,
  formatPlanQualityScore,
  planQualityScoringPrompt,
} from '../plan-quality.js';

// ─── parsePlanQualityScore ──────────────────────────────────────

describe('parsePlanQualityScore', () => {
  it('parses a valid JSON object', () => {
    const output = JSON.stringify({
      workflows: 80,
      edgeCases: 70,
      architecture: 90,
      specificity: 85,
      testability: 75,
      weakSections: ['error handling'],
    });
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.workflows).toBe(80);
    expect(score!.edgeCases).toBe(70);
    expect(score!.architecture).toBe(90);
    expect(score!.specificity).toBe(85);
    expect(score!.testability).toBe(75);
    expect(score!.weakSections).toEqual(['error handling']);
    expect(score!.overall).toBeGreaterThan(0);
  });

  it('parses JSON wrapped in markdown fences', () => {
    const output = '```json\n{"workflows": 60, "edgeCases": 50, "architecture": 70, "specificity": 65, "testability": 55, "weakSections": []}\n```';
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.workflows).toBe(60);
  });

  it('extracts JSON with surrounding text', () => {
    const output = 'Here is my assessment:\n{"workflows": 70, "edgeCases": 60, "architecture": 80, "specificity": 75, "testability": 65, "weakSections": ["testing"]}\nThat is my score.';
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.workflows).toBe(70);
  });

  it('returns null for non-JSON string', () => {
    expect(parsePlanQualityScore('This is not JSON at all')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parsePlanQualityScore('')).toBeNull();
  });

  it('clamps scores below 0 to 0', () => {
    const output = JSON.stringify({
      workflows: -10,
      edgeCases: 50,
      architecture: 50,
      specificity: 50,
      testability: 50,
      weakSections: [],
    });
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.workflows).toBe(0);
  });

  it('clamps scores above 100 to 100', () => {
    const output = JSON.stringify({
      workflows: 150,
      edgeCases: 50,
      architecture: 50,
      specificity: 50,
      testability: 50,
      weakSections: [],
    });
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.workflows).toBe(100);
  });

  it('handles NaN values gracefully (defaults to 50)', () => {
    const output = JSON.stringify({
      workflows: 'not a number',
      edgeCases: null,
      architecture: 80,
      specificity: 80,
      testability: 80,
      weakSections: [],
    });
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    // Non-numeric values default to 50
    expect(score!.workflows).toBe(50);
    expect(score!.edgeCases).toBe(50);
  });
});

// ─── Recommendation thresholds ──────────────────────────────────

describe('recommendation thresholds', () => {
  it('gives "block" when overall < 60', () => {
    const output = JSON.stringify({
      workflows: 30,
      edgeCases: 20,
      architecture: 30,
      specificity: 25,
      testability: 20,
      weakSections: [],
    });
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.overall).toBeLessThan(60);
    expect(score!.recommendation).toBe('block');
  });

  it('gives "warn" when overall is 60-79', () => {
    const output = JSON.stringify({
      workflows: 70,
      edgeCases: 70,
      architecture: 70,
      specificity: 70,
      testability: 70,
      weakSections: [],
    });
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.overall).toBe(70);
    expect(score!.recommendation).toBe('warn');
  });

  it('gives "proceed" when overall >= 80', () => {
    const output = JSON.stringify({
      workflows: 90,
      edgeCases: 85,
      architecture: 80,
      specificity: 80,
      testability: 80,
      weakSections: [],
    });
    const score = parsePlanQualityScore(output);
    expect(score).not.toBeNull();
    expect(score!.overall).toBeGreaterThanOrEqual(80);
    expect(score!.recommendation).toBe('proceed');
  });
});

// ─── formatPlanQualityScore ─────────────────────────────────────

describe('formatPlanQualityScore', () => {
  it('renders without throwing', () => {
    const score = parsePlanQualityScore(
      JSON.stringify({
        workflows: 80,
        edgeCases: 70,
        architecture: 90,
        specificity: 85,
        testability: 75,
        weakSections: ['edge cases'],
      })
    )!;
    const output = formatPlanQualityScore(score);
    expect(output).toContain('Plan Quality');
    expect(output).toContain('Workflows');
    expect(output).toContain('Edge Cases');
    expect(output).toContain('Architecture');
    expect(output).toContain('Specificity');
    expect(output).toContain('Testability');
  });

  it('shows weak spots when present', () => {
    const score = parsePlanQualityScore(
      JSON.stringify({
        workflows: 80,
        edgeCases: 70,
        architecture: 90,
        specificity: 85,
        testability: 75,
        weakSections: ['error handling', 'testing'],
      })
    )!;
    const output = formatPlanQualityScore(score);
    expect(output).toContain('Weak spots');
    expect(output).toContain('error handling');
  });

  it('shows block message for low scores', () => {
    const score = parsePlanQualityScore(
      JSON.stringify({
        workflows: 30,
        edgeCases: 20,
        architecture: 30,
        specificity: 25,
        testability: 20,
        weakSections: [],
      })
    )!;
    const output = formatPlanQualityScore(score);
    expect(output).toContain('refine the plan');
  });
});

// ─── planQualityScoringPrompt ───────────────────────────────────

describe('planQualityScoringPrompt', () => {
  it('produces a prompt containing the goal and plan', () => {
    const prompt = planQualityScoringPrompt('Build a widget', 'Create a reusable widget');
    expect(prompt).toContain('Build a widget');
    expect(prompt).toContain('Create a reusable widget');
    expect(prompt).toContain('Workflow Completeness');
  });
});
