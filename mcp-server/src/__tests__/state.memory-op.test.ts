/**
 * Tests for the flywheel_memory operation classifier (beads 71x + bve).
 *
 * The classifier in state.ts is the single source of truth for which
 * flywheel_memory operations exist. Bead `bve` lit up "refresh_learnings"
 * — verify it now returns a non-null descriptor with the expected shape.
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

  it('classifies refresh_learnings as non-mutating, no cm required (bead bve)', () => {
    const d = classifyMemoryOperation('refresh_learnings');
    expect(d).not.toBeNull();
    expect(d?.name).toBe('refresh_learnings');
    expect(d?.mutates).toBe(false);
    expect(d?.requiresCmCli).toBe(false);
    expect(d?.summary).toMatch(/Keep|Consolidate/);
  });

  it('returns null for unknown operations', () => {
    expect(classifyMemoryOperation('nonsense')).toBeNull();
    expect(classifyMemoryOperation('')).toBeNull();
  });
});
