import type { McpToolResult, ToolContext, VerifyBeadsArgs } from '../types.js';
import { type BeadStraggler } from '../beads.js';
/**
 * One entry per bead whose attestation failed schema or cross-bead validation.
 * `code` is the underlying read/validate error code; downstream `advance-wave`
 * surfaces this in its `attestation_invalid` error envelope.
 */
export type InvalidEvidenceCode = 'invalid_json' | 'schema_invalid' | 'bead_id_mismatch' | 'closed_without_verification' | 'path_escapes_cwd' | 'status_mismatch';
export interface InvalidEvidenceEntry {
    beadId: string;
    code: InvalidEvidenceCode;
    message: string;
}
export interface VerifyBeadsOutcome {
    /** Bead IDs that `br show` confirms as closed. */
    verified: string[];
    /** Bead IDs that were stragglers but had a matching commit and were auto-closed. */
    autoClosed: Array<{
        beadId: string;
        commit: string;
    }>;
    /** Bead IDs that are still open and have no matching commit — needs human attention. */
    unclosedNoCommit: BeadStraggler[];
    /** Bead IDs whose `br show` failed, mapped to error message. */
    errors: Record<string, string>;
    /**
     * Bead IDs that are closed (or auto-closed) but have no
     * `.pi-flywheel/completion/<beadId>.json` attestation file.
     *
     * Stage 1 surface — `flywheel_advance_wave` warns by default and only blocks
     * when `FW_ATTESTATION_REQUIRED=1`. Empty array means every closed bead has
     * a present attestation file (parse/validation status reported separately
     * in `invalidEvidence`).
     */
    missingEvidence: string[];
    /**
     * Bead IDs whose attestation file exists but failed schema or cross-bead
     * validation. See `InvalidEvidenceEntry.code` for the specific failure.
     *
     * Empty array means every present attestation parsed cleanly and matched
     * its bead.
     */
    invalidEvidence: InvalidEvidenceEntry[];
}
/**
 * flywheel_verify_beads — Reconcile a wave of beads after impl agents report back.
 *
 * For each bead ID:
 *   - if `br show` reports `closed`, count as verified.
 *   - if still open / in_progress / deferred, look for a commit referencing the
 *     bead ID via `git log --grep=<id> -1`. If a commit exists, run
 *     `br update --status closed` and record under `autoClosed`. If no commit
 *     exists, record under `unclosedNoCommit`.
 *   - if `br show` errors, record under `errors`.
 *
 * Updates `state.beadResults` for any newly-closed beads so subsequent
 * `flywheel_review` calls short-circuit cleanly.
 */
export declare function runVerifyBeads(ctx: ToolContext, args: VerifyBeadsArgs): Promise<McpToolResult>;
//# sourceMappingURL=verify-beads.d.ts.map