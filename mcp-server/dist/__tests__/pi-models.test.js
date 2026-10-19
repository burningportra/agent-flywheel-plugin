import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPiCandidates, buildPiModelQuestions, checkPiLaneReady, checkPiProviderAuth, discoverPiRoutes, GATEWAY_CATALOG_URL, GATEWAY_LEADERBOARD_URL, GEMINI_LANE_MODEL, isLaneEligible, loadGatewaySnapshot, matchGatewayModel, parsePiModelList, rankPiModels, readGeminiLaneListing, readPiModelPicks, resolvePiModelAnswer, summarizeShare, writePiModelPicks, } from '../pi-models.js';
const NOW = new Date('2026-10-19T12:00:00.000Z');
const DAY_S = 86_400;
const nowS = NOW.getTime() / 1000;
function price(input, output) {
    return { input: String(input / 1e6), output: String(output / 1e6) };
}
function model(id, name, overrides = {}) {
    return {
        id,
        name,
        type: 'language',
        owned_by: id.split('/')[0],
        released: nowS - 60 * DAY_S,
        tags: ['tool-use', 'reasoning'],
        context_window: 1_000_000,
        pricing: price(1, 4),
        ...overrides,
    };
}
const ago = (days) => nowS - days * DAY_S;
const CATALOG = [
    model('meta/muse-wonder-1.0', 'Muse Wonder', { released: ago(8), pricing: price(4, 20) }),
    model('meta/muse-spark-1.3', 'Muse Spark 1.3', { released: ago(48), pricing: price(1.25, 4.25) }),
    model('meta/muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor', { released: ago(48), pricing: price(0.05, 0.2) }),
    model('spacexai/grok-4.7', 'Grok 4.7', { released: ago(29), pricing: price(2, 6) }),
    model('spacexai/grok-4.7-fast', 'Grok 4.7 Fast', { released: ago(29), pricing: price(4, 12) }),
    model('spacexai/grok-4.6', 'Grok 4.6', { released: ago(69), pricing: price(2, 6) }),
    model('spacexai/grok-3', 'Grok 3', { released: ago(400), pricing: price(3, 15) }),
    model('zai/glm-5.3', 'GLM 5.3', { released: ago(63), pricing: price(1.4, 4.4) }),
    model('zai/glm-5.3-flash', 'GLM 5.3 Flash', { released: ago(55), pricing: price(0.1, 0.5) }),
    model('openai/gpt-6.1-sol', 'GPT-6.1 Sol', { released: ago(21), pricing: price(2, 10) }),
    model('openai/gpt-6-astra', 'GPT-6 Astra', { released: ago(46), pricing: price(10, 50) }),
    model('openai/gpt-5.5-pro', 'GPT-5.5 Pro', { released: ago(179), pricing: price(30, 180) }),
    model('openai/gpt-5.6-terra', 'GPT 5.6 Terra', { released: ago(103), pricing: price(2, 12) }),
    model('openai/gpt-6-luna', 'GPT-6 Luna', { released: ago(28), pricing: price(0.1, 0.5) }),
    model('moonshotai/kimi-k3', 'Kimi K3', { released: ago(96), pricing: price(3, 15) }),
    model('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', { released: ago(42), pricing: price(0.07, 0.3) }),
    model('deepseek/deepseek-v4.1-flash-1017', 'DeepSeek V4.1 Flash 1017', { released: ago(3), pricing: price(0.07, 0.3) }),
    model('deepseek/deepseek-v4.1-flash-1017-fast', 'DeepSeek V4.1 Flash 1017 Fast', { released: ago(3), pricing: price(0.6, 2.4) }),
    model('deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro', { released: ago(180), pricing: price(0.5, 1.98) }),
    model('quiverai/arrow-2-telos', 'Arrow 2 Telos', { released: ago(34), pricing: price(6, 30) }),
    model('liquid/lfm2.5', 'LFM2.5', { released: ago(7), pricing: price(0.1, 0.7) }),
    model('anthropic/claude-opus-5.5', 'Claude Opus 5.5'),
    model('stealth/trial-model', 'Trial Model'),
    model('moonshotai/kimi-k3-free', 'Kimi K3 Free', { tags: ['tool-use', 'free'] }),
    model('openai/gpt-6-luna-batch', 'GPT-6 Luna Batch'),
    model('meta/muse-spark-open', 'Muse Spark Open', { tags: ['reasoning'] }),
    model('mistral/mistral-old', 'Mistral Old', { deprecated_at: nowS - DAY_S }),
    model('openai/text-embedding-9', 'Text Embedding 9', { type: 'embedding' }),
    model('bad/id:high', 'Bad Id'),
];
const SNAPSHOT = {
    catalog: CATALOG,
    tokenShare: {
        'DeepSeek V4.1 Flash': 25.65,
        'DeepSeek V4.1 Flash 1017': 3.78,
        'GLM 5.3': 12.15,
        'GLM 5.3 Flash': 8.16,
        'GPT-6 Luna': 6.44,
        'Kimi K3': 2.46,
        'Claude Opus 5.5': 6.67,
    },
    spendShare: {
        'GLM 5.3': 22.51,
        'Kimi K3': 7.44,
        'GPT-6.1 Sol': 3.63,
        'GPT-6 Astra': 3.16,
        'Grok 4.7': 3.45,
        'DeepSeek V4.1 Flash': 2.18,
        'Claude Opus 5.5': 15.86,
    },
};
function route(provider, name, gatewayId, authType, fastPiModel = null) {
    return { provider, model: name, piModel: `${provider}/${name}`, gatewayId, fastPiModel, authType };
}
const DIRECT = [
    route('meta', 'muse-wonder-1.0', 'meta/muse-wonder-1.0', 'oauth'),
    route('meta', 'muse-spark-1.3', 'meta/muse-spark-1.3', 'oauth'),
    route('meta', 'muse-spark-1.3-contributor', 'meta/muse-spark-1.3-contributor', 'oauth'),
    route('xai', 'grok-4.7', 'spacexai/grok-4.7', 'oauth', 'xai/grok-4.7-fast'),
    route('xai', 'grok-4.6', 'spacexai/grok-4.6', 'oauth'),
    route('zai', 'glm-5.3', 'zai/glm-5.3', 'api_key'),
    route('zai', 'glm-5.3-flash', 'zai/glm-5.3-flash', 'api_key'),
    route('openai-codex', 'gpt-5.6-terra', 'openai/gpt-5.6-terra', 'oauth'),
    route('openai-codex', 'gpt-6-luna', 'openai/gpt-6-luna', 'oauth'),
    route('openai', 'gpt-6-astra', 'openai/gpt-6-astra', 'api_key'),
    route('anthropic', 'claude-opus-5.5', 'anthropic/claude-opus-5.5', 'oauth'),
];
const ALL = buildPiCandidates(SNAPSHOT, { now: NOW, directRoutes: DIRECT, gatewayReady: true });
const GATEWAY_ONLY = buildPiCandidates(SNAPSHOT, { now: NOW, directRoutes: [], gatewayReady: true });
const FRONTIER = rankPiModels(ALL, { profile: 'frontier' });
const BALANCED = rankPiModels(ALL, { profile: 'balanced' });
describe('isLaneEligible', () => {
    it.each([
        ['anthropic/claude-opus-5.5', 'Claude has its own lane'],
        ['stealth/trial-model', 'anonymous trial model'],
        ['moonshotai/kimi-k3-free', 'free tier'],
        ['openai/gpt-6-luna-batch', 'batch endpoint'],
        ['meta/muse-spark-open', 'no tool-use tag'],
        ['mistral/mistral-old', 'deprecated'],
        ['openai/text-embedding-9', 'not a language model'],
        ['bad/id:high', 'unsafe for pi --model'],
    ])('rejects %s (%s)', (id) => {
        expect(isLaneEligible(CATALOG.find((entry) => entry.id === id), NOW)).toBe(false);
    });
    it('accepts a tool-calling model with a plain id, and one whose deprecation is still ahead', () => {
        expect(isLaneEligible(CATALOG[0], NOW)).toBe(true);
        expect(isLaneEligible(model('zai/glm-5.2', 'GLM 5.2', { deprecated_at: '2027-01-01T00:00:00Z' }), NOW)).toBe(true);
    });
    it('offers gemini-4-argon, with its dated snapshots and speed variants, as the only Gemini model', () => {
        const eligible = (id) => isLaneEligible(model(id, id), NOW);
        expect(['google/gemini-4-argon', 'google/gemini-4-argon-1017', 'google/gemini-4-argon-fast'].map(eligible))
            .toEqual([true, true, true]);
        expect(['google/gemini-3-pro', 'google/gemini-3.1-flash-preview', 'google/gemini-4-argon-lite', 'vertex/Gemini-4-Argonaut'].map(eligible))
            .toEqual([false, false, false, false]);
        expect(eligible('google/gemma-4')).toBe(true);
        expect(GEMINI_LANE_MODEL).toBe('vercel-ai-gateway/google/gemini-4-argon');
    });
});
describe('summarizeShare', () => {
    const dates = ['10-10', '10-11', '10-12', '10-13', '10-14', '10-15', '10-16', '10-17'].map((day) => `2026-${day}`);
    const rows = [
        ...dates.map((date) => ({ date, name: 'GLM 5.3', metric: 'tokens', share_percent: 10 })),
        { date: '2026-10-17', name: 'Kimi K3', metric: 'tokens', share_percent: 7 },
        { date: '2026-10-17', name: 'Other', metric: 'tokens', share_percent: 50 },
        { date: '2026-10-16', name: 'GLM 5.3', metric: 'spend', share_percent: 3 },
        { date: '2026-10-17', name: 'GLM 5.3', metric: 'spend', share_percent: 5 },
        { date: '2026-10-17', name: 'GLM 5.3', metric: 'requests', share_percent: 90 },
    ];
    it('averages one metric over its own latest seven dates, counting absent days as zero', () => {
        expect(summarizeShare(rows, 'tokens')).toEqual({ 'GLM 5.3': 10, 'Kimi K3': 1 });
        expect(summarizeShare(rows, 'spend')).toEqual({ 'GLM 5.3': 4 });
    });
    it('returns nothing for a metric with no rows', () => {
        expect(summarizeShare(rows.filter((row) => row.metric !== 'spend'), 'spend')).toEqual({});
    });
});
describe('parsePiModelList', () => {
    it('reads provider and model columns, skipping the header, gateway ids, and unsafe ids', () => {
        const stdout = [
            'provider           model           context  max-out  thinking  images',
            'xai                grok-4.7        500K     64K      yes       yes',
            'zai                glm-5.3         1M       128K     yes       no',
            'vercel-ai-gateway  zai/glm-5.3     1M       128K     yes       no',
            'bad                id:high         1M       128K     yes       no',
            '',
        ].join('\n');
        expect(parsePiModelList(stdout)).toEqual([
            { provider: 'xai', model: 'grok-4.7' },
            { provider: 'zai', model: 'glm-5.3' },
        ]);
    });
});
describe('matchGatewayModel', () => {
    it('matches the slug after the lab prefix, then a unique brand-dropping suffix', () => {
        expect(matchGatewayModel('grok-4.7', CATALOG)?.id).toBe('spacexai/grok-4.7');
        expect(matchGatewayModel('k3', CATALOG)?.id).toBe('moonshotai/kimi-k3');
    });
    it('refuses an ambiguous or unknown suffix', () => {
        expect(matchGatewayModel('flash', CATALOG)).toBeUndefined();
        expect(matchGatewayModel('glm-9', CATALOG)).toBeUndefined();
    });
});
describe('buildPiCandidates', () => {
    const byPiModel = (piModel) => ALL.find((candidate) => candidate.piModel === piModel);
    it('keeps working direct routes with gateway data, and skips ones the lanes cannot use', () => {
        expect(byPiModel('xai/grok-4.7')).toMatchObject({
            route: 'direct',
            provider: 'xai',
            gatewayId: 'spacexai/grok-4.7',
            lab: 'spacexai',
            spendSharePercent: 3.45,
            tokenSharePercent: null,
            outputPerMTok: 6,
            released: '2026-09-20',
            fastPiModel: 'xai/grok-4.7-fast',
            authType: 'oauth',
        });
        expect(byPiModel('anthropic/claude-opus-5.5')).toBeUndefined();
    });
    it('adds one gateway candidate per family, the newest dated snapshot standing for it', () => {
        const gateway = ALL.filter((candidate) => candidate.route === 'gateway');
        expect(gateway.every((candidate) => !candidate.gatewayId.endsWith('-fast'))).toBe(true);
        expect(gateway.map((candidate) => candidate.gatewayId)).not.toContain('deepseek/deepseek-v4.1-flash');
        expect(byPiModel('vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017')).toMatchObject({
            tokenSharePercent: 29.43,
            spendSharePercent: 2.18,
            isNew: true,
            fastPiModel: 'vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017-fast',
            authType: 'api_key',
        });
    });
    it('prices each model against its lab reference: the most-paid-for model, else the priciest', () => {
        expect(byPiModel('openai-codex/gpt-5.6-terra')?.tierRatio).toBe(1.2);
        expect(byPiModel('openai-codex/gpt-6-luna')?.tierRatio).toBe(0.05);
        expect(byPiModel('meta/muse-spark-1.3')?.tierRatio).toBe(0.21);
        expect(byPiModel('meta/muse-wonder-1.0')?.tierRatio).toBe(1);
    });
    it('adds no gateway candidates without gateway credentials', () => {
        const direct = buildPiCandidates(SNAPSHOT, { now: NOW, directRoutes: DIRECT, gatewayReady: false });
        expect(direct.every((candidate) => candidate.route === 'direct')).toBe(true);
        expect(direct).toHaveLength(DIRECT.length - 1);
    });
});
describe('rankPiModels', () => {
    const ids = (list) => list.map((candidate) => candidate.piModel);
    it('ranks frontier flagships by list price, logins first, then gateway labs people pay for', () => {
        expect(ids(FRONTIER)).toEqual([
            'meta/muse-wonder-1.0',
            'openai-codex/gpt-5.6-terra',
            'xai/grok-4.7',
            'zai/glm-5.3',
            'vercel-ai-gateway/moonshotai/kimi-k3',
            'vercel-ai-gateway/deepseek/deepseek-v4-pro',
        ]);
    });
    it('prefers an account login over a metered API key for the same lab', () => {
        expect(ids(FRONTIER)).not.toContain('openai/gpt-6-astra');
        expect(ids(BALANCED)).not.toContain('openai/gpt-6-astra');
    });
    it('takes the most-paid-for flagship rather than a pro tier when only the gateway covers a lab', () => {
        expect(ids(rankPiModels(GATEWAY_ONLY, { profile: 'frontier' }))).toEqual([
            'vercel-ai-gateway/moonshotai/kimi-k3',
            'vercel-ai-gateway/openai/gpt-6.1-sol',
            'vercel-ai-gateway/spacexai/grok-4.7',
            'vercel-ai-gateway/zai/glm-5.3',
            'vercel-ai-gateway/deepseek/deepseek-v4-pro',
        ]);
    });
    it('ranks balanced picks by usage, then a login speed variant, then a mid-priced model', () => {
        expect(ids(BALANCED)).toEqual([
            'zai/glm-5.3',
            'xai/grok-4.7-fast',
            'meta/muse-spark-1.3',
            'openai-codex/gpt-5.6-terra',
            'vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017',
            'vercel-ai-gateway/moonshotai/kimi-k3',
            'vercel-ai-gateway/liquid/lfm2.5',
        ]);
        expect(BALANCED[1]).toMatchObject({ name: 'Grok 4.7 Fast', fastPiModel: null });
    });
    it('drops small tiers from frontier and nano tiers from both profiles', () => {
        expect(ids(FRONTIER).some((piModel) => /flash|luna|contributor/.test(piModel))).toBe(false);
        expect(ids(BALANCED).some((piModel) => /luna|contributor/.test(piModel))).toBe(false);
    });
    it('honours the limit', () => {
        expect(rankPiModels(ALL, { profile: 'balanced', limit: 2 })).toHaveLength(2);
    });
});
describe('buildPiModelQuestions', () => {
    const ranked = { frontier: FRONTIER, balanced: BALANCED };
    it('defaults the deep-plan planners to different labs and recommends two implementer models', () => {
        const questions = buildPiModelQuestions(['robustness', 'ergonomics', 'implementer'], ranked, {});
        expect(questions.map((question) => [question.role, question.multiSelect, question.options.map((option) => option.label)])).toEqual([
            ['robustness', false, ['Muse Wonder (Recommended)', 'GPT 5.6 Terra', 'Grok 4.7', 'GLM 5.3']],
            ['ergonomics', false, ['GPT 5.6 Terra (Recommended)', 'Muse Wonder', 'Grok 4.7', 'GLM 5.3']],
            ['implementer', true, ['GLM 5.3 (Recommended)', 'Grok 4.7 Fast (Recommended)', 'Muse Spark 1.3', 'GPT 5.6 Terra']],
        ]);
        expect(questions[0]?.options[0]?.description).toBe('meta/muse-wonder-1.0 · your meta login · new this fortnight · $4.00 in / $20.00 out per M tokens list price · 1000K context');
    });
    it('describes a gateway route as metered, with its usage and speed variant', () => {
        const [question] = buildPiModelQuestions(['implementer'], { balanced: rankPiModels(GATEWAY_ONLY, { profile: 'balanced' }) }, {});
        expect(question?.options[0]?.description).toBe('vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017 · Vercel AI Gateway, metered · 29.43% of gateway tokens this week · '
            + '$0.07 in / $0.30 out per M tokens list price · 1000K context · speed variant: vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017-fast');
    });
    it('leads with the last picks a route still runs, even ones the ranking leaves out', () => {
        const picks = {
            implementer: {
                piModels: ['vercel-ai-gateway/openai/gpt-6-astra', 'zai/glm-5.3', 'kimi-coding/k3'],
                chosenAt: NOW.toISOString(),
            },
        };
        const [question] = buildPiModelQuestions(['implementer'], ranked, picks, ALL);
        expect(question?.options.map((option) => option.label)).toEqual([
            'GPT-6 Astra (Recommended)',
            'GLM 5.3 (Recommended)',
            'Grok 4.7 Fast',
            'Muse Spark 1.3',
        ]);
        expect(question?.options.slice(0, 2).every((option) => option.description.startsWith('Last used for this role. '))).toBe(true);
        expect(question?.options[2]?.description).not.toContain('Last used');
    });
});
describe('resolvePiModelAnswer', () => {
    const sources = {
        candidates: [...BALANCED, ...ALL],
        directModels: [{ provider: 'zai', model: 'glm-9-unknown' }],
        catalog: CATALOG,
        now: NOW,
    };
    const gatewayOnly = { ...sources, candidates: [], directModels: [] };
    it.each([
        ['Grok 4.7 Fast (Recommended)', 'xai/grok-4.7-fast'],
        ['GLM 5.3', 'zai/glm-5.3'],
        ['vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017-fast', 'vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017-fast'],
        ['zai/glm-9-unknown', 'zai/glm-9-unknown'],
    ])('resolves %s against the shown options and the logins', (answer, piModel) => {
        expect(resolvePiModelAnswer(answer, sources)).toMatchObject({ ok: true, piModel });
    });
    it.each([
        ['gpt 6 astra', 'vercel-ai-gateway/openai/gpt-6-astra'],
        ['moonshotai/kimi-k3', 'vercel-ai-gateway/moonshotai/kimi-k3'],
        ['vercel-ai-gateway/zai/glm-5.3', 'vercel-ai-gateway/zai/glm-5.3'],
    ])('falls back to the gateway catalog for %s', (answer, piModel) => {
        expect(resolvePiModelAnswer(answer, gatewayOnly)).toMatchObject({ ok: true, piModel });
    });
    it('refuses catalog entries the lanes cannot use', () => {
        expect(resolvePiModelAnswer('openai/gpt-6-luna-batch', gatewayOnly)).toEqual({ ok: false, suggestions: [] });
        expect(resolvePiModelAnswer('bad/id:high', gatewayOnly)).toMatchObject({ ok: false });
    });
    it('refuses every Gemini model but gemini-4-argon, on the gateway and on a login', () => {
        const withGemini = {
            ...gatewayOnly,
            directModels: [{ provider: 'google', model: 'gemini-3-pro' }, { provider: 'google', model: 'gemini-4-argon' }],
            catalog: [...CATALOG, model('google/gemini-3-pro', 'Gemini 3 Pro'), model('google/gemini-4-argon', 'Gemini 4 Argon')],
        };
        expect(resolvePiModelAnswer('google/gemini-3-pro', withGemini)).toMatchObject({ ok: false });
        expect(resolvePiModelAnswer('Gemini 3 Pro', withGemini)).toMatchObject({ ok: false });
        expect(resolvePiModelAnswer('google/gemini-4-argon', withGemini)).toEqual({ ok: true, piModel: 'google/gemini-4-argon', name: 'gemini-4-argon' });
        expect(resolvePiModelAnswer('Gemini 4 Argon', withGemini)).toEqual({ ok: true, piModel: GEMINI_LANE_MODEL, name: 'Gemini 4 Argon' });
    });
    it('suggests eligible models that contain every word of an unknown answer', () => {
        expect(resolvePiModelAnswer('gpt astra', gatewayOnly)).toEqual({
            ok: false,
            suggestions: ['vercel-ai-gateway/openai/gpt-6-astra'],
        });
    });
});
function piExec(fake) {
    const inFlight = new Map();
    const peak = new Map();
    const exec = vi.fn(async (cmd, args) => {
        if (cmd !== 'pi')
            return { code: 1, stdout: '', stderr: 'not mocked' };
        if (args[0] === '--list-models')
            return { code: 0, stdout: fake.listed, stderr: '' };
        if (args[0] === 'auth') {
            const provider = args[3];
            const authType = fake.ready[provider];
            return authType
                ? { code: 0, stdout: JSON.stringify({ status: 'ready', provider, authType }), stderr: '' }
                : { code: 1, stdout: JSON.stringify({ status: 'not_ready', provider, reason: 'credentials_not_configured' }), stderr: '' };
        }
        const piModel = args[args.indexOf('--model') + 1];
        const provider = piModel.slice(0, piModel.indexOf('/'));
        inFlight.set(provider, (inFlight.get(provider) ?? 0) + 1);
        peak.set(provider, Math.max(peak.get(provider) ?? 0, inFlight.get(provider)));
        try {
            await new Promise((resolve) => setTimeout(resolve, fake.delayMs ?? 0));
            const outcome = fake.probes[piModel] ?? { code: 1, stderr: 'unexpected probe' };
            if (outcome === 'timeout')
                throw new Error(`Timed out after 60000ms: pi ${args.join(' ')}`);
            return { code: outcome.code, stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '' };
        }
        finally {
            inFlight.set(provider, inFlight.get(provider) - 1);
        }
    });
    const probed = () => exec.mock.calls
        .filter(([, args]) => args[0] === '-p')
        .map(([, args]) => args[args.indexOf('--model') + 1]);
    return { exec, peak, probed };
}
function table(rows) {
    return ['provider model context max-out thinking images', ...rows.map((row) => `${row} 1M 128K yes no`)].join('\n');
}
describe('discoverPiRoutes', () => {
    let cwd;
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), 'pi-routes-'));
    });
    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
    });
    const LISTED = table([
        'anthropic claude-opus-5.5',
        'kimi-coding k3',
        'openai-codex gpt-5.6-terra',
        'openai-codex gpt-6-luna',
        'openai-codex gpt-6.1-sol',
        'openrouter qwen-coder',
        'xai grok-3',
        'xai grok-4.6',
        'xai grok-4.7',
        'xai grok-4.7-fast',
        'zai glm-5.3',
        'zai glm-5.3-flash',
        'zai glm-9-unknown',
    ]);
    const OK = { code: 0, stdout: 'ok\n' };
    const fake = () => piExec({
        listed: LISTED,
        ready: { 'vercel-ai-gateway': 'api_key', 'openai-codex': 'oauth', xai: 'oauth', zai: 'api_key' },
        probes: {
            'openai-codex/gpt-5.6-terra': OK,
            'openai-codex/gpt-6-luna': OK,
            'openai-codex/gpt-6.1-sol': {
                code: 1,
                stderr: 'booting\nCodex error: model not supported (key vck_3xLN****DRst, fallback sk-proj-abcdefgh12345)',
            },
            'xai/grok-4.7': OK,
            'xai/grok-4.6': OK,
            'xai/grok-4.7-fast': OK,
            'zai/glm-5.3': OK,
            'zai/glm-5.3-flash': 'timeout',
        },
    });
    it('probes each ready login\'s recent models and keeps the ones that answer', async () => {
        const { exec, probed } = fake();
        const routes = await discoverPiRoutes(exec, SNAPSHOT, { cwd, now: NOW });
        expect(routes.directRoutes).toEqual([
            route('openai-codex', 'gpt-5.6-terra', 'openai/gpt-5.6-terra', 'oauth'),
            route('openai-codex', 'gpt-6-luna', 'openai/gpt-6-luna', 'oauth'),
            route('xai', 'grok-4.6', 'spacexai/grok-4.6', 'oauth'),
            route('xai', 'grok-4.7', 'spacexai/grok-4.7', 'oauth', 'xai/grok-4.7-fast'),
            route('zai', 'glm-5.3', 'zai/glm-5.3', 'api_key'),
        ]);
        expect(routes.gatewayReady).toBe(true);
        expect(routes.providers.map((auth) => [auth.provider, auth.ready])).toEqual([
            ['vercel-ai-gateway', true],
            ['kimi-coding', false],
            ['openai-codex', true],
            ['xai', true],
            ['zai', true],
        ]);
        expect(routes.directModels).toHaveLength(10);
        expect(probed().sort()).toEqual([
            'openai-codex/gpt-5.6-terra',
            'openai-codex/gpt-6-luna',
            'openai-codex/gpt-6.1-sol',
            'xai/grok-4.6',
            'xai/grok-4.7',
            'xai/grok-4.7-fast',
            'zai/glm-5.3',
            'zai/glm-5.3-flash',
        ]);
        expect(exec).toHaveBeenCalledWith('pi', ['-p', '--no-session', '--no-approve', '--no-context-files', '--no-tools', '--thinking', 'minimal',
            '--model', 'xai/grok-4.7', 'Reply with exactly: ok'], expect.objectContaining({ timeout: 60_000, cwd }));
    });
    it('reports rejected routes with any key text redacted, and leaves a timed-out route unknown', async () => {
        const routes = await discoverPiRoutes(fake().exec, SNAPSHOT, { cwd, now: NOW });
        expect(routes.failed).toEqual([{
                piModel: 'openai-codex/gpt-6.1-sol',
                detail: 'Codex error: model not supported (key [redacted] fallback [redacted])',
            }]);
        const cache = JSON.parse(await readFile(join(cwd, '.pi-flywheel', 'cache', 'pi-route-probes.json'), 'utf8'));
        expect(cache.probes['zai/glm-5.3-flash']).toBeUndefined();
        expect(cache.probes['xai/grok-4.7']?.ok).toBe(true);
        expect(JSON.stringify(cache)).not.toMatch(/vck_|sk-proj/);
    });
    it('reuses probes for a day, retries unknown ones, and re-probes everything on refresh or after a day', async () => {
        await discoverPiRoutes(fake().exec, SNAPSHOT, { cwd, now: NOW });
        const cached = fake();
        await discoverPiRoutes(cached.exec, SNAPSHOT, { cwd, now: new Date(NOW.getTime() + 60_000) });
        expect(cached.probed()).toEqual(['zai/glm-5.3-flash']);
        const refreshed = fake();
        await discoverPiRoutes(refreshed.exec, SNAPSHOT, { cwd, now: new Date(NOW.getTime() + 60_000), refresh: true });
        expect(refreshed.probed()).toHaveLength(8);
        const nextDay = fake();
        await discoverPiRoutes(nextDay.exec, SNAPSHOT, { cwd, now: new Date(NOW.getTime() + 25 * 60 * 60 * 1000) });
        expect(nextDay.probed()).toHaveLength(8);
    });
    it('runs at most four probes at a time per login', async () => {
        const catalog = Array.from({ length: 6 }, (_, i) => model(`acme/m${i}`, `M${i}`, { released: ago(10 + i) }));
        const { exec, peak, probed } = piExec({
            listed: table(catalog.map((entry) => `acme ${entry.id.slice(5)}`)),
            ready: { acme: 'oauth' },
            probes: Object.fromEntries(catalog.map((entry) => [entry.id, OK])),
            delayMs: 10,
        });
        const routes = await discoverPiRoutes(exec, { catalog, tokenShare: {}, spendShare: {} }, { cwd, now: NOW });
        expect(probed()).toHaveLength(6);
        expect(peak.get('acme')).toBe(4);
        expect(routes.directRoutes).toHaveLength(6);
        expect(routes.gatewayReady).toBe(false);
    });
});
describe('readGeminiLaneListing', () => {
    let cwd;
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), 'pi-models-gemini-'));
    });
    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
    });
    async function cache(catalog) {
        await mkdir(join(cwd, '.pi-flywheel', 'cache'), { recursive: true });
        await writeFile(join(cwd, '.pi-flywheel', 'cache', 'gateway-models.json'), JSON.stringify({ version: 2, fetchedAt: NOW.toISOString(), catalog, tokenShare: {}, spendShare: {} }));
    }
    it('is null with no cached catalog', async () => {
        expect(await readGeminiLaneListing(cwd, NOW)).toBeNull();
    });
    it('reports whether the cached catalog offers gemini-4-argon to agent lanes', async () => {
        await cache([model('google/gemini-4-argon', 'Gemini 4 Argon')]);
        expect(await readGeminiLaneListing(cwd, NOW)).toEqual({ listed: true, fetchedAt: NOW.toISOString() });
        await cache([model('google/gemini-4-argon', 'Gemini 4 Argon', { deprecated_at: '2026-10-01T00:00:00Z' })]);
        expect(await readGeminiLaneListing(cwd, NOW)).toEqual({ listed: false, fetchedAt: NOW.toISOString() });
        await cache([model('google/gemini-4-argon-1017', 'Gemini 4 Argon 1017')]);
        expect(await readGeminiLaneListing(cwd, NOW)).toEqual({ listed: false, fetchedAt: NOW.toISOString() });
    });
});
describe('gateway snapshot loading', () => {
    let cwd;
    const cachePath = () => join(cwd, '.pi-flywheel', 'cache', 'gateway-models.json');
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), 'pi-models-'));
    });
    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
    });
    function gatewayExec(catalog = CATALOG, curlCode = 0) {
        return vi.fn(async (cmd, args) => {
            if (cmd !== 'curl')
                return { code: 1, stdout: '', stderr: 'not mocked' };
            if (curlCode !== 0)
                return { code: curlCode, stdout: '', stderr: 'curl: (22) The requested URL returned error: 503' };
            const url = args.at(-1);
            if (url === GATEWAY_CATALOG_URL)
                return { code: 0, stdout: JSON.stringify({ data: [...catalog, { id: 42 }] }), stderr: '' };
            if (url === GATEWAY_LEADERBOARD_URL) {
                return {
                    code: 0,
                    stdout: JSON.stringify({
                        rows: [
                            { date: '2026-10-18', name: 'GLM 5.3', metric: 'tokens', share_percent: 12.15 },
                            { date: '2026-10-18', name: 'GLM 5.3', metric: 'spend', share_percent: 22.51 },
                            'junk',
                        ],
                    }),
                    stderr: '',
                };
            }
            return { code: 1, stdout: '', stderr: `unexpected ${url}` };
        });
    }
    async function seedCache(fetchedAt) {
        const snapshot = {
            version: 2,
            fetchedAt: fetchedAt.toISOString(),
            catalog: CATALOG.slice(0, 2),
            tokenShare: { 'Muse Wonder': 1 },
            spendShare: {},
        };
        await mkdir(join(cwd, '.pi-flywheel', 'cache'), { recursive: true });
        await writeFile(cachePath(), JSON.stringify(snapshot));
        return snapshot;
    }
    it('fetches both lists with bounded curl calls, keeps language models, and caches both shares', async () => {
        const exec = gatewayExec();
        const loaded = await loadGatewaySnapshot(exec, { cwd, now: NOW });
        expect(loaded.stale).toBe(false);
        expect(loaded.snapshot.fetchedAt).toBe(NOW.toISOString());
        expect(loaded.snapshot.catalog).toHaveLength(CATALOG.length - 1);
        expect(loaded.snapshot.tokenShare).toEqual({ 'GLM 5.3': 12.15 });
        expect(loaded.snapshot.spendShare).toEqual({ 'GLM 5.3': 22.51 });
        expect(exec).toHaveBeenCalledWith('curl', ['-sS', '--fail', '--max-time', '15', GATEWAY_CATALOG_URL], expect.objectContaining({ timeout: 20_000, cwd }));
        expect(JSON.parse(await readFile(cachePath(), 'utf8'))).toEqual(loaded.snapshot);
    });
    it('serves a cache under an hour old without touching the network', async () => {
        const cached = await seedCache(new Date(NOW.getTime() - 30 * 60 * 1000));
        const exec = gatewayExec();
        expect(await loadGatewaySnapshot(exec, { cwd, now: NOW })).toEqual({ snapshot: cached, stale: false });
        expect(exec).not.toHaveBeenCalled();
    });
    it('refetches a fresh cache when refresh is set', async () => {
        await seedCache(new Date(NOW.getTime() - 60 * 1000));
        const exec = gatewayExec();
        await loadGatewaySnapshot(exec, { cwd, now: NOW, refresh: true });
        expect(exec).toHaveBeenCalledTimes(2);
    });
    it('falls back to an old cache marked stale when the fetch fails', async () => {
        const cached = await seedCache(new Date(NOW.getTime() - 3 * 60 * 60 * 1000));
        const loaded = await loadGatewaySnapshot(gatewayExec(CATALOG, 22), { cwd, now: NOW });
        expect(loaded).toMatchObject({ snapshot: cached, stale: true });
        expect(loaded.fetchError).toContain('exited 22');
    });
    it('throws when the fetch fails and nothing is cached, or the catalog is empty', async () => {
        await expect(loadGatewaySnapshot(gatewayExec(CATALOG, 22), { cwd, now: NOW }))
            .rejects.toThrow('could not load the Vercel AI Gateway model list: curl https://ai-gateway.vercel.sh/v1/models exited 22');
        await expect(loadGatewaySnapshot(gatewayExec([]), { cwd, now: NOW }))
            .rejects.toThrow('the gateway catalog listed no models');
    });
    it('ignores a version 1 cache, which has no spend share', async () => {
        await mkdir(join(cwd, '.pi-flywheel', 'cache'), { recursive: true });
        await writeFile(cachePath(), JSON.stringify({ version: 1, fetchedAt: NOW.toISOString(), catalog: [], tokenShare: {} }));
        const exec = gatewayExec();
        await loadGatewaySnapshot(exec, { cwd, now: NOW });
        expect(exec).toHaveBeenCalledTimes(2);
    });
});
describe('Pi model picks', () => {
    let cwd;
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), 'pi-picks-'));
    });
    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
    });
    it('merges new picks into the saved ones', async () => {
        await writePiModelPicks(cwd, { robustness: ['meta/muse-wonder-1.0'] }, NOW);
        const later = new Date(NOW.getTime() + 1000);
        await writePiModelPicks(cwd, { implementer: ['zai/glm-5.3', 'xai/grok-4.7-fast'] }, later);
        expect(await readPiModelPicks(cwd)).toEqual({
            robustness: { piModels: ['meta/muse-wonder-1.0'], chosenAt: NOW.toISOString() },
            implementer: { piModels: ['zai/glm-5.3', 'xai/grok-4.7-fast'], chosenAt: later.toISOString() },
        });
    });
    it('drops roles it does not know, and reads a corrupt or version 1 file as empty', async () => {
        await mkdir(join(cwd, '.pi-flywheel'), { recursive: true });
        const file = join(cwd, '.pi-flywheel', 'pi-models.json');
        await writeFile(file, JSON.stringify({
            version: 2,
            picks: { implementer: { piModels: ['zai/glm-5.3'], chosenAt: 'x' }, reviewer: { piModels: ['a/b'], chosenAt: 'x' } },
        }));
        expect(await readPiModelPicks(cwd)).toEqual({ implementer: { piModels: ['zai/glm-5.3'], chosenAt: 'x' } });
        await writeFile(file, JSON.stringify({ version: 1, picks: { implementer: { id: 'zai/glm-5.3', chosenAt: 'x' } } }));
        expect(await readPiModelPicks(cwd)).toEqual({});
        await writeFile(file, '{not json');
        expect(await readPiModelPicks(cwd)).toEqual({});
    });
});
describe('checkPiProviderAuth', () => {
    it('reads the JSON status and auth type, letting Pi refresh an expired login', async () => {
        const exec = vi.fn(async () => ({
            code: 0,
            stdout: '{"status":"ready","provider":"xai","authType":"oauth"}',
            stderr: '',
        }));
        expect(await checkPiProviderAuth(exec, 'xai', { cwd: '/repo' }))
            .toEqual({ provider: 'xai', ready: true, authType: 'oauth', detail: 'ready' });
        expect(exec).toHaveBeenCalledWith('pi', ['auth', 'check', '--provider', 'xai', '--json'], expect.objectContaining({ timeout: 15_000, cwd: '/repo' }));
    });
    it('reports not ready with the reason, the plain output, the exit code, or the thrown error', async () => {
        const auth = (result) => checkPiProviderAuth(async () => ({ ...result, stderr: '' }), 'zai', {});
        expect(await auth({ code: 1, stdout: '{"status":"not_ready","provider":"zai","reason":"credentials_not_configured"}' }))
            .toMatchObject({ ready: false, detail: 'not_ready (credentials_not_configured)' });
        expect(await auth({ code: 1, stdout: 'not_ready\n' })).toMatchObject({ ready: false, detail: 'not_ready' });
        expect(await auth({ code: 3, stdout: '' })).toMatchObject({ ready: false, detail: 'pi auth check exited 3' });
        expect(await checkPiProviderAuth(async () => { throw new Error('spawn pi ENOENT'); }, 'zai', {}))
            .toEqual({ provider: 'zai', ready: false, authType: null, detail: 'spawn pi ENOENT' });
    });
});
describe('checkPiLaneReady', () => {
    let cwd;
    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), 'pi-ready-'));
        await writePiModelPicks(cwd, { implementer: ['zai/glm-5.3'] }, NOW);
        await mkdir(join(cwd, '.pi-flywheel', 'cache'), { recursive: true });
        await writeFile(join(cwd, '.pi-flywheel', 'cache', 'pi-route-probes.json'), JSON.stringify({
            version: 1,
            probes: {
                'xai/grok-4.7': { ok: true, detail: 'ok', checkedAt: NOW.toISOString() },
                'kimi-coding/k3': { ok: false, detail: '429', checkedAt: NOW.toISOString() },
            },
        }));
    });
    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
    });
    it('is ready when the gateway, a picked login, or a login that passed a probe has credentials', async () => {
        const { exec } = piExec({ listed: '', ready: { xai: 'oauth' }, probes: {} });
        expect(await checkPiLaneReady(exec, { cwd })).toEqual({ ready: true, detail: 'xai ready' });
        expect(exec.mock.calls.map(([, args]) => args[3])).toEqual(['vercel-ai-gateway', 'zai', 'xai']);
    });
    it('lists every route it checked when none is ready, and checks only the gateway without a cwd', async () => {
        const { exec } = piExec({ listed: '', ready: {}, probes: {} });
        expect(await checkPiLaneReady(exec, { cwd })).toEqual({
            ready: false,
            detail: ['vercel-ai-gateway', 'zai', 'xai'].map((provider) => `${provider} not_ready (credentials_not_configured)`).join('; '),
        });
        exec.mockClear();
        await checkPiLaneReady(exec, {});
        expect(exec.mock.calls.map(([, args]) => args[3])).toEqual(['vercel-ai-gateway']);
    });
});
//# sourceMappingURL=pi-models.test.js.map