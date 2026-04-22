/**
 * Chaos test: doctor running on a system with missing CLI dependencies.
 *
 * Invariants under test:
 *   - cm absent (CASS — optional) → yellow row, no throw, other checks still complete.
 *   - bv absent (optional) → yellow row.
 *   - br absent (required) → red row.
 *   - All three absence cases produce a Zod-valid DoctorReport.
 *   - Overall severity escalates correctly (yellow vs red).
 */
export {};
//# sourceMappingURL=missing-gemini.test.d.ts.map