import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecFn } from '../exec.js';
import {
  buildPiModelQuestions,
  checkPiGatewayAuth,
  GATEWAY_CATALOG_URL,
  GATEWAY_LEADERBOARD_URL,
  type GatewayModel,
  type GatewaySnapshot,
  isLaneEligible,
  loadGatewaySnapshot,
  rankPiModels,
  readPiModelPicks,
  resolvePiModelAnswer,
  summarizeTokenShare,
  writePiModelPicks,
} from '../pi-models.js';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const DAY_S = 86_400;
const nowS = NOW.getTime() / 1000;

function model(id: string, name: string, overrides: Partial<GatewayModel> = {}): GatewayModel {
  return {
    id,
    name,
    type: 'language',
    owned_by: id.split('/')[0],
    released: nowS - 60 * DAY_S,
    tags: ['tool-use', 'reasoning'],
    context_window: 1_000_000,
    pricing: { input: '0.0000001', output: '0.0000004' },
    ...overrides,
  };
}

const CATALOG: GatewayModel[] = [
  model('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', { released: nowS - 50 * DAY_S }),
  model('deepseek/deepseek-v4.1-flash-1017', 'DeepSeek V4.1 Flash 1017', { released: nowS - 2 * DAY_S }),
  model('deepseek/deepseek-v4.1-flash-1017-fast', 'DeepSeek V4.1 Flash 1017 Fast', { released: nowS - 2 * DAY_S }),
  model('zai/glm-5.3', 'GLM 5.3', { pricing: { input: '0.0000006', output: '0.0000022' } }),
  model('zai/glm-5.3-flash', 'GLM 5.3 Flash'),
  model('openai/gpt-6-luna', 'GPT-6 Luna', { pricing: { input: '0.00000125', output: '0.00001' } }),
  model('minimax/minimax-m3.1-flash', 'MiniMax M3.1 Flash', { released: nowS - 7 * DAY_S }),
  model('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5'),
  model('stealth/trial-model', 'Trial Model'),
  model('moonshotai/kimi-k3-free', 'Kimi K3 Free', { tags: ['tool-use', 'free'] }),
  model('openai/gpt-6-luna-batch', 'GPT-6 Luna Batch'),
  model('meta/muse-spark-open', 'Muse Spark Open', { tags: ['reasoning'] }),
  model('mistral/mistral-old', 'Mistral Old', { deprecated_at: nowS - DAY_S }),
  model('openai/text-embedding-9', 'Text Embedding 9', { type: 'embedding' }),
  model('bad/id:high', 'Bad Id'),
];

const TOKEN_SHARE: Record<string, number> = {
  'DeepSeek V4.1 Flash': 10,
  'DeepSeek V4.1 Flash 1017': 19.43,
  'GLM 5.3': 12.24,
  'GLM 5.3 Flash': 8.13,
  'GPT-6 Luna': 6.42,
  'Claude Sonnet 5.5': 40,
  'Kimi K3 Free': 3,
};

const SNAPSHOT = { catalog: CATALOG, tokenShare: TOKEN_SHARE };

describe('isLaneEligible', () => {
  it.each([
    ['anthropic/claude-sonnet-5.5', 'Claude has its own lane'],
    ['stealth/trial-model', 'anonymous trial model'],
    ['moonshotai/kimi-k3-free', 'free tier'],
    ['openai/gpt-6-luna-batch', 'batch endpoint'],
    ['meta/muse-spark-open', 'no tool-use tag'],
    ['mistral/mistral-old', 'deprecated'],
    ['openai/text-embedding-9', 'not a language model'],
    ['bad/id:high', 'id Pi would read as a thinking level'],
  ])('rejects %s (%s)', (id) => {
    const entry = CATALOG.find((candidate) => candidate.id === id)!;
    expect(isLaneEligible(entry, NOW)).toBe(false);
  });

  it('accepts a tool-calling model with a plain id', () => {
    expect(isLaneEligible(CATALOG[1]!, NOW)).toBe(true);
  });

  it('keeps a model whose deprecation date is still ahead', () => {
    expect(isLaneEligible(model('mistral/mistral-next', 'Next', { deprecated_at: nowS + DAY_S }), NOW)).toBe(true);
  });
});

describe('summarizeTokenShare', () => {
  it('averages the latest seven dates, counting days a model is absent as zero', () => {
    const dates = Array.from({ length: 9 }, (_, i) => `2026-10-${String(i + 10).padStart(2, '0')}`);
    const rows = [
      ...dates.map((date, i) => ({ date, name: 'A', metric: 'tokens', share_percent: i < 2 ? 100 : 10 })),
      { date: dates[8]!, name: 'B', metric: 'tokens', share_percent: 7 },
      { date: dates[8]!, name: 'Other', metric: 'tokens', share_percent: 50 },
      { date: dates[8]!, name: 'C', metric: 'requests', share_percent: 90 },
    ];

    expect(summarizeTokenShare(rows)).toEqual({ A: 10, B: 1 });
  });

  it('returns nothing without token rows', () => {
    expect(summarizeTokenShare([{ date: '2026-10-18', name: 'A', metric: 'requests', share_percent: 5 }])).toEqual({});
  });
});

describe('rankPiModels', () => {
  it('ranks families by summed share, represented by the newest dated snapshot, then appends unranked new models', () => {
    const ranked = rankPiModels(SNAPSHOT, { now: NOW });

    expect(ranked.map(({ id, tokenSharePercent, isNew }) => ({ id, tokenSharePercent, isNew }))).toEqual([
      { id: 'deepseek/deepseek-v4.1-flash-1017', tokenSharePercent: 29.43, isNew: false },
      { id: 'zai/glm-5.3', tokenSharePercent: 12.24, isNew: false },
      { id: 'zai/glm-5.3-flash', tokenSharePercent: 8.13, isNew: false },
      { id: 'openai/gpt-6-luna', tokenSharePercent: 6.42, isNew: false },
      { id: 'minimax/minimax-m3.1-flash', tokenSharePercent: null, isNew: true },
    ]);
    expect(ranked[0]).toMatchObject({
      piModel: 'vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017',
      lab: 'deepseek',
      fastVariantId: 'deepseek/deepseek-v4.1-flash-1017-fast',
      released: '2026-10-17',
      inputPerMTok: 0.1,
      contextWindow: 1_000_000,
    });
    expect(ranked[1]?.fastVariantId).toBeNull();
  });

  it('picks the dated snapshot whichever order the catalog lists the family in', () => {
    const reversed = { ...SNAPSHOT, catalog: [...CATALOG].reverse() };

    expect(rankPiModels(reversed, { now: NOW })[0]?.id).toBe('deepseek/deepseek-v4.1-flash-1017');
  });

  it('keeps room for new models inside the limit', () => {
    expect(rankPiModels(SNAPSHOT, { now: NOW, limit: 3 }).map((candidate) => candidate.id)).toEqual([
      'deepseek/deepseek-v4.1-flash-1017',
      'zai/glm-5.3',
      'minimax/minimax-m3.1-flash',
    ]);
  });

  it('stops calling a model new after two weeks', () => {
    const later = new Date(NOW.getTime() + 8 * DAY_S * 1000);

    expect(rankPiModels(SNAPSHOT, { now: later }).some((candidate) => candidate.isNew)).toBe(false);
  });
});

describe('buildPiModelQuestions', () => {
  const candidates = rankPiModels(SNAPSHOT, { now: NOW });

  it('defaults the two deep-plan planners to different labs and lists the fast variant after the default', () => {
    const [robustness, ergonomics] = buildPiModelQuestions(['robustness', 'ergonomics'], candidates, SNAPSHOT, {});

    expect(robustness?.options.map((option) => option.label)).toEqual([
      'DeepSeek V4.1 Flash 1017 (Recommended)',
      'DeepSeek V4.1 Flash 1017 Fast',
      'GLM 5.3',
      'GPT-6 Luna',
    ]);
    expect(ergonomics?.options.map((option) => option.label)).toEqual([
      'GLM 5.3 (Recommended)',
      'DeepSeek V4.1 Flash 1017',
      'GPT-6 Luna',
      'MiniMax M3.1 Flash',
    ]);
    expect(robustness).toMatchObject({ role: 'robustness', header: 'Robustness', multiSelect: false });
    expect(robustness?.options[0]).toEqual({
      label: 'DeepSeek V4.1 Flash 1017 (Recommended)',
      description: 'vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017 · 29.43% of gateway tokens this week · $0.1 in / $0.4 out per M tokens · 1000K context',
      piModel: 'vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017',
    });
    expect(ergonomics?.options[3]?.description).toContain('new this fortnight, not ranked yet');
    expect(robustness?.options[3]?.description).toContain('$1.25 in / $10.00 out per M tokens');
  });

  it('leads with the last pick for the role and says so', () => {
    const [question] = buildPiModelQuestions(['implementer'], candidates, SNAPSHOT, {
      implementer: { id: 'zai/glm-5.3-flash', chosenAt: '2026-10-18T00:00:00.000Z' },
    });

    expect(question?.options[0]?.label).toBe('GLM 5.3 Flash (Recommended)');
    expect(question?.options[0]?.description.startsWith('Last used for this role. ')).toBe(true);
    expect(question?.options.slice(1).some((option) => option.description.startsWith('Last used'))).toBe(false);
  });

  it('ignores a last pick the catalog no longer lists', () => {
    const [question] = buildPiModelQuestions(['implementer'], candidates, SNAPSHOT, {
      implementer: { id: 'deepseek/deepseek-v4-retired', chosenAt: '2026-10-01T00:00:00.000Z' },
    });

    expect(question?.options[0]?.label).toBe('DeepSeek V4.1 Flash 1017 (Recommended)');
    expect(question?.options.some((option) => option.description.startsWith('Last used'))).toBe(false);
  });
});

describe('resolvePiModelAnswer', () => {
  it.each([
    ['DeepSeek V4.1 Flash 1017 (Recommended)', 'deepseek/deepseek-v4.1-flash-1017'],
    ['vercel-ai-gateway/zai/glm-5.3', 'zai/glm-5.3'],
    ['zai/glm-5.3', 'zai/glm-5.3'],
    ['  glm 5.3 flash ', 'zai/glm-5.3-flash'],
  ])('resolves %j', (answer, id) => {
    expect(resolvePiModelAnswer(answer, CATALOG)).toEqual({
      ok: true,
      id,
      piModel: `vercel-ai-gateway/${id}`,
      name: CATALOG.find((entry) => entry.id === id)!.name,
    });
  });

  it('suggests ids that contain every word of an unknown answer', () => {
    expect(resolvePiModelAnswer('deepseek flash', CATALOG)).toEqual({
      ok: false,
      suggestions: [
        'deepseek/deepseek-v4.1-flash',
        'deepseek/deepseek-v4.1-flash-1017',
        'deepseek/deepseek-v4.1-flash-1017-fast',
      ],
    });
    expect(resolvePiModelAnswer('nothing like it', CATALOG)).toEqual({ ok: false, suggestions: [] });
  });

  it('refuses a catalog id that is not safe to pass to pi --model', () => {
    expect(resolvePiModelAnswer('bad/id:high', CATALOG).ok).toBe(false);
  });
});

describe('gateway snapshot loading', () => {
  let cwd: string;
  const cachePath = (): string => join(cwd, '.pi-flywheel', 'cache', 'gateway-models.json');

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'pi-models-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function gatewayExec(catalog: unknown[] = CATALOG, curlCode = 0) {
    return vi.fn<ExecFn>(async (cmd, args) => {
      if (cmd !== 'curl') return { code: 1, stdout: '', stderr: 'not mocked' };
      if (curlCode !== 0) return { code: curlCode, stdout: '', stderr: 'curl: (22) The requested URL returned error: 503' };
      const url = args.at(-1);
      if (url === GATEWAY_CATALOG_URL) return { code: 0, stdout: JSON.stringify({ data: [...catalog, { id: 42 }] }), stderr: '' };
      if (url === GATEWAY_LEADERBOARD_URL) {
        return {
          code: 0,
          stdout: JSON.stringify({ rows: [{ date: '2026-10-18', name: 'GLM 5.3', metric: 'tokens', share_percent: 12.24 }, 'junk'] }),
          stderr: '',
        };
      }
      return { code: 1, stdout: '', stderr: `unexpected ${url}` };
    });
  }

  async function seedCache(fetchedAt: Date, catalog: GatewayModel[] = CATALOG.slice(0, 2)): Promise<GatewaySnapshot> {
    const snapshot: GatewaySnapshot = { version: 1, fetchedAt: fetchedAt.toISOString(), catalog, tokenShare: { 'DeepSeek V4.1 Flash': 1 } };
    await mkdir(join(cwd, '.pi-flywheel', 'cache'), { recursive: true });
    await writeFile(cachePath(), JSON.stringify(snapshot));
    return snapshot;
  }

  it('fetches both lists with bounded curl calls, keeps language models, and caches the result', async () => {
    const exec = gatewayExec();

    const loaded = await loadGatewaySnapshot(exec, { cwd, now: NOW });

    expect(loaded.stale).toBe(false);
    expect(loaded.snapshot.fetchedAt).toBe(NOW.toISOString());
    expect(loaded.snapshot.catalog.map((entry) => entry.id)).not.toContain('openai/text-embedding-9');
    expect(loaded.snapshot.catalog).toHaveLength(CATALOG.length - 1);
    expect(loaded.snapshot.tokenShare).toEqual({ 'GLM 5.3': 12.24 });
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

    const loaded = await loadGatewaySnapshot(exec, { cwd, now: NOW, refresh: true });

    expect(exec).toHaveBeenCalledTimes(2);
    expect(loaded.snapshot.catalog).toHaveLength(CATALOG.length - 1);
  });

  it('falls back to an old cache marked stale when the fetch fails', async () => {
    const cached = await seedCache(new Date(NOW.getTime() - 3 * 60 * 60 * 1000));

    const loaded = await loadGatewaySnapshot(gatewayExec(CATALOG, 22), { cwd, now: NOW });

    expect(loaded.snapshot).toEqual(cached);
    expect(loaded.stale).toBe(true);
    expect(loaded.fetchError).toContain('exited 22');
  });

  it('throws when the fetch fails and nothing is cached', async () => {
    await expect(loadGatewaySnapshot(gatewayExec(CATALOG, 22), { cwd, now: NOW }))
      .rejects.toThrow('could not load the Vercel AI Gateway model list: curl https://ai-gateway.vercel.sh/v1/models exited 22');
  });

  it('treats an empty catalog as a failed fetch', async () => {
    await expect(loadGatewaySnapshot(gatewayExec([]), { cwd, now: NOW }))
      .rejects.toThrow('the gateway catalog listed no models');
  });

  it('ignores a cache file that does not match the schema', async () => {
    await mkdir(join(cwd, '.pi-flywheel', 'cache'), { recursive: true });
    await writeFile(cachePath(), JSON.stringify({ version: 2, fetchedAt: NOW.toISOString() }));
    const exec = gatewayExec();

    await loadGatewaySnapshot(exec, { cwd, now: NOW });

    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe('Pi model picks', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'pi-picks-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('merges new picks into the saved ones', async () => {
    await writePiModelPicks(cwd, { robustness: 'deepseek/deepseek-v4.1-flash-1017' }, NOW);
    const later = new Date(NOW.getTime() + 1000);
    await writePiModelPicks(cwd, { ergonomics: 'zai/glm-5.3' }, later);

    expect(await readPiModelPicks(cwd)).toEqual({
      robustness: { id: 'deepseek/deepseek-v4.1-flash-1017', chosenAt: NOW.toISOString() },
      ergonomics: { id: 'zai/glm-5.3', chosenAt: later.toISOString() },
    });
  });

  it('drops roles it does not know and survives a corrupt file', async () => {
    await mkdir(join(cwd, '.pi-flywheel'), { recursive: true });
    const file = join(cwd, '.pi-flywheel', 'pi-models.json');
    await writeFile(file, JSON.stringify({
      version: 1,
      picks: { implementer: { id: 'zai/glm-5.3', chosenAt: 'x' }, reviewer: { id: 'a/b', chosenAt: 'x' } },
    }));
    expect(await readPiModelPicks(cwd)).toEqual({ implementer: { id: 'zai/glm-5.3', chosenAt: 'x' } });

    await writeFile(file, '{not json');
    expect(await readPiModelPicks(cwd)).toEqual({});
  });
});

describe('checkPiGatewayAuth', () => {
  it('runs a non-refreshing check against the gateway provider', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ code: 0, stdout: 'ready\n', stderr: '' }));

    expect(await checkPiGatewayAuth(exec, { cwd: '/repo' })).toEqual({ ready: true, detail: 'ready' });
    expect(exec).toHaveBeenCalledWith(
      'pi',
      ['auth', 'check', '--provider', 'vercel-ai-gateway', '--no-refresh'],
      expect.objectContaining({ timeout: 5000, cwd: '/repo' }),
    );
  });

  it('reports not ready with the CLI output, the exit code, or the thrown error', async () => {
    expect(await checkPiGatewayAuth(async () => ({ code: 1, stdout: 'not_ready\n', stderr: '' }), {}))
      .toEqual({ ready: false, detail: 'not_ready' });
    expect(await checkPiGatewayAuth(async () => ({ code: 3, stdout: '', stderr: '' }), {}))
      .toEqual({ ready: false, detail: 'pi auth check exited 3' });
    expect(await checkPiGatewayAuth(async () => { throw new Error('spawn pi ENOENT'); }, {}))
      .toEqual({ ready: false, detail: 'spawn pi ENOENT' });
  });
});
