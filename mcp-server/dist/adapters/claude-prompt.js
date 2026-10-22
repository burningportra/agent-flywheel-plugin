/**
 * Prompt adapter for terminal-agent panes: Claude, and the Pi panes of the
 * Pi and Gemini lanes.
 *
 * Claude is the baseline — its prompt mirrors the existing Step 7
 * template in `skills/start/_implement.md` so behavior is unchanged for
 * Claude panes when model diversity is enabled. Pi and Gemini panes get the
 * same steps with Agent Mail through the `am` CLI.
 */
import { buildPreCompletionQualityGate } from './completion-attestation-prompt.js';
import { CURRENT_GEMINI_MODEL_ID } from '../model-detection.js';
const AGENT_MAIL_SAFETY = 'Do NOT run `am doctor repair`, `am doctor archive-normalize`, or delete `.mailbox.activity.lock`; if Agent Mail looks busy/unhealthy, report it to the coordinator and ask them to run `flywheel_remediate({ checkName: "agent_mail_liveness", mode: "execute", autoConfirm: true })`.';
/** Agent Mail's background git archive queue can hold an `am` call for 40+ seconds, so panes cap each one. */
export const AGENT_MAIL_CLI_TIMEOUT_SECONDS = 10;
/** Prefix for an `am` command: SIGALRM survives `exec`, so a stalled `am` exits 142 after the timeout. */
export const AGENT_MAIL_CLI_TIMEOUT_GUARD = `perl -e 'alarm ${AGENT_MAIL_CLI_TIMEOUT_SECONDS}; exec @ARGV' --`;
const AGENT_MAIL_CLI_TIMEOUT_RULE = `Agent Mail's background archive queue can stall an \`am\` command for 40+ seconds. Run every \`am\` command in this prompt (0a-0c and STEP 4) behind \`${AGENT_MAIL_CLI_TIMEOUT_GUARD}\`, e.g. \`${AGENT_MAIL_CLI_TIMEOUT_GUARD} am macros start-session ...\`, or with a ${AGENT_MAIL_CLI_TIMEOUT_SECONDS}s tool timeout. If one times out (exit 142), don't retry it in a loop or run \`am doctor\`: carry on with the bead and note the timed-out command in your completion message.`;
const AGENT_MAIL_MCP_TIMEOUT_RULE = `If an Agent Mail MCP call takes longer than ${AGENT_MAIL_CLI_TIMEOUT_SECONDS}s (archive-queue contention), proceed without it instead of retrying in a loop or running \`am doctor\`, and note the skipped call in your completion message.`;
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
function agentMailSteps(bead, identity, completionLength) {
    const task = `Implementing bead ${bead.beadId}: ${bead.title}`;
    if (identity.agentMail === 'mcp') {
        return {
            bootstrap: [
                '0a. macro_start_session(',
                `      human_key='${bead.projectKey}',`,
                `      program='${identity.program}',`,
                `      model='${identity.model}',`,
                `      task_description='${task}',`,
                `      agent_name='${bead.agentName}')`,
                '0b. file_reservation_paths for every file you plan to edit. Retry 3x with 30s backoff.',
                `0c. send_message to '${bead.coordinatorName}' subject '[impl] ${bead.beadId} started'.`,
                `0d. Agent Mail runtime safety: use the Agent Mail MCP/HTTP tools only. ${AGENT_MAIL_SAFETY} ${AGENT_MAIL_MCP_TIMEOUT_RULE}`,
            ],
            report: [
                '- release_file_reservations.',
                `- send_message to '${bead.coordinatorName}' subject '[impl] ${bead.beadId} done' (target ${completionLength}).`,
            ],
        };
    }
    const project = shellQuote(bead.projectKey);
    const agent = shellQuote(bead.agentName);
    const send = (subject, body) => `am mail send --project ${project} --from ${agent} --to ${shellQuote(bead.coordinatorName)} --subject ${shellQuote(subject)} --body ${body}`;
    return {
        bootstrap: [
            'This pane has no Agent Mail MCP tools. Run these `am` CLI commands in your shell instead.',
            AGENT_MAIL_CLI_TIMEOUT_RULE,
            ...(identity.provider === 'agy'
                ? ['Use AGY native tools: run_command for shell commands, read_file for reading, edit_file for editing, write_file for writing.']
                : []),
            `0a. am macros start-session --project ${project} --program ${identity.program} --model ${identity.model} --agent-name ${agent} --task ${shellQuote(task)} --json`,
            `0b. am file_reservations reserve ${project} ${agent} <path>... --exclusive --ttl 3600 --reason ${shellQuote(bead.beadId)} for every file you plan to edit. If the output lists conflicts, retry 3x with 30s backoff.`,
            `0c. ${send(`[impl] ${bead.beadId} started`, "'started'")}`,
            `0d. Agent Mail runtime safety: ${AGENT_MAIL_SAFETY} Keep the ${AGENT_MAIL_CLI_TIMEOUT_SECONDS}s guard on every \`am\` command.`,
        ],
        report: [
            `- am file_reservations release ${project} ${agent}`,
            `- ${send(`[impl] ${bead.beadId} done`, `'<summary, target ${completionLength}>'`)}`,
        ],
    };
}
function adaptPromptForTerminal(bead, identity) {
    const thinkingDirective = bead.complexity === 'complex'
        ? 'Think carefully and step-by-step before writing code; this bead is harder than it looks.'
        : "Respond quickly; don't overthink — this bead is well-scoped.";
    const completionLength = bead.complexity === 'simple'
        ? '≤5 bullets'
        : bead.complexity === 'medium'
            ? '≤10 bullets'
            : '≤20 bullets';
    const relevantFilesBlock = bead.relevantFiles.length > 0
        ? bead.relevantFiles.map((f) => `- ${f}`).join('\n')
        : '- (coordinator did not pre-resolve files — discover as needed)';
    const priorArtBlock = bead.priorArtBeads.length > 0
        ? bead.priorArtBeads.map((b) => `- ${b}`).join('\n')
        : '- (none)';
    const acceptanceBlock = bead.acceptance.map((a) => `- ${a}`).join('\n');
    const mail = agentMailSteps(bead, identity, completionLength);
    const prompt = [
        '## STEP 0 — AGENT MAIL BOOTSTRAP (MANDATORY — DO THIS BEFORE ANYTHING ELSE)',
        'Do NOT read any files or run any commands until all 4 sub-steps below are complete.',
        '',
        ...mail.bootstrap,
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
        ...mail.report,
        '',
        buildPreCompletionQualityGate(bead),
    ].join('\n');
    return {
        provider: identity.provider,
        prompt,
        trailingNewlines: 1,
    };
}
export function adaptPromptForClaude(bead) {
    return adaptPromptForTerminal(bead, {
        provider: 'claude',
        program: 'claude-code',
        model: 'claude',
        agentMail: 'mcp',
    });
}
export function adaptPromptForPi(bead) {
    return adaptPromptForTerminal(bead, {
        provider: 'pi',
        program: 'pi',
        model: 'pi',
        agentMail: 'cli',
    });
}
/** The Gemini lane is a Pi pane running {@link CURRENT_GEMINI_MODEL_ID}. */
export function adaptPromptForGemini(bead) {
    return adaptPromptForTerminal(bead, {
        provider: 'gemini',
        program: 'pi',
        model: CURRENT_GEMINI_MODEL_ID,
        agentMail: 'cli',
    });
}
export function adaptPromptForAgy(bead) {
    return adaptPromptForTerminal(bead, {
        provider: 'agy',
        program: 'agy',
        model: 'agy',
        agentMail: 'cli',
    });
}
//# sourceMappingURL=claude-prompt.js.map