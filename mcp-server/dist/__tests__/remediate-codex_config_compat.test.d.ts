/**
 * Backup-already-exists collision path for the codex_config_compat
 * remediation handler.
 *
 * Bead: claude-orchestrator-32py (reality-check-2026-05-15-followup).
 *
 * The handler writes a timestamped backup at
 * `~/.codex/config.toml.bak.<ms-precision-ISO>` before mutating the original.
 * ISO timestamps with millisecond precision make collisions extremely unlikely
 * in practice, but the code path that handles the collision was previously
 * untested. This file pins the behavior:
 *
 *   - `writeAtomic` uses `rename(2)` which on POSIX replaces an existing
 *     target atomically. So a backup-path collision is resolved by *silent
 *     overwrite* of the prior backup with the current original content.
 *     The handler still succeeds (`stepsRun: 2`), and the new backup
 *     contains the pre-mutation original.
 *
 * If the collision policy ever changes (suffix-increment, error-out, etc.),
 * this test will fail loudly and the new contract needs to be picked
 * deliberately.
 *
 * Happy-path / buildPlan / verifyProbe / parser-agreement coverage lives in
 * `__tests__/tools/remediate-codex-config.test.ts`; this file scopes
 * narrowly to the collision branch only.
 */
export {};
//# sourceMappingURL=remediate-codex_config_compat.test.d.ts.map