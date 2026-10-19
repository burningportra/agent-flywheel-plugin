/**
 * Claude prompt adapter.
 *
 * Claude is the baseline — its prompt mirrors the existing Step 7
 * template in `skills/start/_implement.md` so behavior is unchanged for
 * Claude panes when model diversity is enabled. Kept as its own file so
 * the three providers expose a symmetric interface.
 */
import { buildPreCompletionQualityGate } from './completion-attestation-prompt.js';
const AGENT_MAIL_SAFETY = 'Do NOT run `am doctor repair`, `am doctor archive-normalize`, or delete `.mailbox.activity.lock`; if Agent Mail looks busy/unhealthy, report it to the coordinator and ask them to run `flywheel_remediate({ checkName: "agent_mail_liveness", mode: "execute", autoConfirm: true })`.';
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
                `0d. Agent Mail runtime safety: use the Agent Mail MCP/HTTP tools only. ${AGENT_MAIL_SAFETY}`,
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
            `0a. am macros start-session --project ${project} --program ${identity.program} --model ${identity.model} --agent-name ${agent} --task ${shellQuote(task)} --json`,
            `0b. am file_reservations reserve ${project} ${agent} <path>... --exclusive --ttl 3600 --reason ${shellQuote(bead.beadId)} for every file you plan to edit. If the output lists conflicts, retry 3x with 30s backoff.`,
            `0c. ${send(`[impl] ${bead.beadId} started`, "'started'")}`,
            `0d. Agent Mail runtime safety: ${AGENT_MAIL_SAFETY}`,
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
//# sourceMappingURL=claude-prompt.js.map