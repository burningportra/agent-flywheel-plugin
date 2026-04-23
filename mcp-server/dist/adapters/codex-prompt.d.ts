/**
 * Codex (GPT-5) prompt adapter.
 *
 * Applies the conventions from the `codex:gpt-5-4-prompting` skill:
 *   1. Terser tool preambles — GPT-5 follows-through better when the
 *      preamble is short and structural rather than chatty.
 *   2. Stricter structured output — require explicit `### STEP N` tags,
 *      `## FILES CHANGED:` manifest, and a machine-parseable
 *      `## COMPLETION_REPORT:` block.
 *   3. One-shot ingestion — GPT-5's long context handles large prompts
 *      well, so front-load acceptance criteria instead of drip-feeding.
 *   4. Input-buffer footnote — Codex CLI requires a trailing blank line
 *      before the prompt is dispatched (documented in _implement.md).
 *
 * DESIGN NOTES
 * ------------
 * The adapter is a pure string transform: it takes the common prompt
 * scaffold used by the coordinator and returns a Codex-tuned variant.
 * This keeps the dispatch layer (NTM `ntm send` / `Agent(...)`)
 * model-agnostic — only the prompt bytes differ per CLI.
 *
 * The interface (`AdaptedPrompt`, `adaptPromptForCodex`) is consumed by
 * downstream bead `1qn` (codex-rescue handoff). DO NOT rename these
 * exports without coordinating — the contract is load-bearing.
 */
/**
 * Common inputs the coordinator has already computed for the bead.
 * Kept minimal so all three model adapters can share the same input
 * shape (see gemini-prompt.ts).
 */
export interface BeadDispatchContext {
    /** Full bead id (e.g. `my-project-k67`), never a short alias. */
    readonly beadId: string;
    /** Bead title (single line). */
    readonly title: string;
    /** Full bead description / HOW section. */
    readonly description: string;
    /** Acceptance criteria lines (one per item). */
    readonly acceptance: readonly string[];
    /** Complexity classification (simple | medium | complex). */
    readonly complexity: 'simple' | 'medium' | 'complex';
    /** Likely-relevant file paths, pre-resolved. */
    readonly relevantFiles: readonly string[];
    /** Prior-art closed-bead IDs (up to 3). */
    readonly priorArtBeads: readonly string[];
    /** Adjective+noun name the agent will register with. */
    readonly agentName: string;
    /** Coordinator's Agent Mail name for send_message targeting. */
    readonly coordinatorName: string;
    /** `basename $PWD` / session project key. */
    readonly projectKey: string;
}
/**
 * Output shape — kept stable across adapters so the spawner can
 * pipeline {claude, codex, gemini} prompts identically.
 */
export interface AdaptedPrompt {
    /** The provider this prompt is tuned for. */
    readonly provider: 'claude' | 'codex' | 'gemini';
    /** The prompt body to send via `ntm send` / Agent(). */
    readonly prompt: string;
    /**
     * Recommended trailing newline count when dispatching via NTM.
     * Codex needs 2 (input-buffer quirk); others default to 1.
     */
    readonly trailingNewlines: 1 | 2;
}
/**
 * Apply the Codex conventions to a bead dispatch.
 *
 * The returned prompt embeds the MANDATORY Agent Mail STEP 0 bootstrap
 * verbatim so behavior is identical to Claude panes — only the
 * preamble/footer style changes.
 */
export declare function adaptPromptForCodex(bead: BeadDispatchContext): AdaptedPrompt;
//# sourceMappingURL=codex-prompt.d.ts.map