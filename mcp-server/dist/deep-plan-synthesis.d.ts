import type { DeepPlanResult } from "./deep-plan.js";
/**
 * Split a markdown document into sections keyed by normalized `## ` heading.
 *
 * - Content before the first `## ` heading is stored under the empty-string key
 *   (preamble), if non-empty.
 * - The returned map preserves insertion order (first-seen wins on duplicate
 *   headings — subsequent duplicates are appended to the existing section).
 * - Keys are the trimmed heading text (without the leading `## `).
 */
export declare function splitBySections(markdown: string): Map<string, string>;
/** Return true when the repo is large enough to benefit from section-wise mode. */
export declare function shouldUseSectionWise(repoFileCount: number): boolean;
export interface SynthesizeOptions {
    /** Force whole-file fallback concatenation instead of section-wise merge. */
    whole?: boolean;
}
/**
 * Prepare a merged plan from multiple planner outputs.
 *
 * This function is synchronous at heart but returns a Promise so the signature
 * matches the intended orchestration point (where real LLM synthesis could be
 * awaited). No model calls happen here.
 */
export declare function synthesizePlans(plans: DeepPlanResult[], opts?: SynthesizeOptions): Promise<string>;
//# sourceMappingURL=deep-plan-synthesis.d.ts.map