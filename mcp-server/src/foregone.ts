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

// ─── Types ──────────────────────────────────────────────────

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

// ─── Score Computation ──────────────────────────────────────

export interface ForegoneInputs {
  /** Plan quality score (from Gap 1). Null if no plan was generated. */
  planQuality: PlanQualityScore | null;
  /** Bead polish convergence score (0-1 from computeConvergenceScore). */
  convergenceScore: number | null;
  /** Number of beads passing quality checks vs total open beads. */
  beadQualityPassRate: { passed: number; total: number } | null;
  /** bv graph insights. Null if bv unavailable. */
  graphInsights: BvInsights | null;
  /** Plan-to-bead coverage result. Null if no plan. */
  planCoverage: PlanCoverageResult | null;
}

/**
 * Compute the foregone conclusion score from all available signals.
 * Missing signals are scored at a neutral 50 (don't block, don't boost).
 */
export function computeForegoneScore(inputs: ForegoneInputs): ForegoneScore {
  const blockers: string[] = [];

  // ── 1. Plan readiness (20% weight) ──
  const planReady = inputs.planQuality?.overall ?? 50;
  if (planReady < 70 && inputs.planQuality) {
    blockers.push(`Plan quality ${planReady}/100 — refine the plan`);
  }

  // ── 2. Bead convergence (20% weight) ──
  const beadConvergence = inputs.convergenceScore != null
    ? Math.round(inputs.convergenceScore * 100)
    : 50;
  if (beadConvergence < 70 && inputs.convergenceScore != null) {
    blockers.push(`Bead polish not converged (${beadConvergence}%) — run more polish rounds`);
  }

  // ── 3. Bead structural quality (25% weight) ──
  let beadQuality = 50;
  if (inputs.beadQualityPassRate) {
    const { passed, total } = inputs.beadQualityPassRate;
    beadQuality = total > 0 ? Math.round((passed / total) * 100) : 100;
    if (beadQuality < 70) {
      const failing = total - passed;
      blockers.push(`${failing} of ${total} beads have quality issues — enrich descriptions`);
    }
  }

  // ── 4. Graph health (15% weight) ──
  let graphHealth = 50;
  if (inputs.graphInsights) {
    graphHealth = computeGraphHealthScore(inputs.graphInsights);
    if (graphHealth < 70) {
      const issues: string[] = [];
      if (inputs.graphInsights.Cycles && inputs.graphInsights.Cycles.length > 0) {
        issues.push(`${inputs.graphInsights.Cycles.length} cycle(s)`);
      }
      if (inputs.graphInsights.Orphans.length > 0) {
        issues.push(`${inputs.graphInsights.Orphans.length} orphan(s)`);
      }
      if (inputs.graphInsights.Articulation.length > 0) {
        issues.push(`${inputs.graphInsights.Articulation.length} bottleneck(s)`);
      }
      if (issues.length > 0) {
        blockers.push(`Graph issues: ${issues.join(", ")}`);
      }
    }
  }

  // ── 5. Plan coverage (20% weight) ──
  const planCoverage = inputs.planCoverage?.overall ?? 50;
  if (planCoverage < 70 && inputs.planCoverage) {
    const gapCount = inputs.planCoverage.gaps.length;
    blockers.push(`Plan coverage ${planCoverage}% — ${gapCount} section(s) not covered by beads`);
  }

  // ── Composite ──
  const overall = Math.round(
    planReady * 0.20 +
    beadConvergence * 0.20 +
    beadQuality * 0.25 +
    graphHealth * 0.15 +
    planCoverage * 0.20
  );

  const isForegonable = blockers.length === 0 && overall >= 80;

  const recommendation: ForegoneScore["recommendation"] =
    overall >= 80 && blockers.length === 0 ? "foregone"
    : overall >= 60 ? "almost"
    : "not_ready";

  return {
    overall,
    planReady,
    beadConvergence,
    beadQuality,
    graphHealth,
    planCoverage,
    blockers,
    isForegonable,
    recommendation,
  };
}

// ─── Graph Health Scoring ───────────────────────────────────

/**
 * Score graph health from bv insights (0-100).
 * Deductions: cycles (-40), orphans (-10 each, max -30), articulation points (-10 each, max -20).
 */
export function computeGraphHealthScore(insights: BvInsights): number {
  let score = 100;

  // Cycles are critical — immediate 40-point deduction
  if (insights.Cycles && insights.Cycles.length > 0) {
    score -= 40;
  }

  // Orphans: disconnected beads that no one depends on and depend on nothing
  if (insights.Orphans.length > 0) {
    score -= Math.min(insights.Orphans.length * 10, 30);
  }

  // Articulation points: single points of failure in the dependency graph
  if (insights.Articulation.length > 0) {
    score -= Math.min(insights.Articulation.length * 10, 20);
  }

  return Math.max(0, score);
}

// ─── Display Formatting ─────────────────────────────────────

/**
 * Format a ForegoneScore for display in the approval UI.
 */
export function formatForegoneScore(score: ForegoneScore): string {
  const bar = (value: number): string => {
    const filled = Math.round(value / 10);
    return "█".repeat(filled) + "░".repeat(10 - filled);
  };

  const header = score.recommendation === "foregone"
    ? `🎯 **Foregone Conclusion: ${score.overall}/100** — Ready to launch swarm!`
    : score.recommendation === "almost"
    ? `⚠️ **Readiness: ${score.overall}/100** — Almost there, ${score.blockers.length} blocker(s)`
    : `⛔ **Readiness: ${score.overall}/100** — Not ready for implementation`;

  const lines = [
    header,
    `  Plan Quality:    ${bar(score.planReady)} ${score.planReady}%`,
    `  Bead Convergence: ${bar(score.beadConvergence)} ${score.beadConvergence}%`,
    `  Bead Quality:    ${bar(score.beadQuality)} ${score.beadQuality}%`,
    `  Graph Health:    ${bar(score.graphHealth)} ${score.graphHealth}%`,
    `  Plan Coverage:   ${bar(score.planCoverage)} ${score.planCoverage}%`,
  ];

  if (score.blockers.length > 0) {
    lines.push("");
    lines.push("  **Blockers:**");
    for (const b of score.blockers) {
      lines.push(`  - ${b}`);
    }
  }

  return lines.join("\n");
}
