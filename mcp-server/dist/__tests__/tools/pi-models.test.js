import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPiModels } from '../../tools/pi-models.js';
import { createInitialState } from '../../types.js';
function model(id, name, released) {
    return {
        id,
        name,
        type: 'language',
        owned_by: id.split('/')[0],
        released,
        tags: ['tool-use', 'reasoning'],
        context_window: 200_000,
        pricing: { input: '0.0000002', output: '0.0000008' },
    };
}
const DAY_S = 86_400;
const nowS = Date.now() / 1000;
const CATALOG = [
    model('deepseek/deepseek-v4.1-flash-1017', 'DeepSeek V4.1 Flash 1017', nowS - 30 * DAY_S),
    model('deepseek/deepseek-v4.1-flash-1017-fast', 'DeepSeek V4.1 Flash 1017 Fast', nowS - 30 * DAY_S),
    model('zai/glm-5.3', 'GLM 5.3', nowS - 40 * DAY_S),
    model('openai/gpt-6-luna', 'GPT-6 Luna', nowS - 40 * DAY_S),
];
const TOKEN_SHARE = { 'DeepSeek V4.1 Flash 1017': 29.43, 'GLM 5.3': 12.24, 'GPT-6 Luna': 6.42 };
function data(result) {
    return result.structuredContent.data;
}
describe('flywheel_pi_models', () => {
    let cwd;
    let piAuth;
    let exec;
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), 'flywheel-pi-models-'));
        piAuth = { code: 0, stdout: 'ready\n' };
        exec = vi.fn(async (cmd, args) => {
            if (cmd === 'pi' && args[0] === 'auth')
                return { ...piAuth, stderr: '' };
            return { code: 7, stdout: '', stderr: 'curl: (7) Failed to connect' };
        });
    });
    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
    });
    async function seedCache() {
        const snapshot = {
            version: 1,
            fetchedAt: new Date().toISOString(),
            catalog: CATALOG,
            tokenShare: TOKEN_SHARE,
        };
        await mkdir(join(cwd, '.pi-flywheel', 'cache'), { recursive: true });
        await writeFile(join(cwd, '.pi-flywheel', 'cache', 'gateway-models.json'), JSON.stringify(snapshot));
    }
    function ctx() {
        return {
            cwd,
            exec,
            state: createInitialState(),
            saveState: vi.fn(),
            clearState: vi.fn(),
            signal: new AbortController().signal,
        };
    }
    it('lists ranked candidates and one implementer question by default', async () => {
        await seedCache();
        const result = await runPiModels(ctx(), { action: 'list' });
        expect(result.isError).toBeUndefined();
        const listed = data(result);
        expect(listed).toMatchObject({
            kind: 'pi_models_listed',
            provider: 'vercel-ai-gateway',
            source: { catalog: 'https://ai-gateway.vercel.sh/v1/models', stale: false },
        });
        expect(listed.candidates.map((candidate) => candidate.id)).toEqual([
            'deepseek/deepseek-v4.1-flash-1017',
            'zai/glm-5.3',
            'openai/gpt-6-luna',
        ]);
        const questions = listed.questions;
        expect(questions.map((question) => question.role)).toEqual(['implementer']);
        expect(questions[0]?.options[0]?.label).toBe('DeepSeek V4.1 Flash 1017 (Recommended)');
        expect(result.content[0]?.text).toContain('1. DeepSeek V4.1 Flash 1017 (vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017), 29.43% of tokens');
        expect(exec).not.toHaveBeenCalled();
    });
    it('asks the deep-plan roles in order with defaults from different labs', async () => {
        await seedCache();
        const result = await runPiModels(ctx(), { action: 'list', roles: ['robustness', 'ergonomics'] });
        const questions = data(result).questions;
        expect(questions.map((question) => [question.role, question.options[0]?.piModel])).toEqual([
            ['robustness', 'vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017'],
            ['ergonomics', 'vercel-ai-gateway/zai/glm-5.3'],
        ]);
    });
    it('resolves the answers, saves them, reports Pi readiness, and leads the next list with them', async () => {
        await seedCache();
        const chosen = await runPiModels(ctx(), {
            action: 'choose',
            picks: { robustness: 'GPT-6 Luna', ergonomics: 'zai/glm-5.3 (Recommended)' },
        });
        expect(chosen.isError).toBeUndefined();
        expect(data(chosen)).toMatchObject({
            kind: 'pi_models_chosen',
            piModels: {
                robustness: 'vercel-ai-gateway/openai/gpt-6-luna',
                ergonomics: 'vercel-ai-gateway/zai/glm-5.3',
            },
            piReady: true,
            authDetail: 'ready',
        });
        const saved = JSON.parse(await readFile(join(cwd, '.pi-flywheel', 'pi-models.json'), 'utf8'));
        expect(saved.picks.robustness?.id).toBe('openai/gpt-6-luna');
        const relisted = await runPiModels(ctx(), { action: 'list', roles: ['robustness'] });
        const [question] = data(relisted).questions;
        expect(question?.options[0]?.label).toBe('GPT-6 Luna (Recommended)');
        expect(question?.options[0]?.description).toMatch(/^Last used for this role\. /);
    });
    it('still saves the pick but reports piReady false when Pi has no gateway credentials', async () => {
        await seedCache();
        piAuth = { code: 1, stdout: 'not_ready\n' };
        const result = await runPiModels(ctx(), { action: 'choose', picks: { implementer: 'GLM 5.3' } });
        expect(data(result)).toMatchObject({ piReady: false, authDetail: 'not_ready' });
        expect(result.content[0]?.text).toContain('not ready (not_ready)');
    });
    it('rejects an answer the gateway does not list, with suggestions', async () => {
        await seedCache();
        const result = await runPiModels(ctx(), { action: 'choose', picks: { implementer: 'deepseek fast' } });
        expect(result.isError).toBe(true);
        expect(data(result)).toMatchObject({
            kind: 'error',
            error: {
                code: 'invalid_input',
                details: { role: 'implementer', answer: 'deepseek fast', suggestions: ['deepseek/deepseek-v4.1-flash-1017-fast'] },
                hint: 'Did you mean one of: deepseek/deepseek-v4.1-flash-1017-fast?',
            },
        });
    });
    it('rejects choose without picks and an unknown role', async () => {
        await seedCache();
        const noPicks = await runPiModels(ctx(), { action: 'choose' });
        const badRole = await runPiModels(ctx(), { action: 'list', roles: ['reviewer'] });
        expect(noPicks.isError).toBe(true);
        expect(data(noPicks)).toMatchObject({ error: { code: 'invalid_input' } });
        expect(badRole.isError).toBe(true);
        expect(data(badRole)).toMatchObject({ error: { code: 'invalid_input', details: { field: 'roles.0' } } });
    });
    it('fails retryably when the gateway is unreachable and nothing is cached', async () => {
        const result = await runPiModels(ctx(), { action: 'list' });
        expect(result.isError).toBe(true);
        expect(data(result)).toMatchObject({
            kind: 'error',
            error: { code: 'missing_prerequisite', retryable: true },
        });
        expect(data(result).error.hint).toContain('treat the Pi lanes as unavailable');
    });
});
//# sourceMappingURL=pi-models.test.js.map