/**
 * Size guard for the `flywheel_get_skill({ name: "agent-flywheel:start" })`
 * result (bead agent-flywheel-plugin-8fg).
 *
 * Claude Code shows the model a tool result inline only while its text stays
 * under a persist threshold. Above it, Claude Code saves the result to a file,
 * prints "Output too large (<size>)", and hands the model a preview, so the
 * start screen spends 3 to 4 extra turns reading the skill back with Bash and
 * Read. Measured on 2026-10-19 (bead agent-flywheel-plugin-d7o): 45.7 KB of
 * structured JSON arrived inline at v3.24.0, and 55.7 KB was persisted, which
 * moved the median start from 34.6 s to 45.2 s and from 4 to 6 turns.
 *
 * The exact threshold, read from the Claude Code 2.1.307 binary: a result is
 * persisted when its text length exceeds `min(tool.maxResultSizeChars, 50000)`,
 * and MCP tools set `maxResultSizeChars: 1e5`, so the limit is 50,000
 * characters (JavaScript string length, not bytes). The GrowthBook flag
 * `tengu_velvet_ibis` can override it per tool.
 *
 * The budget is 48,000 characters: 2,000 below that limit, which covers the
 * `source`/`staleWarn`/`pluginVersion` fields varying between installs and
 * any small wrapper Claude Code adds, while leaving the start skill room to
 * grow. `prompt-budget` caps each change at 10% growth; this catches growth
 * that builds up over many changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetSkillsBundleCache } from '../../skills-bundle.js';
import { runGetSkill } from '../../tools/get-skill.js';
import { makeState } from '../helpers/mocks.js';
const CLAUDE_CODE_PERSIST_THRESHOLD_CHARS = 50_000;
const START_SKILL_RESULT_BUDGET_CHARS = 48_000;
describe('flywheel_get_skill start skill inline budget', () => {
    beforeEach(() => {
        // Read skills/start/SKILL.md from disk so a source edit trips this test
        // before dist/skills.bundle.json is rebuilt.
        vi.stubEnv('FW_SKILL_BUNDLE', 'off');
        vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
        _resetSkillsBundleCache();
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        _resetSkillsBundleCache();
    });
    it('keeps the structured result under the inline budget', async () => {
        const cwd = process.cwd();
        const result = await runGetSkill({
            exec: async () => ({ code: 0, stdout: '', stderr: '' }),
            cwd,
            state: makeState(),
            saveState: () => { },
            clearState: () => { },
        }, { cwd, name: 'agent-flywheel:start' });
        const structured = result.structuredContent;
        expect(structured.status).toBe('ok');
        expect(structured.data.skill.body.length).toBeGreaterThan(1_000);
        const size = JSON.stringify(result.structuredContent).length;
        expect(size, `flywheel_get_skill(agent-flywheel:start) structured result is ${size} chars, over the ` +
            `${START_SKILL_RESULT_BUDGET_CHARS}-char budget. Claude Code persists results above ` +
            `${CLAUDE_CODE_PERSIST_THRESHOLD_CHARS} chars (measured: 45.7 KB inline, 55.7 KB persisted ` +
            `as "Output too large"), costing the start screen 3-4 extra turns. Trim skills/start/SKILL.md ` +
            `or move content into a sub-skill. See bead agent-flywheel-plugin-8fg.`).toBeLessThanOrEqual(START_SKILL_RESULT_BUDGET_CHARS);
    });
});
//# sourceMappingURL=get-skill-inline-budget.test.js.map