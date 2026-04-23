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
/** Build the Codex-specific structured-output footer. */
function codexCompletionFooter(bead) {
    return [
        '## COMPLETION_REPORT (machine-readable — produce verbatim):',
        '```yaml',
        `bead: ${bead.beadId}`,
        'status: closed | blocked | partial',
        'files_changed:',
        '  - path: <repo-relative-path>',
        '    lines_added: <int>',
        '    lines_removed: <int>',
        'tests_added: [<test-id>, ...]',
        'gates_passed: [build, test, ubs]',
        'open_concerns: [<string>, ...]',
        '```',
        'End every response with the block above. Do NOT add prose after it.',
    ].join('\n');
}
/**
 * Apply the Codex conventions to a bead dispatch.
 *
 * The returned prompt embeds the MANDATORY Agent Mail STEP 0 bootstrap
 * verbatim so behavior is identical to Claude panes — only the
 * preamble/footer style changes.
 */
export function adaptPromptForCodex(bead) {
    const thinkingDirective = bead.complexity === 'complex'
        ? 'Reason carefully before writing code. Plan edits in a one-sentence outline first, then execute.'
        : 'Respond directly; the bead is well-scoped.';
    const completionLength = bead.complexity === 'simple'
        ? '≤5 bullets'
        : bead.complexity === 'medium'
            ? '≤10 bullets'
            : '≤20 bullets';
    const relevantFilesBlock = bead.relevantFiles.length > 0
        ? bead.relevantFiles.map((f) => `- ${f}`).join('\n')
        : '(coordinator did not pre-resolve files — discover as needed)';
    const priorArtBlock = bead.priorArtBeads.length > 0
        ? bead.priorArtBeads.map((b) => `- ${b}`).join('\n')
        : '(none)';
    const acceptanceBlock = bead.acceptance.map((a) => `- ${a}`).join('\n');
    const prompt = [
        // Codex preamble: short, no pleasantries, structural tags only.
        '# CODEX BEAD DISPATCH',
        `bead=${bead.beadId} provider=codex complexity=${bead.complexity}`,
        '',
        '### STEP 0 — AGENT MAIL BOOTSTRAP (MANDATORY; do this before any other tool call)',
        '0a. macro_start_session(',
        `      human_key='${bead.projectKey}',`,
        "      program='codex',",
        "      model='gpt-5',",
        `      task_description='Implementing bead ${bead.beadId}: ${bead.title}',`,
        `      preferred_name='${bead.agentName}')`,
        '0b. file_reservation_paths for every file you plan to edit. Retry 3x with 30s backoff on conflict.',
        `0c. send_message to '${bead.coordinatorName}' subject '[impl] ${bead.beadId} started'.`,
        '0d. Re-read AGENTS.md top-to-bottom.',
        '',
        '### STEP 1 — IMPLEMENT',
        thinkingDirective,
        '',
        `title: ${bead.title}`,
        'description: |',
        ...bead.description.split('\n').map((l) => `  ${l}`),
        'acceptance:',
        acceptanceBlock,
        '',
        'relevant_files:',
        relevantFilesBlock,
        '',
        'prior_art:',
        priorArtBlock,
        '',
        '### STEP 2 — VALIDATE (gates are non-negotiable)',
        '- TypeScript: `npx tsc --noEmit && npm run build`',
        '- Tests: run the suite covering touched files.',
        '- UBS (if installed): `ubs <changed-files>`.',
        '',
        '### STEP 3 — COMMIT & CLOSE',
        `- Commit referencing ${bead.beadId}.`,
        `- \`br update ${bead.beadId} --status closed\` then verify with \`br show ${bead.beadId} --json\`.`,
        '',
        '### STEP 4 — RELEASE + REPORT',
        '- release_file_reservations.',
        `- send_message to '${bead.coordinatorName}' subject '[impl] ${bead.beadId} done' (${completionLength}).`,
        '',
        codexCompletionFooter(bead),
    ].join('\n');
    return {
        provider: 'codex',
        prompt,
        trailingNewlines: 2, // Codex CLI input-buffer quirk.
    };
}
//# sourceMappingURL=codex-prompt.js.map