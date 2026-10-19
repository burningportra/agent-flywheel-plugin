import { describe, expect, it } from 'vitest';
import { adaptPromptForClaude, adaptPromptForGemini } from '../../adapters/claude-prompt.js';
import { adaptPromptForCodex, } from '../../adapters/codex-prompt.js';
import { CompletionReportSchemaV1 } from '../../completion-report.js';
const context = {
    beadId: 'agent-flywheel-plugin-test-bead',
    title: 'Require completion evidence',
    description: 'Add the durable completion attestation to implementer prompts.',
    acceptance: ['Every provider names the exact completion report path.'],
    complexity: 'complex',
    relevantFiles: ['mcp-server/src/adapters/codex-prompt.ts'],
    priorArtBeads: [],
    agentName: 'AmberBrook',
    coordinatorName: 'WindyBasin',
    projectKey: '/workspace/agent-flywheel-plugin',
};
const adapters = [
    ['claude', adaptPromptForClaude],
    ['codex', adaptPromptForCodex],
    ['gemini', adaptPromptForGemini],
];
function completionReportExample(prompt) {
    const match = prompt.match(/## PRE-COMPLETION QUALITY GATE[\s\S]*?```json\n(?<json>[\s\S]*?)\n```/u);
    const json = match?.groups?.json;
    if (!json) {
        throw new Error('completion report JSON example missing from prompt');
    }
    const replacements = [
        ['<pane-name-or-omit>', 'agent-flywheel--wave-2__cod_1'],
        ['<repo-relative-path>', 'mcp-server/src/adapters/codex-prompt.ts'],
        ['<short-sha>', 'abc1234'],
        ['<repo-verify-command>', 'npx vitest run'],
        ['<verify-summary>', 'all green'],
        ['<self-review-summary>', 'no regressions found'],
        ['<ISO-8601 timestamp>', '2026-10-15T14:00:00.000Z'],
    ];
    const materialized = replacements.reduce((value, [placeholder, fixture]) => value.replaceAll(placeholder, fixture), json);
    try {
        const parsed = JSON.parse(materialized);
        return parsed;
    }
    catch (error) {
        throw new Error(`completion report example is not valid JSON: ${String(error)}`);
    }
}
describe.each(adapters)('%s completion attestation prompt', (_provider, adapt) => {
    it('names the bead-specific completion path and all quality gates', () => {
        const prompt = adapt(context).prompt;
        expect(prompt).toContain('.pi-flywheel/completion/agent-flywheel-plugin-test-bead.json');
        expect(prompt).toContain('/ubs-workflow');
        expect(prompt).toContain('changed-files mode');
        expect(prompt).toContain("repository's documented verify commands");
        expect(prompt).not.toContain('AGENTS.md');
        expect(prompt).toContain('fresh-eyes self-review');
    });
    it('renders a worked example that conforms to CompletionReportSchemaV1', () => {
        const report = CompletionReportSchemaV1.parse(completionReportExample(adapt(context).prompt));
        expect(report.beadId).toBe(context.beadId);
        expect(report.agentName).toBe(context.agentName);
    });
});
//# sourceMappingURL=completion-attestation-prompt.test.js.map