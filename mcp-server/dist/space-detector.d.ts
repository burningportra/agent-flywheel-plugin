/**
 * Wrong-Space Detector
 *
 * Detects when an agent is doing plan-space work in code-space.
 * Three heuristics (all fast, no LLM):
 * 1. Architecture invention — files modified outside bead's ### Files
 * 2. Scope creep — files changed >> bead's file list
 * 3. Uncertainty language — hedging in implementation summary
 */
import type { Bead } from "./types.js";
export type SpaceViolationType = "architecture_invention" | "scope_creep" | "uncertainty";
export type SpaceViolationSeverity = "info" | "warning" | "critical";
export interface SpaceViolation {
    type: SpaceViolationType;
    severity: SpaceViolationSeverity;
    evidence: string;
    suggestion: string;
}
/**
 * Extract expected files from a bead's description.
 * Looks for ### Files: section and inline file references.
 * Returns normalized paths (no leading ./ or /).
 */
export declare function extractBeadFiles(bead: Bead): string[];
/**
 * Count uncertainty signals in text.
 * Returns the number of distinct pattern matches.
 */
export declare function countUncertaintySignals(text: string): number;
/**
 * Detect space violations after a bead implementation.
 * All heuristic — no LLM calls, runs in <1ms.
 *
 * @param bead The bead that was just implemented
 * @param summary The agent's implementation summary
 * @param feedback The agent's review feedback
 * @param filesChanged Files changed according to git diff (paths relative to repo root)
 */
export declare function detectSpaceViolations(bead: Bead, summary: string, feedback: string, filesChanged: string[]): SpaceViolation[];
/**
 * Format space violations for display in the review UI.
 */
export declare function formatSpaceViolations(violations: SpaceViolation[]): string;
//# sourceMappingURL=space-detector.d.ts.map