import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecFn } from '../../exec.js';
import type { GatewayModel, GatewaySnapshot } from '../../pi-models.js';
import { runPiModels } from '../../tools/pi-models.js';
import { createInitialState, type ToolContext } from '../../types.js';

const DAY_S = 86_400;
const ago = (days: number): number => Date.now() / 1000 - days * DAY_S;

function model(id: string, name: string, released: number, output: number): GatewayModel {
  return {
    id,
    name,
    type: 'language',
    owned_by: id.split('/')[0],
    released,
    tags: ['tool-use', 'reasoning'],
    context_window: 500_000,
    pricing: { input: String(output / 4e6), output: String(output / 1e6) },
  };
}

const CATALOG = [
  model('spacexai/grok-4.7', 'Grok 4.7', ago(29), 6),
  model('spacexai/grok-4.7-fast', 'Grok 4.7 Fast', ago(29), 12),
  model('zai/glm-5.3', 'GLM 5.3', ago(63), 4.4),
  model('meta/muse-wonder-1.0', 'Muse Wonder', ago(8), 20),
  model('meta/muse-spark-1.3', 'Muse Spark 1.3', ago(48), 4.25),
  model('openai/gpt-6.1-sol', 'GPT-6.1 Sol', ago(21), 10),
  model('moonshotai/kimi-k3', 'Kimi K3', ago(96), 15),
  model('deepseek/deepseek-v4.1-flash-1017', 'DeepSeek V4.1 Flash 1017', ago(3), 0.3),
  model('deepseek/deepseek-v4.1-flash-1017-fast', 'DeepSeek V4.1 Flash 1017 Fast', ago(3), 2.4),
];

const LISTED = [
  'provider model context max-out thinking images',
  ...['xai grok-4.7', 'xai grok-4.7-fast', 'zai glm-5.3', 'meta muse-wonder-1.0', 'meta muse-spark-1.3',
    'openai-codex gpt-6.1-sol', 'kimi-coding k3'].map((row) => `${row} 1M 128K yes no`),
].join('\n');

const SOL_REJECTED = "Codex error: The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";

interface StructuredData {
  kind: string;
  [key: string]: unknown;
}

interface Question {
  role: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string; piModel: string }>;
}

function data(result: Awaited<ReturnType<typeof runPiModels>>): StructuredData {
  return (result.structuredContent as { data: StructuredData }).data;
}

describe('flywheel_pi_models', () => {
  let cwd: string;
  let ready: Record<string, string>;
  let exec: ReturnType<typeof vi.fn<ExecFn>>;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'flywheel-pi-models-'));
    ready = { 'vercel-ai-gateway': 'api_key', xai: 'oauth', zai: 'api_key', meta: 'oauth', 'openai-codex': 'oauth' };
    exec = vi.fn<ExecFn>(async (cmd, args) => {
      if (cmd === 'curl') return { code: 7, stdout: '', stderr: 'curl: (7) Failed to connect' };
      if (cmd !== 'pi') return { code: 1, stdout: '', stderr: 'not mocked' };
      if (args[0] === '--list-models') return { code: 0, stdout: LISTED, stderr: '' };
      if (args[0] === 'auth') {
        const provider = args[3]!;
        return ready[provider]
          ? { code: 0, stdout: JSON.stringify({ status: 'ready', provider, authType: ready[provider] }), stderr: '' }
          : { code: 1, stdout: JSON.stringify({ status: 'not_ready', provider, reason: 'credentials_not_configured' }), stderr: '' };
      }
      const piModel = args[args.indexOf('--model') + 1];
      return piModel === 'openai-codex/gpt-6.1-sol'
        ? { code: 1, stdout: '', stderr: SOL_REJECTED }
        : { code: 0, stdout: 'ok\n', stderr: '' };
    });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function seedCache(): Promise<void> {
    const snapshot: GatewaySnapshot = {
      version: 2,
      fetchedAt: new Date().toISOString(),
      catalog: CATALOG,
      tokenShare: { 'DeepSeek V4.1 Flash 1017': 29.43, 'GLM 5.3': 12.15, 'Kimi K3': 2.46 },
      spendShare: { 'GLM 5.3': 22.51, 'Kimi K3': 7.44, 'GPT-6.1 Sol': 3.63, 'Grok 4.7': 3.45, 'DeepSeek V4.1 Flash 1017': 2.18 },
    };
    await mkdir(join(cwd, '.pi-flywheel', 'cache'), { recursive: true });
    await writeFile(join(cwd, '.pi-flywheel', 'cache', 'gateway-models.json'), JSON.stringify(snapshot));
  }

  function ctx(): ToolContext {
    return {
      cwd,
      exec,
      state: createInitialState(),
      saveState: vi.fn(),
      clearState: vi.fn(),
      signal: new AbortController().signal,
    };
  }

  function authChecks(): string[] {
    return exec.mock.calls.filter(([cmd, args]) => cmd === 'pi' && args[0] === 'auth').map(([, args]) => args[3]!);
  }

  it('lists balanced implementer models from the logins first, with one multi-select question', async () => {
    await seedCache();

    const result = await runPiModels(ctx(), { action: 'list' });

    expect(result.isError).toBeUndefined();
    const listed = data(result);
    expect(listed).toMatchObject({
      kind: 'pi_models_listed',
      source: { catalog: 'https://ai-gateway.vercel.sh/v1/models', stale: false },
      routes: {
        gatewayReady: true,
        working: ['xai/grok-4.7', 'zai/glm-5.3', 'meta/muse-wonder-1.0', 'meta/muse-spark-1.3'],
        failed: [{ piModel: 'openai-codex/gpt-6.1-sol', detail: SOL_REJECTED }],
      },
    });
    expect(listed).not.toHaveProperty('provider');
    expect((listed.candidates as { balanced: Array<{ piModel: string }> }).balanced.map((candidate) => candidate.piModel)).toEqual([
      'zai/glm-5.3',
      'xai/grok-4.7-fast',
      'meta/muse-spark-1.3',
      'vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017',
      'vercel-ai-gateway/moonshotai/kimi-k3',
    ]);
    const [question, ...rest] = listed.questions as Question[];
    expect(rest).toEqual([]);
    expect(question).toMatchObject({ role: 'implementer', multiSelect: true });
    expect(question?.options.map((option) => option.label)).toEqual([
      'GLM 5.3 (Recommended)',
      'Grok 4.7 Fast (Recommended)',
      'Muse Spark 1.3',
      'DeepSeek V4.1 Flash 1017',
    ]);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Balanced, for implementers:\n1. GLM 5.3 (zai/glm-5.3, your zai login)');
    expect(text).toContain('4. DeepSeek V4.1 Flash 1017 (vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017, gateway, metered)');
    expect(text).toContain(`- openai-codex: gpt-6.1-sol: ${SOL_REJECTED}`);
    expect(text).not.toContain('Frontier');
  });

  it('asks the deep-plan roles for frontier models with defaults from different labs', async () => {
    await seedCache();

    const result = await runPiModels(ctx(), { action: 'list', roles: ['robustness', 'ergonomics'] });

    const questions = data(result).questions as Question[];
    expect(questions.map((question) => [question.role, question.multiSelect, question.options.map((option) => option.piModel)])).toEqual([
      ['robustness', false, ['meta/muse-wonder-1.0', 'xai/grok-4.7', 'zai/glm-5.3', 'vercel-ai-gateway/moonshotai/kimi-k3']],
      ['ergonomics', false, ['xai/grok-4.7', 'meta/muse-wonder-1.0', 'zai/glm-5.3', 'vercel-ai-gateway/moonshotai/kimi-k3']],
    ]);
    expect(result.content[0]?.text).toContain('Frontier, for planners:\n1. Muse Wonder (meta/muse-wonder-1.0, your meta login)');
  });

  it('resolves the shown labels, joins the implementer picks, saves them, and leads the next list with them', async () => {
    await seedCache();

    const chosen = await runPiModels(ctx(), {
      action: 'choose',
      picks: {
        robustness: 'Muse Wonder (Recommended)',
        ergonomics: 'Grok 4.7',
        implementer: 'GLM 5.3 (Recommended), Grok 4.7 Fast (Recommended)',
      },
    });

    expect(chosen.isError).toBeUndefined();
    expect(data(chosen)).toMatchObject({
      kind: 'pi_models_chosen',
      piModels: {
        robustness: 'meta/muse-wonder-1.0',
        ergonomics: 'xai/grok-4.7',
        implementer: 'zai/glm-5.3,xai/grok-4.7-fast',
      },
      picks: { implementer: ['zai/glm-5.3', 'xai/grok-4.7-fast'] },
      piReady: true,
      authDetail: 'ready',
    });
    expect(authChecks().slice(-3)).toEqual(['meta', 'xai', 'zai']);
    const saved = JSON.parse(await readFile(join(cwd, '.pi-flywheel', 'pi-models.json'), 'utf8')) as {
      picks: Record<string, { piModels: string[] }>;
    };
    expect(saved.picks.implementer?.piModels).toEqual(['zai/glm-5.3', 'xai/grok-4.7-fast']);

    const relisted = await runPiModels(ctx(), { action: 'list' });
    const [question] = data(relisted).questions as Question[];
    expect(question?.options.slice(0, 2).map((option) => option.description.startsWith('Last used for this role. '))).toEqual([true, true]);
  });

  it('takes implementer picks as an array of names or ids, dropping duplicates', async () => {
    await seedCache();

    const result = await runPiModels(ctx(), {
      action: 'choose',
      picks: { implementer: ['DeepSeek V4.1 Flash 1017', 'moonshotai/kimi-k3', 'vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017'] },
    });

    expect(data(result)).toMatchObject({
      piModels: { implementer: 'vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017,vercel-ai-gateway/moonshotai/kimi-k3' },
    });
  });

  it('rejects more models than a role takes', async () => {
    await seedCache();

    const planner = await runPiModels(ctx(), { action: 'choose', picks: { robustness: ['Muse Wonder', 'Grok 4.7'] } });
    const implementer = await runPiModels(ctx(), { action: 'choose', picks: { implementer: 'GLM 5.3, Grok 4.7, Muse Wonder, Kimi K3' } });
    const overlong = await runPiModels(ctx(), { action: 'choose', picks: { implementer: ['a', 'b', 'c', 'd'] } });

    expect(data(planner)).toMatchObject({ error: { code: 'invalid_input', message: 'flywheel_pi_models: robustness takes one model, got 2' } });
    expect(data(implementer)).toMatchObject({ error: { code: 'invalid_input', message: 'flywheel_pi_models: implementer takes 1 to 3 models, got 4' } });
    expect(data(overlong)).toMatchObject({ error: { code: 'invalid_input', details: { field: 'picks.implementer' } } });
  });

  it('saves a pick but reports piReady false when the chosen route has no credentials', async () => {
    await seedCache();
    delete ready['vercel-ai-gateway'];

    const result = await runPiModels(ctx(), { action: 'choose', picks: { implementer: 'moonshotai/kimi-k3' } });

    expect(data(result)).toMatchObject({
      piModels: { implementer: 'vercel-ai-gateway/moonshotai/kimi-k3' },
      piReady: false,
      authDetail: 'vercel-ai-gateway not_ready (credentials_not_configured)',
    });
    expect(result.content[0]?.text).toContain('not ready (vercel-ai-gateway not_ready (credentials_not_configured))');
  });

  it('rejects an answer no route lists, with suggestions', async () => {
    await seedCache();

    const result = await runPiModels(ctx(), { action: 'choose', picks: { implementer: 'deepseek fast' } });

    expect(result.isError).toBe(true);
    expect(data(result)).toMatchObject({
      kind: 'error',
      error: {
        code: 'invalid_input',
        details: { role: 'implementer', answer: 'deepseek fast', suggestions: ['vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017-fast'] },
        hint: 'Did you mean one of: vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017-fast?',
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

  it('fails when no login and no gateway credentials are ready', async () => {
    await seedCache();
    ready = {};

    const result = await runPiModels(ctx(), { action: 'list' });

    expect(result.isError).toBe(true);
    expect(data(result)).toMatchObject({ error: { code: 'missing_prerequisite' } });
    expect((data(result).error as { message: string }).message).toContain('xai not_ready (credentials_not_configured)');
  });

  it('fails retryably when the gateway is unreachable and nothing is cached', async () => {
    const result = await runPiModels(ctx(), { action: 'list' });

    expect(result.isError).toBe(true);
    expect(data(result)).toMatchObject({
      kind: 'error',
      error: { code: 'missing_prerequisite', retryable: true },
    });
    expect((data(result).error as { hint: string }).hint).toContain('treat the Pi lanes as unavailable');
  });
});
