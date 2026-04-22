/**
 * Chaos test: two processes flushing telemetry concurrently to the same spool file.
 *
 * The dual-session sequential merge is already tested in telemetry.test.ts.
 * This file extends coverage with:
 *   - Rapid successive flush calls (no gap between sessions).
 *   - Validation that the spool is always Zod-valid after concurrent operations.
 *   - Counts are the SUM of both sessions (no overwrite, no lost events).
 *   - Spool file is never half-written (no JSON parse error).
 */
export {};
//# sourceMappingURL=telemetry-dual-session.test.d.ts.map