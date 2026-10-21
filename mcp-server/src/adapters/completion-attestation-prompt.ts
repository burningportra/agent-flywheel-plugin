import { CompletionReportSchemaV1 } from '../completion-report.js';
import type { BeadDispatchContext } from './codex-prompt.js';

const EXAMPLE_CREATED_AT = '2000-01-01T00:00:00.000Z';
const CREATED_AT_PLACEHOLDER = '<ISO-8601 timestamp>';

function completionReportExample(
  bead: Pick<BeadDispatchContext, 'beadId' | 'agentName'>,
): string {
  const report = CompletionReportSchemaV1.parse({
    version: 1,
    beadId: bead.beadId,
    agentName: bead.agentName,
    paneName: '<pane-name-or-omit>',
    status: 'closed',
    changedFiles: ['<repo-relative-path>'],
    commits: ['<short-sha>'],
    ubs: {
      ran: true,
      summary: 'clean',
      findingsFixed: 0,
      deferredBeadIds: [],
    },
    verify: [
      {
        command: '<repo-verify-command>',
        exitCode: 0,
        summary: '<verify-summary>',
      },
    ],
    selfReview: {
      ran: true,
      summary: '<self-review-summary>',
    },
    beadClosedVerified: true,
    reservationsReleased: true,
    createdAt: EXAMPLE_CREATED_AT,
  });

  return JSON.stringify(
    { ...report, createdAt: CREATED_AT_PLACEHOLDER },
    null,
    2,
  );
}

/**
 * pstack guardrails against the excuses that let unfinished work close.
 * `potetoMode` adds the rule that an implementor never verifies its own bead,
 * because `flywheel_advance_wave` then waits for an independent verdict.
 */
export function buildAntiRationalizationRules(opts: { potetoMode?: boolean } = {}): string {
  const rules = [
    'Do not call a failure "pre-existing" unless you ran the same command at the base SHA and quote that run (command, SHA, exit code, failing output) in your completion message. Without that log the failure is yours to fix.',
    'Do not cut scope on your own: no skipped acceptance criteria, deferred pieces, weakened tests, or loosened checks. Ask the operator with AskUserQuestion first; in a headless pane, stop and report the blocker to the coordinator over Agent Mail instead.',
    'Run every `Verify, unit:`, `Verify, live:`, and `Verify, perf:` command in the acceptance criteria exactly as written, and record each in `verify[]` with its real exit code. A command you could not run is an unmet criterion, not a pass.',
  ];
  if (opts.potetoMode) {
    rules.push(
      'Poteto mode is on, so do not verify your own bead: leave the `verification` block out of your report. An independent verifier records it through `flywheel_approve_beads(action: "verify-bead")`, and `flywheel_advance_wave` blocks the wave until that verdict matches your commits.',
    );
  }
  return [
    '## ANTI-RATIONALIZATION RULES',
    ...rules.map((rule, i) => `${i + 1}. ${rule}`),
  ].join('\n');
}

export function buildPreCompletionQualityGate(
  bead: Pick<BeadDispatchContext, 'beadId' | 'agentName'> & { potetoMode?: boolean },
): string {
  const reportPath = `.pi-flywheel/completion/${bead.beadId}.json`;

  return [
    buildAntiRationalizationRules({ potetoMode: bead.potetoMode }),
    '',
    '## PRE-COMPLETION QUALITY GATE',
    'Before sending the completion message, complete these steps in order and fix every issue you find:',
    '1. Invoke `/ubs-workflow` in changed-files mode, or run `ubs <changed-files>` when the skill is unavailable. Triage every finding and record fixes or justified deferrals.',
    "2. Run the repository's documented verify commands for every surface you changed and record each exit code.",
    '3. Perform a fresh-eyes self-review of your diff for regressions, unsafe assumptions, missing tests, and edge cases.',
    `4. After closing and verifying the bead and releasing reservations, write the completion attestation to the exact path \`${reportPath}\`.`,
    '',
    '`flywheel_advance_wave` reads this file and hard-blocks on missing or invalid evidence when `FW_ATTESTATION_REQUIRED=1`.',
    'Use this example, generated from `CompletionReportSchemaV1` in `mcp-server/src/completion-report.ts`, and replace every angle-bracket placeholder with real evidence:',
    '```json',
    completionReportExample(bead),
    '```',
    'Keep `status`, `beadClosedVerified`, and `reservationsReleased` truthful. A closed report requires `beadClosedVerified: true`.',
  ].join('\n');
}
