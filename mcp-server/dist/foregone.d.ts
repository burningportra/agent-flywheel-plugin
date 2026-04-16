/**
 * Foregone Conclusion Detector
 *
 * The Flywheel guide: "Once you have the beads in good shape based on
 * a great markdown plan, I almost view the project as a foregone
 * conclusion at that point."
 *
 * This module computes a composite score from 5 dimensions that answers:
 * "Are the plan and beads good enough that a swarm of fungible agents
 * could execute them mechanically?"
 *
 * When all dimensions are green, the system signals confidence to stop
 * planning and start building.
 */
import type { PlanCoverageResult } from './plan-coverage.js';
import type { BvInsights } from './types.js';
export interface PlanQualityScore {
    overall: number;
    [key: string]: unknown;
}
export interface ForegoneScore {
    /** Overall composite score 0-100. */
    overall: number;
    /** Plan quality dimension 0-100 (from Plan Quality Oracle). */
    planReady: number;
    /** Bead polish convergence 0-100. */
    beadConvergence: number;
    /** Bead structural quality 0-100 (from qualityCheckBeads pass rate). */
    beadQuality: number;
    /** Dependency graph health 0-100 (from bv insights). */
    graphHealth: number;
    /** Plan-to-bead coverage 0-100. */
    planCoverage: number;
    /** Human-readable reasons we're not foregone yet. */
    blockers: string[];
    /** True if all dimensions >= 70 and no critical blockers. */
    isForegonable: boolean;
    /** Gate recommendation. */
    recommendation: "not_ready" | "almost" | "foregone";
}
export interface ForegoneInputs {
    /** Plan quality score (from Gap 1). Null if no plan was generated. */
    planQuality: PlanQualityScore | null;
    /** Bead polish convergence score (0-1 from computeConvergenceScore). */
    convergenceScore: number | null;
    /** Number of beads passing quality checks vs total open beads. */
    beadQualityPassRate: {
        passed: number;
        total: number;
    } | null;
    /** bv graph insights. Null if bv unavailable. */
    graphInsights: BvInsights | null;
    /** Plan-to-bead coverage result. Null if no plan. */
    planCoverage: PlanCoverageResult | null;
}
/**
 * Compute the foregone conclusion score from all available signals.
 * Missing signals are scored at a neutral 50 (don't block, don't boost).
 */
export declare function computeForegoneScore(inputs: ForegoneInputs): ForegoneScore;
/**
 * Score graph health from bv insights (0-100).
 * Deductions: cycles (-40), orphans (-10 each, max -30), articulation points (-10 each, max -20).
 */
export declare function computeGraphHealthScore(insights: BvInsights): number;
/**
 * Format a ForegoneScore for display in the approval UI.
 */
export declare function formatForegoneScore(score: ForegoneScore): string;
//# sourceMappingURL=foregone.d.ts.map