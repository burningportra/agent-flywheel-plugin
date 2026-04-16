/**
 * Automatic Bead Splitting for Parallelism
 *
 * When bv reports high-betweenness beads (bottlenecks), proposes splits
 * by analyzing descriptions for independently implementable sub-tasks
 * with disjoint file ownership.
 */
import type { Bead, BvInsights } from "./types.js";
export interface SplitChild {
    /** Proposed title for the child bead. */
    title: string;
    /** Proposed description including scope and acceptance criteria. */
    description: string;
    /** Files this child bead owns (disjoint from siblings). */
    files: string[];
}
export interface SplitProposal {
    /** ID of the bead to split. */
    originalBeadId: string;
    /** Title of the bead to split. */
    originalTitle: string;
    /** Betweenness centrality score from bv. */
    betweennessScore: number;
    /** Number of beads that depend on paths through this one. */
    dependentCount: number;
    /** Proposed child beads. */
    children: SplitChild[];
    /** Whether the bead can be split (false if inherently sequential). */
    splittable: boolean;
    /** Reason if not splittable. */
    reason?: string;
}
/**
 * Identify beads that should be split based on bv insights.
 * A bead is a split candidate if its betweenness centrality >= threshold.
 */
export declare function identifyBottlenecks(insights: BvInsights, beads: Bead[], threshold?: number): Array<{
    bead: Bead;
    betweenness: number;
}>;
/**
 * Prompt for LLM-based split proposal.
 * The LLM analyzes the bead and proposes concrete child beads.
 */
export declare function beadSplitProposalPrompt(bead: Bead, betweenness: number): string;
/**
 * Parse the LLM output into a SplitProposal.
 */
export declare function parseSplitProposal(output: string, beadId: string, beadTitle: string, betweenness: number): SplitProposal;
/**
 * Format a split proposal for display.
 */
export declare function formatSplitProposal(proposal: SplitProposal): string;
/**
 * Format split proposals as br CLI commands for the agent to execute.
 */
export declare function formatSplitCommands(proposal: SplitProposal): string;
//# sourceMappingURL=bead-splitting.d.ts.map