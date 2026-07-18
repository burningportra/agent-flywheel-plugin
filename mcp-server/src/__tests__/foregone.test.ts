import { describe, expect, it } from 'vitest';
import { computeForegoneScore } from '../foregone.js';
import type { ForegoneInputs } from '../foregone.js';

describe('foregone', () => {
  it('should score high when all dimensions are good', () => {
    const inputs: ForegoneInputs = {
      planQuality: { overall: 90 },
      convergenceScore: 0.9,
      beadQualityPassRate: { passed: 10, total: 10 },
      graphInsights: { Cycles: null, Orphans: [], Articulation: [], Bottlenecks: [], Slack: [] },
      planCoverage: { overall: 90 } as any,
    };
    const score = computeForegoneScore(inputs);
    expect(score.overall).toBeGreaterThan(80);
    expect(score.isForegonable).toBe(true);
  });

  it('should be not ready when plan coverage is low', () => {
    const inputs: ForegoneInputs = {
      planQuality: { overall: 90 },
      convergenceScore: 0.9,
      beadQualityPassRate: { passed: 10, total: 10 },
      graphInsights: { Cycles: null, Orphans: [], Articulation: [], Bottlenecks: [], Slack: [] },
      planCoverage: { overall: 30, gaps: [{ heading: 'G1' }] } as any,
    };
    const score = computeForegoneScore(inputs);
    expect(score.planCoverage).toBe(30);
    expect(score.blockers.some(b => b.includes('Plan coverage 30%'))).toBe(true);
    expect(score.isForegonable).toBe(false);
  });

  it('should detect graph cycles as health issue', () => {
    const inputs: ForegoneInputs = {
      planQuality: { overall: 90 },
      convergenceScore: 0.9,
      beadQualityPassRate: { passed: 10, total: 10 },
      graphInsights: { Cycles: [['a', 'b', 'a']], Orphans: [], Articulation: [], Bottlenecks: [], Slack: [] },
      planCoverage: { overall: 90 } as any,
    };
    const score = computeForegoneScore(inputs);
    expect(score.graphHealth).toBe(60); // 100 - 40
    expect(score.blockers.some(b => b.includes('1 cycle(s)'))).toBe(true);
  });

  it('should handle empty graph insights gracefully', () => {
    const inputs: ForegoneInputs = {
      planQuality: { overall: 90 },
      convergenceScore: 0.9,
      beadQualityPassRate: { passed: 10, total: 10 },
      graphInsights: null,
      planCoverage: { overall: 90 } as any,
    };
    const score = computeForegoneScore(inputs);
    expect(score.graphHealth).toBe(50); // neutral score
  });
});
