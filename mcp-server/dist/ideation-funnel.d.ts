/**
 * Externalized Ideation Funnel (30 → 5 → 15)
 *
 * The Flywheel guide: "Having agents brainstorm 30 then winnow to 5
 * produces much better results than asking for 5 directly because
 * the winnowing forces critical evaluation."
 *
 * When we tell a model "think of 30, output 5," the winnowing is
 * performative. When we have 30 real ideas and a DIFFERENT model
 * ranks them, the critical evaluation is real.
 *
 * Three phases:
 * 1. Generate 30 ideas (sub-agent, structured JSON output)
 * 2. Winnow to 5 (different model, explicit keep/cut for each)
 * 3. Expand to 15 (10 more, checked against existing beads)
 */
import type { RepoProfile, CandidateIdea, ScanResult } from './types.js';
/**
 * Prepended to winnowingPrompt() to enforce model divergence.
 * Using the same model for ideation and winnowing defeats the purpose:
 * winnowing becomes performative self-evaluation instead of real critique.
 */
export declare const WINNOWING_MODEL_NOTE: string;
/**
 * Prompt for generating 30 raw ideas. The model is told NOT to winnow —
 * output everything. Quantity enables quality in the next phase.
 *
 * @param existingBeadTitles - titles of existing beads to avoid duplicating.
 *   When provided and non-empty, a dedup section is injected before Instructions.
 */
export declare function broadIdeationPrompt(profile: RepoProfile, scanResult?: ScanResult, existingBeadTitles?: string[]): string;
/**
 * Prompt for a DIFFERENT model to critically evaluate and winnow 30→5.
 * The winnowing must be externalized — each idea gets explicit keep/cut.
 */
export declare function winnowingPrompt(ideas: CandidateIdea[], profile: RepoProfile): string;
/**
 * Prompt to generate 10 MORE ideas that complement the top 5.
 * Each must be checked against existing beads for novelty.
 */
export declare function expandIdeasPrompt(top5: CandidateIdea[], existingBeadTitles: string[], profile: RepoProfile): string;
/**
 * Parse a JSON array of ideas from LLM output.
 * Handles markdown fences, surrounding text, and partial outputs.
 */
export declare function parseIdeasJSON(output: string): CandidateIdea[];
/**
 * Parse winnowing results from LLM output.
 * Returns the IDs of the kept ideas in rank order.
 */
export declare function parseWinnowingResult(output: string): {
    keptIds: string[];
    cutCount: number;
};
//# sourceMappingURL=ideation-funnel.d.ts.map