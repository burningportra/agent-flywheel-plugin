import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { AGENT_MAIL_CLI_TIMEOUT_GUARD, AGENT_MAIL_CLI_TIMEOUT_SECONDS, adaptPromptForAgy, adaptPromptForClaude, adaptPromptForGemini, adaptPromptForPi, } from '../adapters/claude-prompt.js';
const context = {
    beadId: 'b1',
    title: 't',
    description: 'd',
    acceptance: ['a'],
    complexity: 'simple',
    relevantFiles: [],
    priorArtBeads: [],
    agentName: 'AmberBrook',
    coordinatorName: 'WindyBasin',
    projectKey: '/tmp',
};
describe('Agent Mail CLI timeout guard', () => {
    it('caps am commands at 10 seconds with a perl alarm that survives exec', () => {
        expect(AGENT_MAIL_CLI_TIMEOUT_SECONDS).toBe(10);
        expect(AGENT_MAIL_CLI_TIMEOUT_GUARD).toBe("perl -e 'alarm 10; exec @ARGV' --");
    });
    it('passes the wrapped command and its arguments through unchanged', () => {
        const out = execFileSync('sh', ['-c', `${AGENT_MAIL_CLI_TIMEOUT_GUARD} printf '%s|' am mail send 'two words'`], {
            encoding: 'utf8',
            timeout: 5_000,
        });
        expect(out).toBe('am|mail|send|two words|');
    });
    it.each([
        ['agy', adaptPromptForAgy],
        ['pi', adaptPromptForPi],
        ['gemini', adaptPromptForGemini],
    ])('%s prompt guards every am command and says to carry on after a timeout', (_name, adapt) => {
        const { prompt } = adapt(context);
        const bootstrap = prompt.slice(0, prompt.indexOf('0a. am macros start-session'));
        expect(bootstrap).toContain(`behind \`${AGENT_MAIL_CLI_TIMEOUT_GUARD}\``);
        expect(bootstrap).toContain('0a-0c and STEP 4');
        expect(bootstrap).toContain('exit 142');
        expect(bootstrap).toContain("don't retry it in a loop or run `am doctor`: carry on with the bead");
        expect(prompt).toContain('Keep the 10s guard on every `am` command.');
    });
    it('claude prompt keeps MCP tools and proceeds past an Agent Mail call slower than 10s', () => {
        const { prompt } = adaptPromptForClaude(context);
        const step0d = prompt.split('\n').find((line) => line.startsWith('0d.'));
        expect(step0d).toContain('If an Agent Mail MCP call takes longer than 10s');
        expect(step0d).toContain('proceed without it instead of retrying in a loop or running `am doctor`');
        expect(prompt).not.toContain(AGENT_MAIL_CLI_TIMEOUT_GUARD);
    });
});
//# sourceMappingURL=claude-prompt.test.js.map