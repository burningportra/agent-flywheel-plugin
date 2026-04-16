/**
 * Research-Reimagine Pipeline
 *
 * 7-phase pipeline: study an external project, reimagine its ideas
 * through this project's lens, stress-test, and synthesize.
 *
 * Phases:
 * 1. Investigate — study external project, propose reimagined ideas
 * 2. Deepen — push past conservative suggestions
 * 3. Inversion — what can WE do that THEY can't?
 * 4. 5x Blunder Hunt — stress-test the proposal
 * 5. User Review — human reviews and edits
 * 6. Multi-model Feedback — 3 models critique in parallel
 * 7. Synthesis — merge best feedback into final proposal
 *
 * NOTE: The 7-phase research pipeline is now driven by CC Agent tool
 * invocations in the /flywheel-research command. Phase runner
 * functions return phase configs for CC to use instead of spawning
 * pi subprocess agents.
 */
import type { ExecFn } from './exec.js';
export type ResearchPhase = "investigate" | "deepen" | "inversion" | "blunder_hunt" | "user_review" | "multi_model" | "synthesis" | "complete";
export interface ResearchPipelineState {
    externalUrl: string;
    externalName: string;
    projectName: string;
    currentPhase: ResearchPhase;
    proposal: string;
    artifactName: string;
    phasesCompleted: ResearchPhase[];
}
export interface ResearchPhaseResult {
    phase: ResearchPhase;
    success: boolean;
    proposal: string;
    model?: string;
    error?: string;
}
/**
 * Callback invoked during the `user_review` phase.
 * The caller (commands.ts) provides UI access; the pipeline runner does not.
 * Returns the (possibly edited) proposal and whether the user accepted it.
 */
export type UserReviewCallback = (proposal: string) => Promise<{
    accepted: boolean;
    editedProposal?: string;
}>;
/**
 * Phase config returned by runResearchPhase for CC Agent tool to execute.
 */
export interface ResearchPhaseConfig {
    phase: ResearchPhase;
    agents: Array<{
        name: string;
        model: string;
        task: string;
    }>;
}
/**
 * Blunder hunt for research proposals.
 * Same "overshoot mismatch" technique as bead blunder hunts, but
 * applied to the proposal document.
 */
export declare function researchBlunderHuntPrompt(proposal: string, passNumber: number): string;
/**
 * Multi-model feedback prompt.
 * Sent to 3 different models for competing critique.
 */
export declare function researchFeedbackPrompt(proposal: string): string;
/**
 * Synthesis prompt — merge feedback from multiple models.
 */
export interface FeedbackResult {
    model: string;
    plan: string;
    exitCode: number;
}
export declare function researchSynthesisPrompt(proposal: string, feedbackResults: FeedbackResult[]): string;
/**
 * Run a single phase of the research pipeline.
 *
 * Phase execution (LLM calls) is now driven by the CC Agent tool in the
 * calling command. This function returns phase configuration that the
 * caller uses to invoke CC Agent tool.
 *
 * For user_review phase, the onUserReview callback is still invoked directly.
 */
export declare function runResearchPhase(exec: ExecFn, cwd: string, phase: ResearchPhase, state: ResearchPipelineState, signal?: AbortSignal, onUserReview?: UserReviewCallback): Promise<ResearchPhaseResult>;
/**
 * Extract a short name from a GitHub URL.
 */
export declare function extractProjectName(url: string): string;
//# sourceMappingURL=research-pipeline.d.ts.map