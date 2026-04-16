/**
 * Plan-to-Bead Coverage Dashboard
 *
 * The Flywheel guide: "Tell agents to go through each bead and explicitly
 * check it against the markdown plan. Or vice versa." This module makes
 * the "nothing lost in conversion" guarantee quantitative and visible.
 *
 * Two modes:
 * 1. Fast (keyword) — uses the existing auditPlanToBeads() from beads.ts
 * 2. Deep (LLM) — semantic scoring via sub-agent for higher accuracy
 *
 * The fast mode runs every approval cycle. The deep mode runs on demand
 * or when the fast mode detects gaps.
 */
import type { Bead } from './types.js';
export interface PlanSectionCoverage {
    /** Plan section heading. */
    heading: string;
    /** First ~150 chars of section content. */
    preview: string;
    /** Coverage score 0-100. */
    score: number;
    /** Bead IDs that address this section. */
    matchedBeadIds: string[];
    /** True if score < 50 (significant gap). */
    uncovered: boolean;
}
export interface PlanCoverageResult {
    /** Overall coverage score 0-100 (average of section scores). */
    overall: number;
    /** Per-section coverage. */
    sections: PlanSectionCoverage[];
    /** Sections with score < 50. */
    gaps: PlanSectionCoverage[];
    /** Number of plan sections analyzed. */
    totalSections: number;
    /** Number of sections with adequate coverage (score >= 50). */
    coveredSections: number;
}
export interface ParsedPlanSection {
    heading: string;
    body: string;
}
/**
 * Parse a markdown plan into sections by heading.
 * Groups content under each heading until the next heading of equal or higher level.
 */
export declare function parsePlanSections(plan: string): ParsedPlanSection[];
/**
 * Prompt for LLM-based semantic coverage scoring.
 * The LLM evaluates how well each plan section is covered by existing beads.
 */
export declare function planCoverageScoringPrompt(sections: ParsedPlanSection[], beads: Bead[]): string;
/**
 * Parse the LLM output from planCoverageScoringPrompt.
 */
export declare function parsePlanCoverageResult(output: string, sections: ParsedPlanSection[]): PlanCoverageResult;
/**
 * Convert the existing PlanToBeadAudit into a PlanCoverageResult.
 * This provides instant coverage feedback without an LLM call.
 */
export declare function coverageFromKeywordAudit(audit: import('./beads.js').PlanToBeadAudit): PlanCoverageResult;
/**
 * Format a PlanCoverageResult for display in the approval UI.
 */
export declare function formatPlanCoverage(result: PlanCoverageResult): string;
//# sourceMappingURL=plan-coverage.d.ts.map