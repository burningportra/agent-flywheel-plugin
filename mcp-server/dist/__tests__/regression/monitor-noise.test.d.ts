/**
 * Regression test: shell-loop hygiene — transient non-zero exits from a
 * polling command must NOT cause spurious escalation.
 *
 * resilientExec is the wrapper in this codebase that runs repeated CLI calls
 * with retry logic. This test verifies:
 *   - 3 consecutive transient non-zero exits do NOT exceed the retry budget
 *     (i.e., they are retried until budget is exhausted, then return ok:false).
 *   - ok:false after budget exhaustion is NOT a throw — callers get a
 *     discriminated result to handle gracefully.
 *   - A single transient failure followed by success → ok:true.
 *   - The signal (AbortSignal) short-circuits the retry loop cleanly.
 */
export {};
//# sourceMappingURL=monitor-noise.test.d.ts.map