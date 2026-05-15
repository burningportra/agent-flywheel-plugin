import { describe, expect, it, vi } from 'vitest';
import {
  computeExecutionOrder,
  computeParallelGroups,
  detectFileConflicts,
  simulateExecutionPaths,
} from '../plan-simulation.js';
import type { SimulatedBead } from '../plan-simulation.js';

vi.mock('../beads.js', () => ({
  extractArtifacts: vi.fn(() => []),
}));

function bead(
  id: string,
  deps: string[] = [],
  files: string[] = [],
): SimulatedBead {
  return {
    id,
    title: `Bead ${id}`,
    deps,
    files,
  };
}

function repoFilesFor(beads: SimulatedBead[]): Set<string> {
  return new Set(beads.flatMap((b) => b.files));
}

describe('computeExecutionOrder', () => {
  it('orders a linear dependency chain one bead at a time', () => {
    const beads = [
      bead('A'),
      bead('B', ['A']),
      bead('C', ['B']),
      bead('D', ['C']),
    ];

    expect(computeExecutionOrder(beads)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('keeps dependencies before dependents across a branched graph', () => {
    const beads = [
      bead('A'),
      bead('B', ['A']),
      bead('C', ['A']),
      bead('D', ['B', 'C']),
    ];

    const order = computeExecutionOrder(beads);
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('C'));
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'));
    expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'));
  });
});

describe('computeParallelGroups', () => {
  it('groups a diamond dependency graph as [A], [B,C], [D]', () => {
    const beads = [
      bead('A'),
      bead('B', ['A']),
      bead('C', ['A']),
      bead('D', ['B', 'C']),
    ];

    expect(computeParallelGroups(beads)).toEqual([
      ['A'],
      ['B', 'C'],
      ['D'],
    ]);
  });

  it('puts an orphan bead in the first parallel group with other roots', () => {
    const beads = [bead('A'), bead('B', ['A']), bead('orphan')];

    expect(computeParallelGroups(beads)).toEqual([['A', 'orphan'], ['B']]);
  });

  it('returns a single first-level group for independent beads', () => {
    const beads = [bead('A'), bead('B'), bead('C')];

    expect(computeParallelGroups(beads)).toEqual([['A', 'B', 'C']]);
  });
});

describe('detectFileConflicts', () => {
  it('reports beads in the same parallel group that touch the same file', () => {
    const beads = [
      bead('A', [], ['src/shared.ts']),
      bead('B', [], ['src/shared.ts']),
      bead('C', [], ['src/other.ts']),
    ];

    expect(detectFileConflicts(beads, [['A', 'B', 'C']])).toEqual([
      { file: 'src/shared.ts', beadIds: ['A', 'B'] },
    ]);
  });

  it('allows sequential beads to touch the same file', () => {
    const beads = [
      bead('A', [], ['src/shared.ts']),
      bead('B', ['A'], ['src/shared.ts']),
    ];

    expect(detectFileConflicts(beads, [['A'], ['B']])).toEqual([]);
  });
});

describe('simulateExecutionPaths', () => {
  it('returns invalid with a cycle warning instead of recursing forever', () => {
    const beads = [bead('A', ['B']), bead('B', ['A'])];

    const result = simulateExecutionPaths(beads, repoFilesFor(beads));

    expect(result.valid).toBe(false);
    expect(result.executionOrder).toEqual([]);
    expect(result.parallelGroups).toEqual([]);
    expect(result.fileConflicts).toEqual([]);
    expect(result.missingFiles).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Cycle detected');
  });

  it('returns an empty valid simulation for an empty bead graph', () => {
    const result = simulateExecutionPaths([], new Set());

    expect(result).toEqual({
      valid: true,
      executionOrder: [],
      parallelGroups: [],
      fileConflicts: [],
      missingFiles: [],
      warnings: [],
    });
  });

  it('returns a single bead in the first execution order and parallel group', () => {
    const beads = [bead('A', [], ['src/a.ts'])];

    const result = simulateExecutionPaths(beads, repoFilesFor(beads));

    expect(result).toMatchObject({
      valid: true,
      executionOrder: ['A'],
      parallelGroups: [['A']],
      fileConflicts: [],
      missingFiles: [],
      warnings: [],
    });
  });

  it('surfaces file conflicts from parallel beads in the consolidated result', () => {
    const beads = [
      bead('A', [], ['src/shared.ts']),
      bead('B', [], ['src/shared.ts']),
    ];

    const result = simulateExecutionPaths(beads, repoFilesFor(beads));

    expect(result.valid).toBe(false);
    expect(result.executionOrder).toEqual(['A', 'B']);
    expect(result.parallelGroups).toEqual([['A', 'B']]);
    expect(result.fileConflicts).toEqual([
      { file: 'src/shared.ts', beadIds: ['A', 'B'] },
    ]);
    expect(result.warnings).toEqual([
      '1 file conflict(s) between parallel beads',
    ]);
  });
});
