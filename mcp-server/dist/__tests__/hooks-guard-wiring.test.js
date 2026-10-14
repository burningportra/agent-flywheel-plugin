/**
 * The Agent Mail guard as Claude Code actually invokes it.
 *
 * `opencode/fixtures/hooks/run-corpus.mjs` proves the guard script makes the
 * right decision, but Claude Code runs the `command` string from
 * `hooks/hooks.json`, and only exit 2 blocks a tool call. From 2026-05-02 until
 * this test landed the guard ran behind `|| true` and then `_run-hook.sh`,
 * both of which turn exit 2 into 0, so the guard blocked nothing. This test
 * runs each `PreToolUse[Bash]` handler's exact command through `sh -c`.
 *
 * Each handler carries an `if` permission rule so Claude Code (2.1.85+) skips
 * spawning it for unrelated Bash commands. The harness matches parsed
 * subcommands case-sensitively; for rules of the form `Bash(*text*)` that is
 * equivalent to a substring match on the whole command, which is the model
 * used here (checked against Claude Code 2.1.300 in
 * docs/speedup/hook-and-doctor/baseline.md).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const hooksJson = JSON.parse(readFileSync(`${REPO_ROOT}hooks/hooks.json`, 'utf8'));
const corpus = JSON.parse(readFileSync(`${REPO_ROOT}opencode/fixtures/hooks/guard-corpus.json`, 'utf8'));
const bashHandlers = (hooksJson.hooks.PreToolUse ?? [])
    .filter((group) => group.matcher === 'Bash')
    .flatMap((group) => group.hooks);
function ruleMatches(rule, command) {
    const inner = /^Bash\((.*)\)$/.exec(rule)?.[1];
    if (inner === undefined)
        throw new Error(`unsupported if rule: ${rule}`);
    const pattern = inner
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
    return new RegExp(`^${pattern}$`, 's').test(command);
}
function handlersFor(command) {
    return bashHandlers.filter((h) => h.if !== undefined && ruleMatches(h.if, command));
}
function runHandler(handler, c) {
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: REPO_ROOT, ...c.env };
    delete env.CLAUDE_TOOL_INPUT;
    if (!c.env?.FLYWHEEL_ALLOW_AM_DOCTOR)
        delete env.FLYWHEEL_ALLOW_AM_DOCTOR;
    const result = spawnSync('sh', ['-c', handler.command], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: c.command } }),
        env,
        timeout: 10_000,
        encoding: 'utf8',
    });
    return result.status;
}
describe('PreToolUse[Bash] Agent Mail guard wiring', () => {
    it('gates every handler with an if rule and never routes through the warn-only wrapper', () => {
        expect(bashHandlers.length).toBeGreaterThan(0);
        for (const handler of bashHandlers) {
            expect(handler.if).toMatch(/^Bash\(.+\)$/);
            expect(handler.command).not.toContain('_run-hook.sh');
            expect(handler.command).not.toContain('|| true');
        }
    });
    it('spawns no handler for everyday commands', () => {
        for (const command of ['ls -la', 'git status', 'npm test', 'cd mcp-server && npm run build']) {
            expect(handlersFor(command), command).toEqual([]);
        }
    });
    it.each(corpus.cases.filter((c) => c.expect === 'block'))('blocks $id with exit 2', (c) => {
        const handlers = handlersFor(c.command);
        expect(handlers.length, `no if rule matches ${JSON.stringify(c.command)}`).toBeGreaterThan(0);
        for (const handler of handlers)
            expect(runHandler(handler, c)).toBe(2);
    });
    it.each(corpus.cases.filter((c) => c.expect === 'allow'))('allows $id', (c) => {
        for (const handler of handlersFor(c.command))
            expect(runHandler(handler, c)).toBe(0);
    });
});
//# sourceMappingURL=hooks-guard-wiring.test.js.map