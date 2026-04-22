/**
 * Chaos test: two draftPostmortem calls racing on the same session context.
 *
 * Invariants under test (determinism, I6):
 *   - Both Promise.all results resolve to valid PostmortemDraft objects.
 *   - Both drafts are byte-equal (same markdown, same warnings).
 *   - No throw from either invocation.
 *   - Each draft passes PostmortemDraftSchema.parse().
 */
export {};
//# sourceMappingURL=postmortem-concurrent.test.d.ts.map