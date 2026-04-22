/**
 * Regression test: flywheel_review on a closed bead.
 *
 * Prior-session known bug: calling flywheel_review with action="skip" on a
 * bead that is already closed was producing a parse failure instead of a
 * structured already_closed error envelope.
 *
 * This test PROVES the fix is preserved in v3.4.0.
 *
 * Invariants:
 *   - action="skip" on a closed bead → FlywheelErrorCode 'already_closed',
 *     NOT a parse failure or unhandled exception.
 *   - The error envelope is a structured McpToolResult (isError:true).
 *   - The response content contains 'already_closed' in the text.
 *   - No throw from runReview.
 */
export {};
//# sourceMappingURL=already-closed-bead.test.d.ts.map