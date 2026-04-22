/**
 * Cancellation contract for resilientExec (v3.4.0 F1).
 *
 * Aborting the supplied AbortSignal during the retry-delay window must:
 *   - stop resilientExec within one retry-delay (no unbounded sleep),
 *   - return `{ ok: false, error.lastError }`, and
 *   - have `classifyExecError(error.lastError)` yield `exec_aborted`.
 */
export {};
//# sourceMappingURL=cli-exec.abort.test.d.ts.map