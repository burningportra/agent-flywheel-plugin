/**
 * Cost-Aware Model Routing
 *
 * Not every bead needs the most expensive model. A simple doc update
 * doesn't need Opus. But architectural integration does. This module
 * classifies bead complexity and routes to the appropriate model tier.
 *
 * Review passes always use a DIFFERENT model than implementation
 * to enforce the Flywheel's "different models have different tastes
 * and blind spots" principle.
 */

import type { Bead } from "./types.js";
import { MODEL_ROUTING_TIERS } from "./prompts.js";

// ─── Types ──────────────────────────────────────────────────

export type BeadComplexity = "simple" | "medium" | "complex";

export interface ModelRoute {
  /** Model for implementing the bead. */
  implementation: string;
  /** Model for reviewing (forced diversity - different from implementation). */
  review: string;
  /** Complexity classification. */
  complexity: BeadComplexity;
  /** Reasoning for the classification. */
  reason: string;
}

// ─── Model Tiers ────────────────────────────────────────────

export interface ModelTier {
  implementation: string;
  review: string;
  fallbacks?: string[];  // for future use
}

const DEFAULT_TIERS: Record<BeadComplexity, ModelTier> = {
  simple: {
    implementation: MODEL_ROUTING_TIERS.simple.implementation,
    review: MODEL_ROUTING_TIERS.simple.review,
  },
  medium: {
    implementation: MODEL_ROUTING_TIERS.medium.implementation,
    review: MODEL_ROUTING_TIERS.medium.review,
  },
  complex: {
    implementation: MODEL_ROUTING_TIERS.complex.implementation,
    review: MODEL_ROUTING_TIERS.complex.review,
  },
};

// ─── Tier Validation ───────────────────────────────────────

function validateModelTier(tier: ModelTier, label: string): boolean {
  if (!tier.implementation || !tier.review) {
    process.stderr.write(`[model-routing] WARNING: tier "${label}" has empty implementation or review model — falling back to DEFAULT_TIERS\n`);
    return false;
  }
  return true;
}

// ─── Complexity Classification ──────────────────────────────

/** Signals that indicate higher complexity. */
const COMPLEXITY_SIGNALS = [
  /architect/i,
  /integrat/i,
  /migrat/i,
  /security/i,
  /auth(?:entication|orization)/i,
  /concurrent/i,
  /distribut/i,
  /cross-cutting/i,
  /refactor.*major/i,
  /breaking.change/i,
  /state.machine/i,
  /protocol/i,
  /crypt/i,
] as const;

/** Signals that indicate lower complexity. */
const SIMPLICITY_SIGNALS = [
  /readme/i,
  /changelog/i,
  /doc(?:s|umentation)/i,
  /typo/i,
  /rename/i,
  /config/i,
  /bump.version/i,
  /update.dep/i,
  /lint/i,
  /format/i,
  /comment/i,
] as const;

/**
 * Extract the files listed in a bead's description.
 */
function extractFileCount(bead: Bead): number {
  const desc = bead.description ?? "";
  const filesSection = desc.match(/###\s*Files:\s*([^\n#]+(?:\n(?!###)[^\n#]*)*)/);
  if (!filesSection) return 0;
  return filesSection[1]
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /\.\w+$/.test(s))
    .length;
}

/**
 * Classify a bead's complexity based on heuristics.
 * No LLM needed - runs in <1ms.
 */
export function classifyBeadComplexity(bead: Bead): { complexity: BeadComplexity; reason: string } {
  const desc = bead.description ?? "";
  const title = bead.title ?? "";
  const text = `${title} ${desc}`;
  const descLength = desc.length;
  const fileCount = extractFileCount(bead);

  let score = 0;
  const reasons: string[] = [];

  // Description length
  if (descLength > 2000) {
    score += 2;
    reasons.push("long description");
  } else if (descLength > 500) {
    score += 1;
  }

  // File count
  if (fileCount > 5) {
    score += 2;
    reasons.push(`${fileCount} files`);
  } else if (fileCount > 2) {
    score += 1;
  }

  // Priority (P0/P1 = likely more complex)
  if (typeof bead.priority === "number" && !Number.isNaN(bead.priority) && bead.priority <= 1) {
    score += 1;
    reasons.push("high priority");
  }

  // Complexity signals in text
  const complexMatches = COMPLEXITY_SIGNALS.filter((p) => p.test(text));
  if (complexMatches.length > 0) {
    score += Math.min(complexMatches.length, 3);
    reasons.push(`complexity signals: ${complexMatches.length}`);
  }

  // Simplicity signals (negative score)
  const simpleMatches = SIMPLICITY_SIGNALS.filter((p) => p.test(text));
  if (simpleMatches.length > 0) {
    score -= Math.min(simpleMatches.length, 3);
    reasons.push(`simplicity signals: ${simpleMatches.length}`);
  }

  // Classify
  if (score >= 4) {
    return { complexity: "complex", reason: reasons.join(", ") || "high overall score" };
  }
  if (score >= 2) {
    return { complexity: "medium", reason: reasons.join(", ") || "moderate overall score" };
  }
  return { complexity: "simple", reason: reasons.join(", ") || "low overall score" };
}

// ─── Routing ────────────────────────────────────────────────

/**
 * Route a bead to the appropriate model tier.
 */
export function routeModel(bead: Bead, tiers?: Record<BeadComplexity, ModelTier>): ModelRoute {
  const { complexity, reason } = classifyBeadComplexity(bead);
  const tierMap = tiers ?? DEFAULT_TIERS;

  let tier = tierMap[complexity];

  // Validate the resolved tier; fall back to DEFAULT_TIERS if invalid or missing
  if (!tier || !validateModelTier(tier, complexity)) {
    process.stderr.write(`[model-routing] falling back to DEFAULT_TIERS["${complexity}"]\n`);
    tier = DEFAULT_TIERS[complexity];

    // Ultimate fallback to medium if DEFAULT_TIERS entry also fails (shouldn't happen)
    if (!validateModelTier(tier, `DEFAULT:${complexity}`)) {
      process.stderr.write(`[model-routing] DEFAULT_TIERS["${complexity}"] also invalid — using DEFAULT_TIERS["medium"]\n`);
      tier = DEFAULT_TIERS.medium;
    }
  }

  return {
    implementation: tier.implementation,
    review: tier.review,
    complexity,
    reason,
  };
}

/**
 * Route multiple beads and summarize the distribution.
 */
export function routeBeads(beads: Bead[]): {
  routes: Map<string, ModelRoute>;
  summary: { simple: number; medium: number; complex: number };
} {
  const routes = new Map<string, ModelRoute>();
  const summary = { simple: 0, medium: 0, complex: 0 };

  for (const bead of beads) {
    const route = routeModel(bead);
    routes.set(bead.id, route);
    summary[route.complexity]++;
  }

  return { routes, summary };
}

// ─── Display ────────────────────────────────────────────────

/**
 * Format model routing summary for display.
 */
export function formatRoutingSummary(
  routes: Map<string, ModelRoute>,
  beads: Bead[]
): string {
  if (routes.size === 0) return "";

  const summary = { simple: 0, medium: 0, complex: 0 };
  for (const route of routes.values()) {
    summary[route.complexity]++;
  }

  const total = routes.size;
  const lines = [
    `Model Routing (${total} beads)`,
    `  Simple:  ${summary.simple} bead${summary.simple !== 1 ? "s" : ""} -> fast model (haiku-class)`,
    `  Medium:  ${summary.medium} bead${summary.medium !== 1 ? "s" : ""} -> balanced model (sonnet-class)`,
    `  Complex: ${summary.complex} bead${summary.complex !== 1 ? "s" : ""} -> strongest model (opus-class)`,
  ];

  // Show the complex beads specifically
  const complexBeads = beads.filter((b) => routes.get(b.id)?.complexity === "complex");
  if (complexBeads.length > 0 && complexBeads.length <= 5) {
    lines.push("  Complex beads:");
    for (const b of complexBeads) {
      const route = routes.get(b.id)!;
      lines.push(`    - ${b.id}: ${b.title} (${route.reason})`);
    }
  }

  return lines.join("\n");
}
