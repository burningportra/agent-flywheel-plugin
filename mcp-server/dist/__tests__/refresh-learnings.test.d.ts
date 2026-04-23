/**
 * Tests for the compound-engineering refresh sweep (bead `bve`).
 *
 * Invariants under test:
 *   R-1: Delete is NEVER emitted without staleProbe AND a high stale score.
 *   R-2: scoreOverlap is symmetric (a,b) === (b,a).
 *   R-3: refreshLearnings does NOT mutate input docs (we don't even hand it
 *        any — but classifyGroup re-uses the input array; we assert).
 *   R-4: Replace requires staleProbe AND consolidate-level overlap.
 *   parser: round-trips a renderSolutionDoc-shaped string.
 *   archive directory paths are skipped during the sweep.
 *   unparseable docs surface in `unparseable[]` and never abort the sweep.
 */
export {};
//# sourceMappingURL=refresh-learnings.test.d.ts.map