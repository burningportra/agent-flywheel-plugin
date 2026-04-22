/**
 * Chaos test: abort the doctor check sweep at check 5 (mid-sweep).
 *
 * Invariants under test:
 *   - Aborting mid-sweep yields partial:true — report is never corrupted.
 *   - Completed checks appear in the report; the hanging check is absent or
 *     appears as an aborted entry.
 *   - Overall severity reflects the partial state (red or the computed severity).
 *   - runDoctorChecks never throws regardless of abort timing.
 *   - elapsedMs is bounded (< real hang duration).
 */
export {};
//# sourceMappingURL=doctor-kill-midrun.test.d.ts.map