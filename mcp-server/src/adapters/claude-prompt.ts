/**
 * Claude prompt adapter.
 *
 * Claude is the baseline — its prompt mirrors the existing Step 7
 * template in `skills/start/_implement.md` so behavior is unchanged for
 * Claude panes when model diversity is enabled. Kept as its own file so
 * the three providers expose a symmetric interface.
 */

import type {
  AdaptedPrompt,
  BeadDispatchContext,
} from './codex-prompt.js';

export type { AdaptedPrompt, BeadDispatchContext };

export function adaptPromptForClaude(
  bead: BeadDispatchContext,
): AdaptedPrompt {
  const thinkingDirective =
    bead.complexity === 'complex'
      ? 'Think carefully and step-by-step before writing code; this bead is harder than it looks.'
      : "Respond quickly; don't overthink — this bead is well-scoped.";

  const completionLength =
    bead.complexity === 'simple'
      ? '≤5 bullets'
      : bead.complexity === 'medium'
        ? '≤10 bullets'
        : '≤20 bullets';

  const relevantFilesBlock =
    bead.relevantFiles.length > 0
      ? bead.relevantFiles.map((f) => `- ${f}`).join('\n')
      : '- (coordinator did not pre-resolve files — discover as needed)';

  const priorArtBlock =
    bead.priorArtBeads.length > 0
      ? bead.priorArtBeads.map((b) => `- ${b}`).join('\n')
      : '- (none)';

  const acceptanceBlock = bead.acceptance.map((a) => `- ${a}`).join('\n');

  const prompt = [
    '## STEP 0 — AGENT MAIL BOOTSTRAP (MANDATORY — DO THIS BEFORE ANYTHING ELSE)',
    'Do NOT read any files or run any commands until all 4 sub-steps below are complete.',
    '',
    '0a. macro_start_session(',
    `      human_key='${bead.projectKey}',`,
    "      program='claude-code',",
    "      model='claude',",
    `      task_description='Implementing bead ${bead.beadId}: ${bead.title}',`,
    `      preferred_name='${bead.agentName}')`,
    '0b. file_reservation_paths for every file you plan to edit. Retry 3x with 30s backoff.',
    `0c. send_message to '${bead.coordinatorName}' subject '[impl] ${bead.beadId} started'.`,
    '0d. Re-read AGENTS.md end-to-end.',
    '',
    '## STEP 1 — IMPLEMENT',
    thinkingDirective,
    '',
    `Title: ${bead.title}`,
    'Description:',
    bead.description,
    `Complexity: ${bead.complexity}`,
    'Acceptance criteria:',
    acceptanceBlock,
    '',
    'Likely-relevant files:',
    relevantFilesBlock,
    '',
    'Prior art:',
    priorArtBlock,
    '',
    '## STEP 2 — VALIDATE (MANDATORY GATES — all must pass before STEP 3)',
    '- `npx tsc --noEmit` and `npm run build`.',
    '- Test suite for touched files.',
    '- `ubs <changed-files>` if installed.',
    '',
    '## STEP 3 — COMMIT & CLOSE',
    `- Commit referencing ${bead.beadId}.`,
    `- \`br update ${bead.beadId} --status closed\`; verify via \`br show ${bead.beadId} --json\`.`,
    '',
    '## STEP 4 — RELEASE + REPORT',
    '- release_file_reservations.',
    `- send_message to '${bead.coordinatorName}' subject '[impl] ${bead.beadId} done' (target ${completionLength}).`,
  ].join('\n');

  return {
    provider: 'claude',
    prompt,
    trailingNewlines: 1,
  };
}
