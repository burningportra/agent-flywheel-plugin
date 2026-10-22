import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetSkillsBundleCache } from '../../skills-bundle.js';
import { _resetLoadedSkillsLedger, runGetSkill } from '../../tools/get-skill.js';
import { runReview } from '../../tools/review.js';
import { makeState } from '../helpers/mocks.js';
const REPO_ROOT = resolve(__dirname, '../../../..');
const START_SKILL_PATH = resolve(REPO_ROOT, 'skills/start/SKILL.md');
describe('resume-path phase skill load (agent-flywheel-plugin-ni8)', () => {
    const startSkill = readFileSync(START_SKILL_PATH, 'utf8');
    beforeEach(() => {
        _resetLoadedSkillsLedger();
        _resetSkillsBundleCache();
    });
    afterEach(() => {
        _resetLoadedSkillsLedger();
        _resetSkillsBundleCache();
    });
    describe('skills/start/SKILL.md — unconditional resume-phase routing', () => {
        it('Universal Rule 3 makes phase-skill loading unconditional when state.phase !== "idle"', () => {
            const rule3Start = startSkill.indexOf('## UNIVERSAL RULE 3');
            const rule4Start = startSkill.indexOf('## UNIVERSAL RULE 4');
            expect(rule3Start).toBeGreaterThan(-1);
            expect(rule4Start).toBeGreaterThan(rule3Start);
            const rule3 = startSkill.slice(rule3Start, rule4Start);
            expect(rule3).toContain('state.phase !== "idle"');
            expect(rule3).toContain('first tool call');
            expect(rule3).toContain('must');
            expect(rule3).toContain('flywheel_get_skill({ cwd, name: "agent-flywheel:start_<phase>" })');
            expect(rule3).toContain('flywheel_review');
            expect(rule3).toMatch(/Review & loop \(`reviewing`\)\s*\|\s*`agent-flywheel:start_review`/);
        });
        it('Step 0 preflight and resume-session drift check require flywheel_get_skill(start_review) as the first tool call when state.phase = "reviewing"', () => {
            const preflightStart = startSkill.indexOf('### 0.preflight');
            const detectStart = startSkill.indexOf('### 0b. Detect state');
            expect(preflightStart).toBeGreaterThan(-1);
            expect(detectStart).toBeGreaterThan(preflightStart);
            const preflight = startSkill.slice(preflightStart, detectStart);
            expect(preflight).toContain('state.phase !== "idle"');
            expect(preflight).toContain('first tool call must be `flywheel_get_skill({ cwd, name: "agent-flywheel:start_<phase>" })`');
            expect(preflight).toContain('`state.phase = "reviewing"` → `agent-flywheel:start_review`');
            const driftStart = startSkill.indexOf('#### Resume session: drift check');
            const researchStart = startSkill.indexOf('#### Research repo');
            expect(driftStart).toBeGreaterThan(-1);
            expect(researchStart).toBeGreaterThan(driftStart);
            const driftSection = startSkill.slice(driftStart, researchStart);
            expect(driftSection).toContain('state.phase !== "idle"');
            expect(driftSection).toContain('first tool call must be `flywheel_get_skill({ cwd, name: "agent-flywheel:start_<phase>" })`');
            expect(driftSection).toContain('`state.phase = "reviewing"` → `agent-flywheel:start_review`');
            expect(driftSection).toContain('before calling `flywheel_review`');
        });
    });
    describe('server-side guard — flywheel_review requires start_review in a /start session', () => {
        it('rejects flywheel_review with start_review_not_loaded when state.phase = "reviewing" and start_review was not loaded after start', async () => {
            const cwd = REPO_ROOT;
            const state = makeState({
                phase: 'reviewing',
                selectedGoal: 'review the just-closed bead and record the verdict',
                activeBeadIds: ['eval-stub-1'],
                currentBeadId: 'eval-stub-1',
            });
            const ctx = {
                exec: async () => ({ code: 0, stdout: '', stderr: '' }),
                cwd,
                state,
                saveState: () => { },
                clearState: () => { },
            };
            const startLoad = await runGetSkill(ctx, { cwd, name: 'agent-flywheel:start' });
            expect(startLoad.structuredContent.status).toBe('ok');
            const blocked = await runReview(ctx, {
                cwd,
                beadId: 'eval-stub-1',
                action: 'hit-me',
            });
            expect(blocked.isError).toBe(true);
            expect(blocked.structuredContent).toMatchObject({
                tool: 'flywheel_review',
                status: 'error',
                phase: 'reviewing',
                data: {
                    kind: 'error',
                    error: {
                        code: 'missing_prerequisite',
                        details: {
                            reason: 'start_review_not_loaded',
                            requiredSkill: 'agent-flywheel:start_review',
                            phase: 'reviewing',
                        },
                    },
                },
            });
            expect(blocked.content[0]?.text).toContain('start_review_not_loaded');
            expect(blocked.content[0]?.text).toContain('agent-flywheel:start_review');
        });
        it('allows flywheel_review once flywheel_get_skill(agent-flywheel:start_review) is called first (including array-shaped br show output)', async () => {
            const cwd = REPO_ROOT;
            const state = makeState({
                phase: 'reviewing',
                selectedGoal: 'review the just-closed bead and record the verdict',
                activeBeadIds: ['eval-stub-1'],
                currentBeadId: 'eval-stub-1',
            });
            const ctx = {
                exec: async (cmd, args) => {
                    if (cmd === 'br' && args[0] === 'show') {
                        return {
                            code: 0,
                            stdout: JSON.stringify([
                                {
                                    id: 'eval-stub-1',
                                    title: 'Review stub for s7',
                                    description: 'Eval fixture bead',
                                    status: 'closed',
                                },
                            ]),
                            stderr: '',
                        };
                    }
                    if (cmd === 'br' && args[0] === 'ready') {
                        return { code: 0, stdout: '[]', stderr: '' };
                    }
                    return { code: 0, stdout: '[]', stderr: '' };
                },
                cwd,
                state,
                saveState: () => { },
                clearState: () => { },
            };
            await runGetSkill(ctx, { cwd, name: 'agent-flywheel:start' });
            await runGetSkill(ctx, { cwd, name: 'agent-flywheel:start_review' });
            const hitMe = await runReview(ctx, {
                cwd,
                beadId: 'eval-stub-1',
                action: 'hit-me',
            });
            expect(hitMe.isError).toBeUndefined();
            expect(hitMe.structuredContent.status).toBe('ok');
        });
    });
});
//# sourceMappingURL=resume-path-phase-skill-load.test.js.map