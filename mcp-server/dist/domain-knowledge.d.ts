/**
 * Domain-Specific Prompt Enhancement
 *
 * Sharpens review prompts with stack-specific checklist items based on the
 * profiler's detected tech stack (e.g., stale closures for React, unwrap()
 * in non-test Rust code).
 */
import type { RepoProfile } from "./types.js";
export interface DomainChecklist {
    /** Primary language this checklist targets. */
    language: string;
    /** Optional framework specialization. */
    framework?: string;
    /** Extra items appended to blunder hunt prompts. */
    blunderHuntItems: string[];
    /** Extra items appended to adversarial review prompts. */
    reviewItems: string[];
    /** Common anti-patterns specific to this stack. */
    antiPatterns: string[];
}
/**
 * Find the best-matching domain checklist for a repo profile.
 * Prefers language+framework match, falls back to language-only.
 * Returns null if no checklist matches the project's stack.
 */
export declare function getDomainChecklist(profile: RepoProfile): DomainChecklist | null;
/**
 * Format a domain checklist's blunder hunt items as a numbered list
 * suitable for appending to a blunder hunt prompt.
 */
export declare function formatDomainBlunderItems(checklist: DomainChecklist): string;
/**
 * Format a domain checklist's review items as a numbered list
 * suitable for appending to review prompts.
 */
export declare function formatDomainReviewItems(checklist: DomainChecklist): string;
//# sourceMappingURL=domain-knowledge.d.ts.map