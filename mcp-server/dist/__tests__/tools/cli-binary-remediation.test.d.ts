/**
 * Regression spec for bead claude-orchestrator-2eg —
 * cli_binary remediation handlers (br/bv/ntm/cm).
 *
 * Verifies:
 *   1. Each of the four flywheel-owned CLI checks has a registered handler
 *      (no longer null in REMEDIATION_REGISTRY).
 *   2. buildPlan returns the canonical curl|bash installer for each binary,
 *      mirroring commands/flywheel-setup.md.
 *   3. execute shells out via `bash -lc <installer>` so login PATH is
 *      honoured (cargo/.local/bin/brew shellenv).
 *   4. verifyProbe re-checks `<binary> --version` (with --help fallback) and
 *      returns true only when the binary actually resolves on PATH.
 *   5. Mutating dry_run is accepted; mutating execute without autoConfirm is
 *      rejected with `remediation_requires_confirm`.
 */
export {};
//# sourceMappingURL=cli-binary-remediation.test.d.ts.map