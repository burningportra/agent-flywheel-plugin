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
export {};
//# sourceMappingURL=hotspot-prose-only.test.d.ts.map