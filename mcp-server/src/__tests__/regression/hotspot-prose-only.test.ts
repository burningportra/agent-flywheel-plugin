/**
 * Regression test (Gate 1): file mentioned in prose only — severity must cap at med.
 *
 * Gate 1 surprise scenario discovered during v3.4.0 planning:
 *   - When a file appears exclusively in prose (not in a ### Files: section),
 *     severity must cap at 'med' even with high contention counts.
 *   - Recommendation must still flip to 'coordinator-serial' when count >= 2.
 *   - Contrast: a file in a ### Files: section with count >= 3 gets severity 'high'.
 *
 * Invariants under test:
 *   - 3 beads with prose-only mentions of src/x.ts → severity:'med', not 'high'.
 *   - contentionCount === 3.
 *   - recommendation === 'coordinator-serial'.
 *   - provenance === 'prose'.
 *   - HotspotMatrixSchema.parse() passes.
 */

import { describe, it, expect } from 'vitest';
import { computeHotspotMatrix } from '../../plan-simulation.js';
import { HotspotMatrixSchema } from '../../types.js';
import type { HotspotInputBead } from '../../plan-simulation.js';

// ─── Helpers ──────────────────────────────────────────────────

function proseBead(id: string, title: string, proseContent: string): HotspotInputBead {
  return { id, title, body: proseContent };
}

function filesSection(files: string[]): string {
  return `### Files:\n${files.map((f) => `- ${f}`).join('\n')}\n`;
}

// ─── Tests ───────────────────────────────────────────────────

describe('regression/hotspot-prose-only (Gate 1 regression)', () => {
  it('Gate 1: 3 prose-only beads for src/x.ts → severity=med, NOT high', () => {
    const beads: HotspotInputBead[] = [
      proseBead('b1', 'First bead', 'This bead modifies src/x.ts in a subtle way.'),
      proseBead('b2', 'Second bead', 'Also touches src/x.ts when processing events.'),
      proseBead('b3', 'Third bead', 'Refactors src/x.ts error handling.'),
    ];

    const matrix = computeHotspotMatrix(beads);
    expect(() => HotspotMatrixSchema.parse(matrix)).not.toThrow();

    const row = matrix.rows.find((r) => r.file === 'src/x.ts');
    expect(row, 'src/x.ts must appear in the matrix').toBeDefined();

    // Gate 1: prose-only → severity caps at med (NOT high).
    expect(row!.severity).toBe('med');
    expect(row!.severity).not.toBe('high');

    // Count must be 3 (one per bead).
    expect(row!.contentionCount).toBe(3);

    // Recommendation must flip to coordinator-serial (count >= 2 with med/high).
    expect(matrix.recommendation).toBe('coordinator-serial');

    // Provenance must be prose.
    expect(row!.provenance).toBe('prose');
  });

  it('Gate 1: 2 prose-only beads → severity=med, recommendation=coordinator-serial', () => {
    const beads: HotspotInputBead[] = [
      proseBead('c1', 'Bead C1', 'Updates logic in src/shared.ts for new API.'),
      proseBead('c2', 'Bead C2', 'Also changes src/shared.ts type exports.'),
    ];

    const matrix = computeHotspotMatrix(beads);

    const row = matrix.rows.find((r) => r.file === 'src/shared.ts');
    expect(row).toBeDefined();
    expect(row!.severity).toBe('med');
    expect(row!.contentionCount).toBe(2);
    expect(matrix.recommendation).toBe('coordinator-serial');
  });

  it('Gate 1: 1 prose-only bead → severity=low, recommendation=swarm', () => {
    const beads: HotspotInputBead[] = [
      proseBead('d1', 'Single bead', 'Touches src/utils.ts for logging.'),
    ];

    const matrix = computeHotspotMatrix(beads);

    const row = matrix.rows.find((r) => r.file === 'src/utils.ts');
    expect(row).toBeDefined();
    expect(row!.severity).toBe('low');
    expect(matrix.recommendation).toBe('swarm');
  });

  it('files-section provenance with 3 beads → severity=high (contrast with Gate 1)', () => {
    // This is the CONTRAST case — files-section provenance CAN reach high.
    const beads: HotspotInputBead[] = [
      { id: 'e1', title: 'E1', body: filesSection(['src/critical.ts']) },
      { id: 'e2', title: 'E2', body: filesSection(['src/critical.ts']) },
      { id: 'e3', title: 'E3', body: filesSection(['src/critical.ts']) },
    ];

    const matrix = computeHotspotMatrix(beads);

    const row = matrix.rows.find((r) => r.file === 'src/critical.ts');
    expect(row).toBeDefined();
    // Files-section + count >= 3 → high.
    expect(row!.severity).toBe('high');
    expect(row!.provenance).toBe('files-section');
    expect(matrix.recommendation).toBe('coordinator-serial');
  });

  it('mixed provenance: 1 files-section + 2 prose → severity=high (files-section wins)', () => {
    // The spec says: if any bead uses files-section, the provenance is files-section
    // for that file, and high threshold applies (3+).
    const beads: HotspotInputBead[] = [
      { id: 'f1', title: 'F1 files-section', body: filesSection(['src/x.ts']) },
      proseBead('f2', 'F2 prose', 'Touches src/x.ts in some way.'),
      proseBead('f3', 'F3 prose', 'Also modifies src/x.ts.'),
    ];

    const matrix = computeHotspotMatrix(beads);
    expect(() => HotspotMatrixSchema.parse(matrix)).not.toThrow();

    const row = matrix.rows.find((r) => r.file === 'src/x.ts');
    expect(row).toBeDefined();
    expect(row!.contentionCount).toBe(3);
    // Mixed with files-section → severity high (files-section provenance).
    expect(row!.severity).toBe('high');
    expect(row!.provenance).toBe('files-section');
  });
});
