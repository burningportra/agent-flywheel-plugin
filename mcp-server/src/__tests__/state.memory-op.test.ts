/**
 * Tests for the flywheel_memory operation classifier (bead 71x).
 *
 * The classifier in state.ts is the single source of truth for which
 * flywheel_memory operations exist. Parallel bead `bve` will land
 * "refresh_learnings"; its case is stubbed out and must remain
 * un-classified until `bve` lights it up.
 */

import { describe, it, expect } from 'vitest';
import { classifyMemoryOperation } from '../state.js';

describe('classifyMemoryOperation', () => {
  it('classifies search as non-mutating, requires cm', () => {
    const d = classifyMemoryOperation('search');
    expect(d).toEqual({
      name: 'search',
      mutates: false,
      requiresCmCli: true,
      summary: expect.stringContaining('CASS'),
    });
  });

  it('classifies store as mutating, requires cm', () => {
    const d = classifyMemoryOperation('store');
    expect(d?.mutates).toBe(true);
    expect(d?.requiresCmCli).toBe(true);
  });

  it('classifies draft_postmortem as non-mutating, no cm required', () => {
    const d = classifyMemoryOperation('draft_postmortem');
    expect(d?.mutates).toBe(false);
    expect(d?.requiresCmCli).toBe(false);
  });

  it('classifies draft_solution_doc as non-mutating, no cm required', () => {
    const d = classifyMemoryOperation('draft_solution_doc');
    expect(d).not.toBeNull();
    expect(d?.mutates).toBe(false);
    expect(d?.requiresCmCli).toBe(false);
    expect(d?.summary).toContain('docs/solutions');
  });

  it('returns null for unknown operations (including bve-reserved refresh_learnings)', () => {
    expect(classifyMemoryOperation('refresh_learnings')).toBeNull();
    expect(classifyMemoryOperation('nonsense')).toBeNull();
    expect(classifyMemoryOperation('')).toBeNull();
  });
});
