/**
 * Self-Improvement Loop — Feedback & Prompt Tracking
 *
 * A. Post-flywheel feedback — structured survey saved after completion
 * B. Automatic CASS context injection — prepend relevant rules to prompts
 * C. Prompt effectiveness tracking — track which prompts produce real changes
 */
export interface FlywheelFeedback {
    /** ISO timestamp. */
    timestamp: string;
    /** The flywheel goal. */
    goal: string;
    /** Total beads created. */
    beadCount: number;
    /** Beads completed successfully. */
    completedCount: number;
    /** Total iteration rounds (gates). */
    totalRounds: number;
    /** Plan quality score (if computed). */
    planQualityScore?: number;
    /** Foregone conclusion score (if computed). */
    foregoneScore?: number;
    /** Polish rounds before bead approval. */
    polishRounds: number;
    /** Whether convergence was reached. */
    converged: boolean;
    /** Phases that triggered regression. */
    regressions: string[];
    /** Space violations detected. */
    spaceViolationCount: number;
}
/**
 * Compute aggregate stats from all feedback.
 */
export interface FeedbackStats {
    totalFlywheelRuns: number;
    avgBeadCount: number;
    avgCompletionRate: number;
    avgPolishRounds: number;
    convergenceRate: number;
    avgPlanQuality: number | null;
    avgForegoneScore: number | null;
}
/** Prepend CASS context to a prompt if available. */
export declare function withCassContext(prompt: string, cwd: string, taskDescription?: string): string;
export interface PromptRecord {
    /** Prompt identifier (e.g., "beadRefinement", "blunderHunt"). */
    name: string;
    /** Number of times this prompt was used. */
    uses: number;
    /** Total changes produced across all uses. */
    changesProduced: number;
    /** Number of uses that produced at least 1 change. */
    effectiveUses: number;
}
export interface ToolFeedback {
    toolName: string;
    sessionId?: string;
    timestamp: number;
    /** 1-5 rating */
    usability: number;
    /** 1-5 rating */
    ergonomics: number;
    /** What went well */
    strengths: string[];
    /** What was confusing or missing */
    weaknesses: string[];
    /** Specific suggestions */
    suggestions: string[];
}
//# sourceMappingURL=feedback.d.ts.map