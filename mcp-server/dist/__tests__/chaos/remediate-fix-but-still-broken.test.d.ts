/**
 * Chaos test: handler.execute returns success (exit 0) but verifyProbe says
 * the underlying condition is still broken. The dispatcher must surface
 * `verifiedGreen: false` and the handler must emit a warn-level log line.
 *
 * Scenario: dist_drift "build" succeeds but verifyProbe still detects drift
 * (we craft mtimes so newest src .ts is *newer* than newest dist file).
 */
export {};
//# sourceMappingURL=remediate-fix-but-still-broken.test.d.ts.map