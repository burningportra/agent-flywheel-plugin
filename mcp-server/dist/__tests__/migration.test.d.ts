/**
 * Migration safety — v3.12.x checkpoints continue to load under v3.13.0.
 *
 * The v3.13.0 outcome-grading additions (T4) appended 6 optional fields to
 * `FlywheelState`. Existing checkpoints written by v3.11.x and v3.12.x
 * lack those fields entirely. This test loads a frozen v3.12.0 fixture
 * through the production `readCheckpoint` path and asserts:
 *
 *   1. The load succeeds (envelope returned, not null).
 *   2. The fixture's `stateHash` validates against the original state shape
 *      — i.e. we did not silently mutate the schema.
 *   3. All 6 new outcome-grading fields read as `undefined`.
 *   4. `getMaxOutcomeIterations` falls back to the documented default.
 *
 * Bead: claude-orchestrator-2xn (T17).
 */
export {};
//# sourceMappingURL=migration.test.d.ts.map