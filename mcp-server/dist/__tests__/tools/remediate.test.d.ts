/**
 * T15 — Unit specs for `runRemediate` (mcp-server/src/tools/remediate.ts).
 *
 * Coverage targets:
 *   1. Schema validation rejects unknown checkName.
 *   2. Table-driven exhaustiveness over DOCTOR_CHECK_NAMES — every name in
 *      REMEDIATION_REGISTRY is exercised. `null` registry entries return the
 *      `remediation_unavailable` envelope; populated entries return a valid
 *      RemediationResult for both dry_run and execute modes.
 *   3. Mutating handler in execute mode WITHOUT autoConfirm returns the
 *      `remediation_requires_confirm` envelope.
 *   4. dry_run never invokes exec (the dispatcher must short-circuit before
 *      calling handler.execute).
 *   5. Idempotent re-run of a non-mutating handler is a no-op (no exec calls
 *      beyond verifyProbe — but we observe `executed:true`/`stepsRun:0`).
 */
export {};
//# sourceMappingURL=remediate.test.d.ts.map