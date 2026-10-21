import { describe, expect, it } from 'vitest';

import {
  filterBeadsForProgram,
  goalBeadProgramLabel,
  resolveBeadProgram,
  slugifyGoal,
} from '../../tools/bead-program.js';
import type { Bead } from '../../types.js';

function bead(id: string, labels: string[], status: Bead['status'] = 'open'): Bead {
  return {
    id,
    title: id,
    description: id,
    status,
    priority: 2,
    type: 'task',
    labels,
  };
}

describe('goal bead program identity', () => {
  it('keeps the established slug contract and disambiguates slug collisions', () => {
    expect(slugifyGoal('Add Rate Limiting')).toBe('add-rate-limiting');
    expect(goalBeadProgramLabel('Goal A')).toBe('flywheel-goal:goal-a:ccba1a8c');

    const prefix = 'x'.repeat(60);
    const first = goalBeadProgramLabel(`${prefix} first`);
    const second = goalBeadProgramLabel(`${prefix} second`);
    expect(first).not.toBe(second);
    expect(first.split(':')[1]).toBe(second.split(':')[1]);
  });

  it('keeps every goal label within the 50-character br label limit', () => {
    const label = goalBeadProgramLabel(
      'Create an Antigravity agy mirror plugin, close all July 2026 gaps',
    );
    expect(label.length).toBeLessThanOrEqual(50);
    expect(label).toMatch(/^flywheel-goal:create-an-antigravity-agy-m:[0-9a-f]{8}$/);

    // A cut that lands on a separator must not leave a trailing hyphen.
    const boundary = goalBeadProgramLabel(`${'a'.repeat(26)} tail`);
    expect(boundary).toMatch(/^flywheel-goal:a{26}:[0-9a-f]{8}$/);
  });

  it('resolves tagged programs without admitting other or untagged beads', () => {
    const labelA = goalBeadProgramLabel('Goal A');
    const labelB = goalBeadProgramLabel('Goal B');
    const result = resolveBeadProgram([
      bead('a-open', [labelA]),
      bead('a-closed', [labelA], 'closed'),
      bead('b-open', [labelB]),
      bead('untagged', []),
    ], labelA);

    expect(result.scope).toEqual({ kind: 'tagged', label: labelA });
    expect(result.beads.map(({ id }) => id)).toEqual(['a-open']);
    expect(result.warnings).toEqual([
      `Excluded 1 untagged active bead(s) from ${labelA}: untagged.`,
    ]);
  });

  it('uses repository-wide legacy mode only when no goal-program label exists', () => {
    const expectedLabel = goalBeadProgramLabel('Legacy goal');
    const result = resolveBeadProgram([
      bead('legacy-open', ['bug']),
      bead('legacy-progress', [], 'in_progress'),
      bead('legacy-closed', [], 'closed'),
    ], expectedLabel);

    expect(result.scope).toEqual({ kind: 'legacy', label: expectedLabel });
    expect(result.beads.map(({ id }) => id)).toEqual([
      'legacy-open',
      'legacy-progress',
    ]);
    expect(result.warnings[0]).toContain('using legacy repository-wide scope');
  });

  it('does not fall back when another tagged program exists', () => {
    const labelA = goalBeadProgramLabel('Goal A');
    const labelB = goalBeadProgramLabel('Goal B');
    const result = resolveBeadProgram([
      bead('b-closed', [labelB], 'closed'),
      bead('untagged-open', []),
    ], labelA);

    expect(result.scope).toEqual({ kind: 'tagged', label: labelA });
    expect(result.beads).toEqual([]);
    expect(result.warnings).toEqual([
      `No active beads match ${labelA}; repository-wide fallback is disabled because other goal-program labels exist.`,
      `Excluded 1 untagged active bead(s) from ${labelA}: untagged-open.`,
    ]);
  });

  it('filters ready beads according to the persisted scope mode', () => {
    const labelA = goalBeadProgramLabel('Goal A');
    const candidates = [
      bead('a-ready', [labelA]),
      bead('b-ready', [goalBeadProgramLabel('Goal B')]),
      bead('legacy-ready', ['bug']),
    ];

    expect(filterBeadsForProgram(
      candidates,
      { kind: 'tagged', label: labelA },
    ).beads.map(({ id }) => id)).toEqual(['a-ready']);
    expect(filterBeadsForProgram(
      candidates,
      { kind: 'legacy', label: labelA },
    ).beads.map(({ id }) => id)).toEqual(['legacy-ready']);
    expect(filterBeadsForProgram(candidates, undefined).beads.map(({ id }) => id))
      .toEqual(['legacy-ready']);
  });
});
