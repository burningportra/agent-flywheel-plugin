import type { McpToolResult, ToolContext, AdvanceWaveArgs } from '../types.js';
import type { VerifyBeadsOutcome } from './verify-beads.js';
import { type ImplementerDispatch } from '../adapters/implementer-dispatch.js';
export interface AdvanceWaveOutcome {
    verification: VerifyBeadsOutcome;
    nextWave: ({
        beadIds: string[];
    } & ImplementerDispatch) | null;
    waveComplete: boolean;
    /**
     * Stage 1 attestation rollout flag. `true` when one or more closed beads
     * have missing or invalid completion attestation AND the
     * `FW_ATTESTATION_REQUIRED` env var is NOT set. Surfaces the warning to
     * the caller without blocking advance.
     *
     * When `FW_ATTESTATION_REQUIRED=1`, missing/invalid evidence becomes a
     * hard error (`attestation_missing` / `attestation_invalid`) instead.
     */
    needsEvidence: boolean;
    /**
     * Convergence-driven auto-approve recommendation (B-AC2 §12.4).
     *
     * `armed: true` when the active plan's convergence score ≥ 0.90 AND the
     * `flywheel.config.yaml > convergence.gate_advance_wave` kill-switch is on.
     * Per README §Design Philosophy #3 the *decision* is still the operator's
     * — this only surfaces a "Recommended" label for the next-wave question.
     * Never silent advancement.
     */
    convergence?: {
        armed: boolean;
        score: number | null;
        status: string | null;
        reason: 'auto_approve_recommended' | 'below_threshold' | 'no_state' | 'kill_switch_off' | 'no_active_plan';
    };
    /**
     * Set when `commitBatchThreshold` commits have landed since the batch-review
     * baseline. The wave still advances: the coordinator dispatches `nextWave`
     * as usual and sends one reviewer over `shaRange` alongside it, via
     * `flywheel_review(action: "batch_review", shaRange)`.
     */
    nextStep?: {
        kind: 'batch_review_due';
        /** HEAD at gate time, the end of the range. */
        reviewSha: string;
        /** `lastBatchReviewSha`, or `cycleStartSha` before the first review. */
        lastBaselineSha: string;
        /** `<lastBaselineSha>..<reviewSha>`, ready to pass to `flywheel_review`. */
        shaRange: string;
    };
    /** Batch reviews this call found in `pendingBatchReviews`: beads filed from
     *  verdicts that landed, and ranges still waiting on their reviewer. */
    batchReviews?: {
        filed: Array<{
            shaRange: string;
            beadIds: string[];
        }>;
        pending: string[];
    };
}
export declare function runAdvanceWave(ctx: ToolContext, args: AdvanceWaveArgs): Promise<McpToolResult>;
//# sourceMappingURL=advance-wave.d.ts.map