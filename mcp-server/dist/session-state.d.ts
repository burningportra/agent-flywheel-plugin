/**
 * Session-state detection and resumption helpers.
 *
 * Determines which flywheel stage the user is in — even after a cold
 * session restart where `oc.state.phase` may have been reset to "idle" —
 * by cross-checking the persisted state against on-disk evidence:
 *   • bead statuses from `br list`
 *   • presence of a plan artifact
 *   • presence of a repo profile
 *
 * The result is a rich `SessionStage` that:
 *   - labels the phase in plain language
 *   - summarises what was completed vs. what remains
 *   - provides the exact follow-up message to resume from that stage
 *   - rates its own confidence (high / medium / low)
 */
import type { FlywheelPhase, FlywheelState, Bead } from "./types.js";
export interface SessionStage {
    /** Resolved phase — may be inferred rather than taken verbatim from state. */
    phase: FlywheelPhase;
    /** Short, human-readable phase title. */
    label: string;
    /** Leading emoji for the phase (used in UI labels). */
    emoji: string;
    /** Goal the user was pursuing, if known. */
    goal?: string;
    /** Artifact path for the plan document, if one exists. */
    planDocument?: string;
    /** Bead ID that was in-progress when the session ended, if any. */
    currentBeadId?: string;
    /** Number of beads that are open or in-progress. */
    openBeadCount: number;
    /** Number of beads that have been closed (completed). */
    completedBeadCount: number;
    /** Total beads tracked (open + in-progress + closed + deferred). */
    totalBeadCount: number;
    /** One-line "what to do next" hint for the menu prompt. */
    nextAction: string;
    /** Full follow-up message to send to the agent when the user picks Resume. */
    resumePrompt: string;
    /**
     * How confident the detection is.
     * "high"   → taken directly from a non-idle persisted phase.
     * "medium" → inferred from on-disk bead/plan evidence.
     * "low"    → best-guess from partial signals only.
     */
    confidence: "high" | "medium" | "low";
    /** Human-readable list of signals used to reach this conclusion. */
    inferredFrom: string[];
}
/**
 * Detect the current flywheel stage from persisted state + live bead data.
 *
 * Resolution order:
 * 1. If `state.phase` is a concrete non-idle phase → use it (confidence: "high")
 * 2. Else, infer from on-disk evidence:
 *    a. in-progress beads → implementing
 *    b. open beads + plan doc → awaiting_bead_approval / implementing
 *    c. open beads, no plan doc → implementing
 *    d. repoProfile but no beads → discovering
 *    e. nothing → idle
 */
export declare function detectSessionStage(state: FlywheelState, beads: Bead[]): SessionStage;
/**
 * Builds the multi-line header string shown inside the `/start` select
 * prompt when an existing session is detected.
 *
 * Example output:
 * ```
 * ⚙️ Phase:     Implementing (3/8 beads done)
 * 🎯 Goal:      Add dark mode support
 * 🔩 Current:   br-5 "Update CSS variables…" (in-progress)
 * 📋 Plan:      research/dark-mode-proposal.md
 * 🔎 Detected:  persisted phase "implementing" (high confidence)
 * ```
 */
export declare function formatSessionContext(stage: SessionStage, currentBeadTitle?: string): string;
/**
 * Builds the label for the "Resume" menu option, adapted to the current stage.
 * e.g. "📂 Resume implementing — br-5 in-progress, 2 more queued"
 */
export declare function buildResumeLabel(stage: SessionStage): string;
//# sourceMappingURL=session-state.d.ts.map