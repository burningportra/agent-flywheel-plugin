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
 * invocations in the /orchestrate-research command. Phase runner
 * functions return phase configs for CC to use instead of spawning
 * pi subprocess agents.
 */

import type { ExecFn } from './exec.js';

// ─── Types ──────────────────────────────────────────────────

export type ResearchPhase =
  | "investigate"
  | "deepen"
  | "inversion"
  | "blunder_hunt"
  | "user_review"
  | "multi_model"
  | "synthesis"
  | "complete";

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
export type UserReviewCallback = (
  proposal: string
) => Promise<{ accepted: boolean; editedProposal?: string }>;

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

// ─── Additional Prompts ─────────────────────────────────────

/**
 * Blunder hunt for research proposals.
 * Same "overshoot mismatch" technique as bead blunder hunts, but
 * applied to the proposal document.
 */
export function researchBlunderHuntPrompt(proposal: string, passNumber: number): string {
  return `## Research Proposal Blunder Hunt — Pass ${passNumber}/5

I am POSITIVE that you missed or screwed up at least 50 elements in this proposal. Read it carefully and find every issue.

### Proposal
${proposal}

### Check for:
1. **Architectural flaws** — will the proposed integration actually work?
2. **Missing edge cases** — what happens when X fails?
3. **Unrealistic assumptions** — does this assume capabilities that don't exist?
4. **Missing dependencies** — what needs to exist before this can work?
5. **Contradictions** — do different parts of the proposal conflict?
6. **Shallow reimagining** — is this just a port, or genuinely novel?
7. **Missing security/performance implications**
8. **Vague sections** that need concrete detail
9. **Missing testing/validation strategy**
10. **Over-engineering** — is this more complex than needed?

For each issue:
- State the problem specifically
- Propose a fix

Then output the FULL revised proposal with all fixes applied.
If the proposal is genuinely solid with only marginal improvements, output \`NO_CHANGES\` and briefly explain.

Use ultrathink.`;
}

/**
 * Multi-model feedback prompt.
 * Sent to 3 different models for competing critique.
 */
export function researchFeedbackPrompt(proposal: string): string {
  return `## Research Proposal Critique

Review this proposal and provide specific, actionable improvements.

### Proposal
${proposal}

### Provide feedback on:
1. **Architectural soundness** — will this integration work as described?
2. **Completeness** — what's missing?
3. **Feasibility** — is the scope realistic?
4. **Innovation quality** — is this genuinely novel or just a port?
5. **Risk assessment** — what could go wrong?

### Output Format
Provide your improvements as a numbered list of specific, actionable suggestions.
For each, explain what's wrong and how to fix it.
Be critical but constructive — don't invent problems, but don't be gentle either.`;
}

/**
 * Synthesis prompt — merge feedback from multiple models.
 */
export interface FeedbackResult {
  model: string;
  plan: string;
  exitCode: number;
}

export function researchSynthesisPrompt(
  proposal: string,
  feedbackResults: FeedbackResult[]
): string {
  const feedbackList = feedbackResults
    .filter((r) => r.exitCode === 0 && r.plan.trim().length > 0)
    .map((r, i) => `### Feedback ${i + 1} (${r.model})\n${r.plan}`)
    .join("\n\n---\n\n");

  return `## Research Proposal Synthesis

Take the original proposal and the competing feedback from multiple models, and produce a "best of all worlds" revised proposal.

### Original Proposal
${proposal}

### Competing Feedback
${feedbackList}

### Instructions
1. Identify the strongest suggestions from each feedback source
2. Resolve contradictions — pick the approach with better justification
3. Apply all valuable improvements to the proposal
4. Preserve the original proposal's strongest ideas
5. Output the FULL revised proposal

Be aggressive about incorporating good feedback. The goal is a proposal that's stronger than any single model could produce alone.`;
}

// ─── Pipeline Runner ────────────────────────────────────────

/**
 * Run a single phase of the research pipeline.
 *
 * Phase execution (LLM calls) is now driven by the CC Agent tool in the
 * calling command. This function returns phase configuration that the
 * caller uses to invoke CC Agent tool.
 *
 * For user_review phase, the onUserReview callback is still invoked directly.
 */
export async function runResearchPhase(
  exec: ExecFn,
  cwd: string,
  phase: ResearchPhase,
  state: ResearchPipelineState,
  signal?: AbortSignal,
  onUserReview?: UserReviewCallback
): Promise<ResearchPhaseResult> {
  // LLM call removed — invoke via CC Agent tool in the calling command
  // Phase configs are returned for the caller to drive via CC Agent tool.
  switch (phase) {
    case "user_review": {
      if (onUserReview) {
        const result = await onUserReview(state.proposal);
        return {
          phase,
          success: result.accepted,
          proposal: result.editedProposal ?? state.proposal,
        };
      }
      // No callback provided — caller is responsible for handling user review
      // externally. Return success with the unmodified proposal so the pipeline
      // can continue.
      return { phase, success: true, proposal: state.proposal };
    }

    case "multi_model": {
      // multi_model is a preview-only phase — the actual agent runs happen
      // in synthesis to avoid running 3 feedback agents twice (bug fix).
      // This phase just signals readiness so the progress display shows the step.
      return { phase, success: true, proposal: state.proposal };
    }

    default:
      // All other phases (investigate, deepen, inversion, blunder_hunt, synthesis)
      // are driven by CC Agent tool invocations in the calling command.
      throw new Error('Not implemented: use CC Agent tool to invoke this logic');
  }
}

/**
 * Extract a short name from a GitHub URL.
 */
export function extractProjectName(url: string): string {
  const match = url.match(/github\.com\/[\w.-]+\/([\w.-]+)/);
  return match?.[1]?.replace(/\.git$/, "") ?? url.split("/").pop() ?? "external-project";
}
