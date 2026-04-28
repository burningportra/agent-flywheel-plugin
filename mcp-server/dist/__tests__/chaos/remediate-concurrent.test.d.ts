/**
 * Chaos test: two concurrent `runRemediate` calls for the same checkName.
 *
 * Invariants:
 *   - Exactly one call wins; the other returns `remediate_already_running`.
 *   - The losing call surfaces the structured-error envelope, never throws.
 *   - After the winner completes, lock is released and a third call succeeds.
 */
export {};
//# sourceMappingURL=remediate-concurrent.test.d.ts.map