/**
 * Tests for computeHotspotMatrix (I3 — pure hotspot matrix)
 *
 * Cross-reference: prior-session case (mod.rs) that inspired the
 * "3 beads all touching the same file via ### Files:" test (#3 below)
 * was the Rust concurrent-write hotspot discovered in v3.3.0 planning.
 */
import { describe, it, expect } from 'vitest';
import { computeHotspotMatrix } from '../plan-simulation.js';
import { HotspotMatrixSchema } from '../types.js';
// ─── Helpers ───────────────────────────────────────────────────
function bead(id, title, body) {
    return { id, title, body };
}
function filesSection(files) {
    return `### Files:\n${files.map((f) => `- ${f}`).join('\n')}\n`;
}
// ─── Test Suite ────────────────────────────────────────────────
describe('computeHotspotMatrix', () => {
    // Test 1: empty input
    it('empty input → empty matrix with swarm recommendation', () => {
        const result = computeHotspotMatrix([]);
        expect(result).toEqual({
            version: 1,
            rows: [],
            maxContention: 0,
            recommendation: 'swarm',
            summaryOnly: false,
        });
    });
    // Test 2: single bead, single file
    it('single bead mentioning one file → one low-severity row, swarm recommendation', () => {
        const beads = [
            bead('b1', 'Implement feature', filesSection(['src/server.ts'])),
        ];
        const result = computeHotspotMatrix(beads);
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({
            file: 'src/server.ts',
            contentionCount: 1,
            severity: 'low',
            beadIds: ['b1'],
            provenance: 'files-section',
        });
        expect(result.recommendation).toBe('swarm');
        expect(result.maxContention).toBe(1);
        expect(result.summaryOnly).toBe(false);
    });
    // Test 3: 3 beads all touching server.ts via ### Files: → high severity, coordinator-serial
    // (mirrors the mod.rs prior-session concurrent-write hotspot case from v3.3.0)
    it('3 beads with ### Files: referencing server.ts → high severity + coordinator-serial', () => {
        const beads = [
            bead('b1', 'Bead 1', filesSection(['mcp-server/src/server.ts'])),
            bead('b2', 'Bead 2', filesSection(['mcp-server/src/server.ts'])),
            bead('b3', 'Bead 3', filesSection(['mcp-server/src/server.ts'])),
        ];
        const result = computeHotspotMatrix(beads);
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({
            file: 'mcp-server/src/server.ts',
            contentionCount: 3,
            severity: 'high',
            provenance: 'files-section',
            beadIds: ['b1', 'b2', 'b3'],
        });
        expect(result.recommendation).toBe('coordinator-serial');
        expect(result.maxContention).toBe(3);
    });
    // Test 4: prose-only mention — 3 beads → severity capped at med (not high)
    it('3 beads referencing file via prose only → severity med (not high)', () => {
        const beads = [
            bead('b1', 'Work on something', 'See the file src/foo.ts for context.'),
            bead('b2', 'Another thing', 'Also modifies src/foo.ts inline.'),
            bead('b3', 'Third', 'And src/foo.ts needs updating too.'),
        ];
        const result = computeHotspotMatrix(beads);
        const row = result.rows.find((r) => r.file === 'src/foo.ts');
        expect(row).toBeDefined();
        expect(row.severity).toBe('med');
        expect(row.provenance).toBe('prose');
        expect(row.contentionCount).toBe(3);
        expect(result.recommendation).toBe('coordinator-serial');
    });
    // Test 5: mixed provenance — 1 bead via files-section, 2 via prose → high
    it('1 bead with ### Files: + 2 prose beads → severity high (files-section provenance)', () => {
        const beads = [
            bead('b1', 'Bead with section', filesSection(['src/x.ts'])),
            bead('b2', 'Prose bead', 'Modifies src/x.ts in a subtle way.'),
            bead('b3', 'Another prose', 'Also touches src/x.ts.'),
        ];
        const result = computeHotspotMatrix(beads);
        const row = result.rows.find((r) => r.file === 'src/x.ts');
        expect(row).toBeDefined();
        expect(row.contentionCount).toBe(3);
        expect(row.severity).toBe('high');
        expect(row.provenance).toBe('files-section');
        expect(result.recommendation).toBe('coordinator-serial');
    });
    // Test 6: determinism — reverse input order produces identical matrix
    it('output is deterministic regardless of input bead order', () => {
        const beads = [
            bead('c3', 'C3', filesSection(['shared/utils.ts'])),
            bead('c1', 'C1', filesSection(['shared/utils.ts'])),
            bead('c2', 'C2', filesSection(['shared/utils.ts'])),
        ];
        const reversed = [...beads].reverse();
        const result1 = computeHotspotMatrix(beads);
        const result2 = computeHotspotMatrix(reversed);
        expect(result1).toEqual(result2);
        // Verify beadIds are sorted ascending
        expect(result1.rows[0].beadIds).toEqual(['c1', 'c2', 'c3']);
    });
    // Test 7: 200 beads → summaryOnly:true, rows.length <= 10
    it('200 beads all touching big.ts → summaryOnly:true and rows.length <= 10', () => {
        const beads = Array.from({ length: 200 }, (_, i) => ({
            id: `bead-${String(i).padStart(3, '0')}`,
            title: `Bead ${i}`,
            body: filesSection(['big.ts']),
        }));
        const result = computeHotspotMatrix(beads);
        expect(result.summaryOnly).toBe(true);
        expect(result.rows.length).toBeLessThanOrEqual(10);
        expect(result.maxContention).toBe(200);
        expect(result.recommendation).toBe('coordinator-serial');
    });
    // Test 8: malformed body (undefined or empty string) → no throw, no row for that bead
    it('bead with undefined body does not throw and is silently skipped for body parsing', () => {
        const beads = [
            bead('m1', 'No body bead'), // body is undefined
            bead('m2', 'Has body', filesSection(['real/file.ts'])),
        ];
        expect(() => computeHotspotMatrix(beads)).not.toThrow();
        const result = computeHotspotMatrix(beads);
        // m1 has no body and title has no file extension matches → no rows for m1
        // m2 has a file section → one row for real/file.ts
        const row = result.rows.find((r) => r.file === 'real/file.ts');
        expect(row).toBeDefined();
        expect(row.beadIds).toEqual(['m2']);
    });
    it('bead with empty string body does not throw', () => {
        const beads = [bead('e1', 'Empty body bead', '')];
        expect(() => computeHotspotMatrix(beads)).not.toThrow();
    });
    // Test 9: Zod round-trip — assert HotspotMatrixSchema.parse(result) succeeds
    it('Zod round-trip passes for all result shapes', () => {
        const cases = [
            // empty
            [],
            // single bead
            [bead('z1', 'Only one', filesSection(['only.ts']))],
            // 3 beads high severity
            [
                bead('z2', 'B2', filesSection(['shared.ts'])),
                bead('z3', 'B3', filesSection(['shared.ts'])),
                bead('z4', 'B4', filesSection(['shared.ts'])),
            ],
            // prose only med
            [
                bead('z5', 'Prose1', 'file src/bar.ts'),
                bead('z6', 'Prose2', 'also src/bar.ts'),
            ],
            // >150 bound
            Array.from({ length: 160 }, (_, i) => ({
                id: `z-bead-${String(i).padStart(3, '0')}`,
                title: `ZBead ${i}`,
                body: filesSection(['bound.ts']),
            })),
        ];
        for (const input of cases) {
            const result = computeHotspotMatrix(input);
            // HotspotMatrixSchema.parse throws on invalid; success if no throw
            expect(() => HotspotMatrixSchema.parse(result)).not.toThrow();
            // Verify parse produces identical value
            expect(HotspotMatrixSchema.parse(result)).toEqual(result);
        }
    });
});
//# sourceMappingURL=plan-simulation.hotspot.test.js.map