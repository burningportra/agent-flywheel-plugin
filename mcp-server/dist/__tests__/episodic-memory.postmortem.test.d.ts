/**
 * Tests for draftPostmortem (I6 — post-mortem draft engine).
 *
 * Invariants under test (from docs/plans/2026-04-21-v3-4-0-synthesized.md
 * §4.Subsystem3):
 *   P-1 empty session         → warnings=['postmortem_empty_session'], no throw
 *   P-2 stale checkpoint      → warnings=['postmortem_checkpoint_stale'], uses fallback
 *   P-3 no auto-commit        → NEVER writes to CASS (spy cm/store: 0 calls)
 *   P-4 dual fallback         → sessionStartSha + merge-base both fail → HEAD~10..HEAD
 *   Happy-path                → commits + inbox → draft markdown contains everything
 *   Top error codes           → 7 codes → top-5 rendered, sorted by count
 *   G-1 Zod round-trip        → every return passes PostmortemDraftSchema.parse()
 */
export {};
//# sourceMappingURL=episodic-memory.postmortem.test.d.ts.map