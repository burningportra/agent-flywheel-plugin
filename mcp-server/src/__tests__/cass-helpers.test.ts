import { describe, it, expect, vi, beforeEach } from 'vitest';
import { storeComplianceScore } from '../cass-helpers.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => Buffer.from('{"ok":true}')),
}));

import { execFileSync } from 'node:child_process';

describe('storeComplianceScore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls cm add with compliance_score kind and required tags', () => {
    storeComplianceScore('/tmp/proj', {
      beadId: 'agent-flywheel-001',
      score: 850,
      threshold: 700,
      passed: true,
      rubric: { impl_completeness: '260/300' },
      passUtc: '2026-05-08T19:14:22Z',
      sessionId: 'sess-abc',
      gitHead: 'baf8fda',
    });

    expect(execFileSync).toHaveBeenCalledOnce();
    const [bin, args] = (execFileSync as any).mock.calls[0];
    expect(bin).toBe('cm');
    expect(args).toContain('add');
    expect(args.join(' ')).toContain('compliance_score');
    expect(args.join(' ')).toContain('agent-flywheel-001');
    expect(args.join(' ')).toContain('score-850-1000');
  });

  it('buckets score correctly', () => {
    const cases: Array<[number, string]> = [
      [100, 'score-0-499'],
      [499, 'score-0-499'],
      [500, 'score-500-699'],
      [699, 'score-500-699'],
      [700, 'score-700-849'],
      [849, 'score-700-849'],
      [850, 'score-850-1000'],
      [1000, 'score-850-1000'],
    ];
    for (const [score, expectedBucket] of cases) {
      vi.clearAllMocks();
      storeComplianceScore('/tmp/proj', {
        beadId: 'b', score, threshold: 700, passed: score >= 700,
        rubric: {}, passUtc: '2026-05-08T19:14:22Z', sessionId: null, gitHead: 'abc',
      });
      const args = (execFileSync as any).mock.calls[0][1];
      expect(args.join(' '), `score=${score}`).toContain(expectedBucket);
    }
  });
});
