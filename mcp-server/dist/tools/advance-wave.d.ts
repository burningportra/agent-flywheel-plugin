import type { McpToolResult, ToolContext, AdvanceWaveArgs } from '../types.js';
import type { VerifyBeadsOutcome } from './verify-beads.js';
import { type BeadComplexity } from '../model-routing.js';
declare const LANES: readonly ["cc", "cod", "gem"];
type Lane = typeof LANES[number];
export interface AdvanceWaveOutcome {
    verification: VerifyBeadsOutcome;
    nextWave: {
        beadIds: string[];
        prompts: Array<{
            beadId: string;
            lane: Lane;
            prompt: string;
        }>;
        complexity: Record<string, BeadComplexity>;
    } | null;
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
     * v3.17.0 fresh-eyes auto-trigger (plan
     * `docs/plans/2026-05-13-fresh-eyes-auto-trigger.md`). When set, the
     * coordinator MUST dispatch a fresh-eyes review over `lastBaselineSha..
     * reviewSha` before advancing to the next wave. `nextWave` is `null` in
     * this case and `waveComplete` is `false` — the wave isn't done until
     * the review verdict lands.
     */
    nextStep?: {
        kind: 'batch_review_due';
        /** HEAD sha captured at gate time (dispatch baseline — risk #3). */
        reviewSha: string;
        /** Prior baseline; undefined on the very first batch review of the session. */
        lastBaselineSha?: string;
    };
}
export declare function runAdvanceWave(ctx: ToolContext, args: AdvanceWaveArgs): Promise<McpToolResult>;
export {};
//# sourceMappingURL=advance-wave.d.ts.map