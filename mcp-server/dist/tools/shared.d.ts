import type { McpToolResult, FlywheelStructuredError, FlywheelToolError, FlywheelToolName, FlywheelPhase, ToolChoiceOption, ToolNextStep, FlywheelErrorCode } from '../types.js';
export declare function makeChoiceOption(id: string, label: string, options?: Omit<ToolChoiceOption, 'id' | 'label'>): ToolChoiceOption;
export declare function makeNextToolStep(type: ToolNextStep['type'], message: string, options?: Omit<ToolNextStep, 'type' | 'message'>): ToolNextStep;
export declare function makeToolResult<TStructured>(text: string, structuredContent: TStructured): McpToolResult<TStructured>;
export declare function makeOkToolResult<TData>(tool: FlywheelToolName, phase: FlywheelPhase | string, text: string, data: TData): McpToolResult;
export declare function makeToolError(tool: FlywheelToolName, phase: FlywheelPhase, code: FlywheelErrorCode, message: string, options?: Omit<FlywheelToolError, 'code' | 'message' | 'tool' | 'phase' | 'timestamp'>): McpToolResult<FlywheelStructuredError>;
/**
 * Convergence score computation from polish change history.
 * Returns a 0-1 score where 1 = fully converged (no more changes).
 */
export declare function computeConvergenceScore(polishChanges: number[], outputSizes?: number[]): number;
export declare function pickRefinementModel(round: number): string;
/**
 * Walk a directory and return the newest mtime (ms) across matching files.
 * Skips node_modules and dot-directories. Returns null if nothing matched.
 */
export declare function newestMtime(root: string, filter?: (name: string) => boolean): number | null;
/**
 * Slugify a goal string to a filesystem-safe identifier.
 */
export declare function slugifyGoal(goal: string): string;
/**
 * Format a repo profile into a readable summary string for prompts.
 */
export declare function formatRepoProfile(profile: import('../types.js').RepoProfile): string;
/**
 * Build the bead creation prompt given a goal and repo context.
 */
export declare function beadCreationPrompt(goal: string, repoContext: string, constraints: string[]): string;
export interface BeadQualityScore {
    /** 0-1 composite score. */
    score: number;
    /** Human-readable label. */
    label: string;
    /** Per-bead issues found. */
    weakBeads: string[];
}
/**
 * Heuristic bead quality score based on description richness, title quality,
 * file specificity, and acceptance criteria presence.
 * Returns a 0-1 score and a summary label — no LLM call required.
 */
export declare function computeBeadQualityScore(beads: import('../types.js').Bead[]): BeadQualityScore;
/**
 * Format a BeadQualityScore for display.
 */
export declare function formatBeadQualityScore(q: BeadQualityScore): string;
//# sourceMappingURL=shared.d.ts.map