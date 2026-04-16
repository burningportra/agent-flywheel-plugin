import type { McpToolResult, ToolContext, VerifyBeadsArgs } from '../types.js';
import { type BeadStraggler } from '../beads.js';
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