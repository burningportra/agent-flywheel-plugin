/**
 * Chaos test: abort `runRemediate` mid-execute and verify the lock file is
 * cleaned up so a follow-up call succeeds.
 *
 * Invariants:
 *   - Aborting during handler.execute releases the in-process mutex AND
 *     unlinks `.pi-flywheel/remediate.lock`.
 *   - A second call after abort completes successfully (no stale lock).
 *   - The first call's result is a `remediation_failed` envelope (caught by
 *     the dispatcher's execute try/catch) — not a thrown promise.
 */
export {};
//# sourceMappingURL=remediate-kill-midrun.test.d.ts.map