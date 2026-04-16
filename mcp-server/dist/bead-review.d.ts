import type { ExecFn } from './exec.js';
import type { Bead } from "./types.js";
export interface CrossModelReviewResult {
    suggestions: string[];
    rawOutput: string;
    model: string;
    error?: string;
    fallbackUsed?: boolean;
}
/**
 * Send beads to an alternative model for cross-model review.
 * Uses pi --print with a different model to get a fresh perspective.
 */
export declare function crossModelBeadReview(exec: ExecFn, cwd: string, beads: Bead[], goal: string, signal?: AbortSignal): Promise<CrossModelReviewResult>;
/**
 * Parse suggestions from model output.
 * Supports numbered lists, bullet points, markdown headers, and paragraph fallback.
 */
export declare function parseSuggestions(output: string): string[];
//# sourceMappingURL=bead-review.d.ts.map