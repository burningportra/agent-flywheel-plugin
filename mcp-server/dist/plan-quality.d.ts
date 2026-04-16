/**
 * Plan Quality Oracle
 *
 * Scores plans on 5 dimensions and gates the plan→bead transition.
 * If the score is too low, the plan gets sent back for refinement.
 */
export interface PlanQualityScore {
    /** Overall composite score 0-100 (weighted average of dimensions). */
    overall: number;
    /** User-facing workflows with step-by-step detail (0-100). */
    workflows: number;
    /** Failure modes and edge cases explicitly addressed (0-100). */
    edgeCases: number;
    /** Architectural decisions with rationale, not bare assertions (0-100). */
    architecture: number;
    /** Types, signatures, params — concrete vs vague (0-100). */
    specificity: number;
    /** Test cases derivable from the plan (0-100). */
    testability: number;
    /** Sections that dragged the score down. */
    weakSections: string[];
    /** Gate recommendation. */
    recommendation: "block" | "warn" | "proceed";
}
/**
 * Prompt for LLM-based plan quality scoring.
 * Returns structured JSON that can be parsed by parsePlanQualityScore().
 */
export declare function planQualityScoringPrompt(plan: string, goal: string): string;
/**
 * Parse the LLM output from planQualityScoringPrompt into a PlanQualityScore.
 * Handles common LLM output quirks (markdown fences, extra text around JSON).
 */
export declare function parsePlanQualityScore(output: string): PlanQualityScore | null;
/**
 * Format a PlanQualityScore for display in the approval UI.
 */
export declare function formatPlanQualityScore(score: PlanQualityScore): string;
//# sourceMappingURL=plan-quality.d.ts.map