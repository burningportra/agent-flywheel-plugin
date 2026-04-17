import type { RepoProfile, Bead, BeadResult, ScanResult, FlywheelPhase } from "./types.js";
import type { PlanToBeadAudit } from "./beads.js";
export declare function workflowRoadmap(currentPhase: FlywheelPhase): string;
export declare function formatRepoProfile(profile: RepoProfile, scanResult?: ScanResult): string;
export declare function flywheelSystemPrompt(hasSophia: boolean, coordBackend?: import("./coordination.js").CoordinationBackend): string;
export declare function discoveryInstructions(profile: RepoProfile, scanResult?: ScanResult): string;
export declare function beadCreationPrompt(goal: string, repoContext: string, constraints: string[]): string;
export declare function formatPlanToBeadAuditWarnings(audit: PlanToBeadAudit): string;
export declare function planToBeadsPrompt(planPath: string, goal: string, profile: RepoProfile): string;
export declare function beadRefinementPrompt(roundNumber?: number, priorChanges?: number[]): string;
/** Fresh-context refinement prompt for sub-agent bead review. */
export declare function freshContextRefinementPrompt(cwd: string, goal: string, roundNumber: number, simulationReport?: string): string;
/**
 * Generate a refinement prompt that includes specific simulation failures.
 * Used when simulateExecutionPaths finds structural problems in the bead graph.
 */
export declare function simulationRefinementPrompt(report: string, beadIds: string[]): string;
/**
 * Convergence score (0-1) from polish round history.
 * Weights: velocity 35%, size 25%, similarity 25%, zero-streak 15%.
 * >= 0.75 = ready to implement, >= 0.90 = diminishing returns.
 *
 * @param descriptionSnapshots - Optional per-round arrays of bead description strings.
 *   When provided, Jaccard similarity between the last two snapshots is used as signal 3.
 */
export declare function computeConvergenceScore(changes: number[], outputSizes?: number[], descriptionSnapshots?: string[][]): number;
export declare function synthesisInstructions(plans: {
    name: string;
    model: string;
    plan: string;
}[]): string;
export declare function realityCheckInstructions(goal: string, beads: Bead[], results: BeadResult[]): string;
export declare function implementerInstructions(bead: Bead, profile: RepoProfile, previousResults: BeadResult[], cassMemory?: string, episodicContext?: string): string;
export declare function reviewerInstructions(bead: Bead, implementationSummary: string, profile: RepoProfile, episodicContext?: string): string;
export declare function adversarialReviewInstructions(bead: Bead, implementationSummary: string, domainExtras?: string): string;
export declare function crossAgentReviewInstructions(goal: string, beads: Bead[], results: BeadResult[]): string;
export declare function polishInstructions(goal: string, artifacts: string[]): string;
export declare function commitStrategyInstructions(beads: Bead[], results: BeadResult[]): string;
export declare function skillExtractionInstructions(goal: string, artifacts: string[]): string;
/** Proactive drift check that runs every N completed beads. */
export declare function strategicDriftCheckInstructions(goal: string, beads: Bead[], results: BeadResult[], completedCount: number, totalCount: number): string;
/**
 * Overshoot mismatch prompt. Claiming 80+ errors forces exhaustive search
 * past the ~20-25 issue plateau.
 */
export declare function blunderHuntInstructions(cwd: string, passNumber: number, domainExtras?: string): string;
/** Force the reviewer to pick files outside the changed artifacts list. */
export declare function randomExplorationInstructions(goal: string, changedFiles: string[], cwd: string): string;
/** Extensible catalogue of AI slop patterns to detect and fix. */
export declare const AI_SLOP_PATTERNS: {
    pattern: string;
    fix: string;
}[];
export declare function deSlopifyInstructions(files: string[]): string;
export declare function landingChecklistInstructions(cwd: string): string;
export declare function swarmMarchingOrders(cwd: string, beadId?: string): string;
/** Stagger delay configuration for thundering herd prevention. */
export declare const SWARM_STAGGER_DELAY_MS = 30000;
/** CC Agent subagent_type for the installed Codex plugin. Use instead of a model string. */
export declare const CODEX_SUBAGENT_TYPE: "codex:codex-rescue";
/** Default models used by the multi-model deep planning agents (fallbacks).
 * Note: the robustness perspective is handled via CODEX_SUBAGENT_TYPE in plan.ts.
 * This constant is the fallback for callers that only support model strings. */
export declare const DEEP_PLAN_MODELS: {
    readonly correctness: "anthropic/claude-opus-4-7";
    readonly robustness: "anthropic/claude-opus-4-7";
    readonly ergonomics: "anthropic/claude-sonnet-4-6";
    readonly synthesis: "anthropic/claude-opus-4-7";
};
/** Models used by the swarm launcher. */
export declare const SWARM_MODELS: {
    readonly opus: "anthropic/claude-opus-4-7";
    readonly codex: "codex";
    readonly haiku: "anthropic/claude-haiku-4-5";
};
/** Models used by cost-aware model routing tiers. */
export declare const MODEL_ROUTING_TIERS: {
    readonly simple: {
        readonly implementation: "anthropic/claude-haiku-4-5";
        readonly review: "anthropic/claude-sonnet-4-6";
    };
    readonly medium: {
        readonly implementation: "anthropic/claude-opus-4-7";
        readonly review: "anthropic/claude-sonnet-4-6";
    };
    readonly complex: {
        readonly implementation: "anthropic/claude-opus-4-7";
        readonly review: "anthropic/claude-opus-4-7";
    };
};
/**
 * Model rotation for refinement rounds.
 * Different models have different blind spots; rotating prevents anchoring.
 */
export declare const REFINEMENT_MODELS: readonly ["anthropic/claude-opus-4-7", "anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-7"];
/** Pick a refinement model based on round number (rotates through available models). */
export declare function pickRefinementModel(round: number): string;
/**
 * Prompt for LLM-based quality scoring of a bead on WHAT/WHY/HOW axes.
 */
export declare function beadQualityScoringPrompt(beadId: string, title: string, description: string): string;
/** Step 1: Investigate an external project and propose reimagined ideas. */
export declare function researchInvestigatePrompt(externalUrl: string, projectName: string, cwd: string): string;
/** Step 2: Push past conservative initial suggestions. */
export declare function researchDeepenPrompt(): string;
/**
 * Post-research handoff prompt - sent as a followUp after all research phases
 * complete. Uses the same "NEXT: ... NOW" directive style as tool results so
 * the agent immediately drives the full pipeline rather than just acknowledging.
 */
export declare function researchHandoffPrompt(externalName: string, selectedGoal: string, artifactName: string, phasesCompleted: number, totalPhases: number, hasRepoProfile: boolean): string;
/** Step 3: Inversion analysis - what can WE do that THEY cannot? */
export declare function researchInversionPrompt(projectName: string, externalName: string): string;
export declare function goalRefinementPrompt(goal: string, profile: RepoProfile): string;
export declare function summaryInstructions(goal: string, beads: Bead[], results: BeadResult[]): string;
export declare function competingPlanAgentPrompt(focus: "correctness" | "robustness" | "ergonomics" | "fresh-perspective", goal: string, profile: RepoProfile, scanResult?: ScanResult, cassContext?: string): string;
export declare function planSynthesisPrompt(plans: {
    name: string;
    model: string;
    plan: string;
}[], format?: "markdown" | "git-diff"): string;
export declare function planDocumentPrompt(goal: string, profile: RepoProfile, scanResult?: ScanResult): string;
/**
 * Git-diff style plan review — asks a fresh model to propose specific changes with rationale.
 * Used by the "📝 Git-diff review" plan refinement option in flywheel_approve_beads.
 */
export declare function planGitDiffReviewPrompt(planText: string): string;
/**
 * Plan integration prompt — asks a model to integrate proposed revisions in-place.
 * Follows planGitDiffReviewPrompt in the two-step git-diff review cycle.
 */
export declare function planIntegrationPrompt(planText: string, revisions: string): string;
export declare function planRefinementPrompt(planPath: string, roundNumber: number): string;
/**
 * Fresh-context plan refinement prompt for sub-agent use.
 * Embeds the full plan text so the sub-agent (zero session context)
 * can evaluate without reading artifacts.
 */
export declare function freshPlanRefinementPrompt(planText: string, planArtifactPath: string, roundNumber: number, cwd: string, cassContext?: string): string;
export declare function learningsExtractionPrompt(goal: string, beadIds: string[]): string;
export interface BeadQualityScore {
    what: number;
    why: number;
    how: number;
    weaknesses: string[];
    suggestions: string[];
}
export interface BeadQualityAuditResult {
    beadId: string;
    title: string;
    score: BeadQualityScore | null;
    /** Average of what/why/how, or null if parse failed */
    avgScore: number | null;
    weakAxis: "what" | "why" | "how" | null;
}
/**
 * Parse the JSON block produced by beadQualityScoringPrompt().
 */
export declare function parseBeadQualityScore(output: string): BeadQualityScore | null;
/**
 * Format a WHAT/WHY/HOW audit result for display in the approval UI.
 */
export declare function formatBeadQualityAudit(results: BeadQualityAuditResult[]): string;
/**
 * Full codebase audit prompt - used by /flywheel-audit.
 * Spawned as parallel agents: bugs, security, tests, dead-code.
 */
export declare function auditAgentPrompt(focus: "bugs" | "security" | "tests" | "dead-code", profile: RepoProfile, files: string[], cwd: string, domainExtras?: string): string;
/**
 * Targeted scan prompt - used by /flywheel-scan.
 * Scoped to specific files/paths and one focus area.
 */
export declare function scanAgentPrompt(focus: string, files: string[], cwd: string, domainExtras?: string): string;
/**
 * Convert audit/scan findings into bead creation instructions.
 */
export declare function findingsToBeadsPrompt(findings: Array<{
    severity: string;
    file: string;
    line: string;
    title: string;
    description: string;
    fix: string;
}>, cwd: string): string;
//# sourceMappingURL=prompts.d.ts.map