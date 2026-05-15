/**
 * codex_config_compat remediation — comment out the top-level
 * `model = "gpt-5*"` / `"o4-mini*"` line in ~/.codex/config.toml that breaks
 * the codex-companion app-server on ChatGPT-account auth (bead `cif`,
 * surfaced by the same-named doctor check).
 *
 * Strategy:
 *   1. Read ~/.codex/config.toml. Locate the same top-level `model = "..."`
 *      line the doctor parser finds — bail green if it's absent / commented /
 *      below a `[section]` / set to a compatible model.
 *   2. Write a timestamped backup (`config.toml.bak.<iso-ts>`) BEFORE mutating
 *      the original. Hard-fails the run if the backup write fails so we never
 *      mutate without recovery.
 *   3. Atomically rewrite the config with that exact line prefixed by `# ` so
 *      the codex-companion app-server falls through to its built-in default.
 *      Untouched lines are byte-stable.
 *   4. verifyProbe re-reads the file via `parseCodexConfigTopLevelModel` and
 *      asserts the offending model is gone (either null or now compatible).
 *
 * Reversible: `mv ~/.codex/config.toml.bak.<ts> ~/.codex/config.toml` restores
 * the pre-remediation state. Backup files are never auto-deleted.
 *
 * Mutating, reversible. Refuses `autoConfirm:false` in execute mode (enforced
 * by the dispatcher in remediate.ts).
 *
 * Bead: claude-orchestrator-3s58 (reality-check-2026-05-15).
 */
import type { RemediationHandler } from '../remediate.js';
interface RewriteResult {
    rewritten: string;
    /** Original line, untrimmed; null if no rewrite happened. */
    changedLine: string | null;
    /** 1-based line number, or null if no change. */
    changedLineNumber: number | null;
}
/**
 * Comment out the first top-level (pre-`[section]`) `model = "..."` line.
 * Returns the rewritten content and a small audit envelope. If no eligible
 * line is found (already commented, below a section header, or absent), the
 * content is returned unchanged with `changedLine: null`.
 *
 * Exported for unit-test access.
 */
export declare function commentOutTopLevelModel(content: string): RewriteResult;
export declare const codexConfigCompatHandler: RemediationHandler;
export {};
//# sourceMappingURL=codex_config_compat.d.ts.map