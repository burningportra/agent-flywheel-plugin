/**
 * Unit specs for the codex_config_compat remediation handler.
 *
 * Bead: claude-orchestrator-3s58 (reality-check-2026-05-15).
 *
 * Coverage:
 *   1. Pure helper `commentOutTopLevelModel` — comments only the top-level
 *      `model = "..."` line; ignores lines inside `[sections]`; no-ops on
 *      already-commented or absent lines.
 *   2. buildPlan branches — missing file, no model, compatible model,
 *      incompatible model.
 *   3. execute path — writes a backup, atomically rewrites the original,
 *      backup contains the original content, original now has the line
 *      commented.
 *   4. execute is a no-op when the model is absent or compatible.
 *   5. verifyProbe flips green after a successful execute (round-trip via
 *      the doctor's pure parser).
 *   6. Parser/matcher agreement — the handler's matcher and the doctor's
 *      parser see the same set of "top-level model" lines.
 */
export {};
//# sourceMappingURL=remediate-codex-config.test.d.ts.map