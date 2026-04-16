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
export interface ModelTier {
    implementation: string;
    review: string;
    fallbacks?: string[];
}
/**
 * Classify a bead's complexity based on heuristics.
 * No LLM needed - runs in <1ms.
 */
export declare function classifyBeadComplexity(bead: Bead): {
    complexity: BeadComplexity;
    reason: string;
};
/**
 * Route a bead to the appropriate model tier.
 */
export declare function routeModel(bead: Bead, tiers?: Record<BeadComplexity, ModelTier>): ModelRoute;
/**
 * Route multiple beads and summarize the distribution.
 */
export declare function routeBeads(beads: Bead[]): {
    routes: Map<string, ModelRoute>;
    summary: {
        simple: number;
        medium: number;
        complex: number;
    };
};
/**
 * Format model routing summary for display.
 */
export declare function formatRoutingSummary(routes: Map<string, ModelRoute>, beads: Bead[]): string;
//# sourceMappingURL=model-routing.d.ts.map