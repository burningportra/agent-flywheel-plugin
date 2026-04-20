import type { McpToolResult, FlywheelStructuredError, FlywheelToolError, FlywheelToolName, FlywheelPhase, FlywheelState, ToolChoiceOption, ToolNextStep, FlywheelErrorCode } from '../types.js';
export declare function formatModelRef(model: {
    provider?: string;
    id: string;
}): string;
export declare function makeChoiceOption(id: string, label: string, options?: Omit<ToolChoiceOption, 'id' | 'label'>): ToolChoiceOption;
export declare function makeNextToolStep(type: ToolNextStep['type'], message: string, options?: Omit<ToolNextStep, 'type' | 'message'>): ToolNextStep;
export declare function makeToolResult<TStructured>(text: string, structuredContent: TStructured): McpToolResult<TStructured>;
export declare function makeToolError(tool: FlywheelToolName, phase: FlywheelPhase, code: FlywheelErrorCode, message: string, options?: Omit<FlywheelToolError, 'code' | 'message'>): McpToolResult<FlywheelStructuredError>;
/**
 * Pick execution mode: single-branch (shared checkout) or worktree (isolated checkouts).
 */
export declare function resolveExecutionMode(coordinationMode: FlywheelState['coordinationMode'], hasAgentMail: boolean): 'worktree' | 'single-branch';
/**
 * Convergence score computation from polish change history.
 * Returns a 0-1 score where 1 = fully converged (no more changes).
 */
export declare function computeConvergenceScore(polishChanges: number[], outputSizes?: number[]): number;
export declare function pickRefinementModel(round: number): string;
/** Default deep plan model assignments. */
export declare const DEEP_PLAN_MODELS: {
    readonly correctness: "claude-opus-4-7";
    readonly robustness: "claude-sonnet-4-6";
    readonly ergonomics: "claude-sonnet-4-6";
    readonly synthesis: "claude-opus-4-7";
};
export declare const SWARM_STAGGER_DELAY_MS = 30000;
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
/**
 * Build implementer instructions for a single bead.
 */
export declare function implementerInstructions(bead: import('../types.js').Bead, profile: import('../types.js').RepoProfile, prevResults: import('../types.js').BeadResult[], cassMemory?: string, episodic?: string): string;
//# sourceMappingURL=shared.d.ts.map