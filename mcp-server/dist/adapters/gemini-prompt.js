/**
 * Gemini prompt adapter.
 *
 * Gemini tends to:
 *   - Do better with explicit headers + role framing at the top
 *     ("You are an implementation engineer…") and firm guardrails.
 *   - Repeat itself when structured-output blocks are ambiguous, so we
 *     bound it with a "STOP after the completion report" instruction.
 *   - Handle a bullet-heavy prompt more reliably than dense prose.
 *
 * The interface mirrors `codex-prompt.ts` exactly so the dispatch layer
 * is a switch on `provider`, nothing more.
 */
export function adaptPromptForGemini(bead) {
    const thinkingDirective = bead.complexity === 'complex'
        ? 'This bead is harder than it looks — plan before editing.'
        : 'This bead is well-scoped. Implement directly.';
    const completionLength = bead.complexity === 'simple'
        ? '≤5 bullets'
        : bead.complexity === 'medium'
            ? '≤10 bullets'
            : '≤20 bullets';
    const relevantFilesBlock = bead.relevantFiles.length > 0
        ? bead.relevantFiles.map((f) => `  - ${f}`).join('\n')
        : '  - (coordinator did not pre-resolve files; discover as needed)';
    const priorArtBlock = bead.priorArtBeads.length > 0
        ? bead.priorArtBeads.map((b) => `  - ${b}`).join('\n')
        : '  - (none)';
    const acceptanceBlock = bead.acceptance.map((a) => `  - ${a}`).join('\n');
    const prompt = [
        '# ROLE',
        'You are an implementation engineer working a single bead to completion.',
        'Follow every step in order. Do not skip Agent Mail bootstrap.',
        '',
        '# BEAD',
        `- id: ${bead.beadId}`,
        `- title: ${bead.title}`,
        `- complexity: ${bead.complexity}`,
        '',
        '## STEP 0 — AGENT MAIL BOOTSTRAP (mandatory first tool calls)',
        '- macro_start_session(',
        `    human_key='${bead.projectKey}',`,
        "    program='gemini-cli',",
        "    model='gemini',",
        `    task_description='Implementing bead ${bead.beadId}: ${bead.title}',`,
        `    preferred_name='${bead.agentName}')`,
        '- file_reservation_paths for every file you will edit; retry 3x on conflict.',
        `- send_message to '${bead.coordinatorName}' subject '[impl] ${bead.beadId} started'.`,
        '- Re-read AGENTS.md end-to-end.',
        '- Agent Mail runtime safety: use the Agent Mail MCP/HTTP tools only. Do NOT run `am doctor repair`, `am doctor archive-normalize`, or delete `.mailbox.activity.lock`; if Agent Mail looks busy/unhealthy, report it to the coordinator and ask them to run `flywheel_remediate({ checkName: "agent_mail_liveness", mode: "execute", autoConfirm: true })`.',
        '',
        '## STEP 1 — IMPLEMENT',
        thinkingDirective,
        '',
        '### Description',
        bead.description,
        '',
        '### Acceptance criteria',
        acceptanceBlock,
        '',
        '### Likely-relevant files',
        relevantFilesBlock,
        '',
        '### Prior art',
        priorArtBlock,
        '',
        '## STEP 2 — VALIDATE (every gate must pass before commit)',
        '- `npx tsc --noEmit` AND the project\'s `npm run build`.',
        '- Test suite for the files you touched.',
        '- `ubs <changed-files>` if installed.',
        '',
        '## STEP 3 — COMMIT & CLOSE',
        `- Commit with a message referencing ${bead.beadId}.`,
        `- \`br update ${bead.beadId} --status closed\` then verify via \`br show ${bead.beadId} --json\`.`,
        '',
        '## STEP 4 — RELEASE + REPORT',
        '- release_file_reservations.',
        `- send_message to '${bead.coordinatorName}' subject '[impl] ${bead.beadId} done' with ${completionLength}.`,
        '',
        '## COMPLETION REPORT (produce verbatim, then STOP):',
        '```yaml',
        `bead: ${bead.beadId}`,
        'status: closed | blocked | partial',
        'files_changed: [<path>, ...]',
        'tests_added: [<test-id>, ...]',
        'gates_passed: [build, test, ubs]',
        'open_concerns: [<string>, ...]',
        '```',
        'Do not append any prose after the block above.',
    ].join('\n');
    return {
        provider: 'gemini',
        prompt,
        trailingNewlines: 1,
    };
}
//# sourceMappingURL=gemini-prompt.js.map