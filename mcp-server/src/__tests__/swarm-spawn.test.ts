import { describe, expect, it, vi } from 'vitest';

import type { ExecFn } from '../exec.js';
import { GEMINI_LANE_MODEL } from '../pi-models.js';
import {
  buildNtmSpawnArgs,
  buildPiPaneCommand,
  classifyPanes,
  laneCount,
  laneModel,
  normalizeAgyLaneValue,
  resolveAgySlug,
  parseSwarmSpawnArgs,
  runCli,
  spawnSwarm,
  type SwarmSpawnArgs,
} from '../swarm-spawn.js';

const DEEPSEEK = 'vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017';
const GLM = 'vercel-ai-gateway/zai/glm-5.3';

function parse(argv: string[]) {
  return parseSwarmSpawnArgs(argv, '/repo');
}

describe('parseSwarmSpawnArgs', () => {
  it('parses lanes, repeated and comma-separated Pi models, and ntm passthrough flags', () => {
    expect(parse([
      'proj', '--label', 'deep-plan-x', '--cc=1', '--pi=3', `--pi-model=${DEEPSEEK},${GLM}`,
      '--pi-model', 'openrouter/qwen/qwen4-coder', '--pi-name=deep-plan', '--', '--auto-restart',
    ])).toEqual({
      ok: true,
      args: {
        project: 'proj',
        label: 'deep-plan-x',
        ntmLanes: { cc: '1' },
        piCount: 3,
        piModels: [DEEPSEEK, GLM, 'openrouter/qwen/qwen4-coder'],
        gmiCount: 0,
        piName: 'deep-plan',
        ntmArgs: ['--auto-restart'],
        cwd: '/repo',
      },
    });
  });

  it('keeps N:model lane values, drops zero lanes, and names Pi panes after the label by default', () => {
    const parsed = parse(['proj', '--label=impl-x', '--cc=2:opus', '--cod=0', '--agy=1:gemini-4-argon:high', '--gmi=2']);

    expect(parsed).toMatchObject({
      ok: true,
      args: { ntmLanes: { cc: '2:opus', agy: '1:gemini-4-argon-high' }, piCount: 0, piModels: [], gmiCount: 2, piName: 'impl-x', ntmArgs: [] },
    });
  });

  it.each([
    [['proj', '--label=x', '--cc=1', '--pane=2'], 'unknown flag --pane (pass ntm spawn flags after --)'],
    [['--label=x', '--cc=1'], 'pass exactly one project name'],
    [['a', 'b', '--label=x', '--cc=1'], 'pass exactly one project name'],
    [['proj', '--cc=1'], '--label is required (letters, digits, . _ -)'],
    [['proj', '--label=a b', '--cc=1'], '--label is required (letters, digits, . _ -)'],
    [['proj', '--label', '--cc=1'], '--label needs a value'],
    [['proj', '--label=x', '--cc=two'], '--cc=two is not N or N:model'],
    [['proj', '--label=x', '--cc=1', '--pi=two', `--pi-model=${GLM}`], '--pi=two is not a count'],
    [['proj', '--label=x', '--cc=1', '--pi=2'], '--pi needs at least one --pi-model'],
    [['proj', '--label=x', '--cc=1', '--pi=1', '--pi-model=glm-5.3'], '--pi-model=glm-5.3 is not a provider/model id'],
    [['proj', '--label=x', '--cc=1', '--pi=1', '--pi-model=a/b;rm'], '--pi-model=a/b;rm is not a provider/model id'],
    [['proj', '--label=x', '--pi=2', `--pi-model=${GLM}`], 'at least one of --cc, --cod, --agy must be above 0; ntm creates the session the Pi and Gemini panes join'],
    [['proj', '--label=x', '--gmi=2'], 'at least one of --cc, --cod, --agy must be above 0; ntm creates the session the Pi and Gemini panes join'],
    [['proj', '--label=x', '--cc=1', '--gmi=2:flash'], `--gmi=2:flash is not a count; Gemini panes always run ${GEMINI_LANE_MODEL}`],
    [['proj', '--label=x', '--cc=1', '--pi-name=a/b'], '--pi-name allows letters, digits, . _ -'],
  ])('rejects %j', (argv, error) => {
    expect(parse(argv)).toEqual({ ok: false, error });
  });
});

describe('laneCount', () => {
  it.each([
    ['2', 2],
    ['2:opus', 2],
    ['x', 0],
    [undefined, 0],
  ])('%j counts %d panes', (value, count) => {
    expect(laneCount(value)).toBe(count);
  });
});

describe('agy lane values', () => {
  it.each([
    ['1', '1'],
    ['1:gemini-4-argon-high', '1:gemini-4-argon-high'],
    ['2:gemini-4-argon:high', '2:gemini-4-argon-high'],
    ['1:gemini-4-argon-low:high', '1:gemini-4-argon-low'],
    ['1:claude-opus-5-5:xhigh', '1:claude-opus-5-5-xhigh'],
    ['0:gemini-4-argon', '0:gemini-4-argon'],
  ])('normalizes --agy=%s to %s', (value, normalized) => {
    expect(normalizeAgyLaneValue(value)).toBe(normalized);
  });

  it.each([
    'Gemini 4 Argon (High)',
    '1:Gemini 4 Argon (High)',
    '1:gemini 4 argon',
    '1:gemini-4-argon(high)',
    '1:Gemini-4-Argon',
    '1:gemini-4-argon:turbo',
    '1:gemini-4-argon:high:extra',
    '1:-gemini',
    '1:',
    'x',
  ])('rejects --agy=%s', (value) => {
    expect(normalizeAgyLaneValue(value)).toBeUndefined();
    expect(parse(['proj', '--label=impl-x', '--cc=1', `--agy=${value}`])).toMatchObject({ ok: false });
  });

  it('resolveAgySlug adds the effort only to a bare model', () => {
    expect(resolveAgySlug('gemini-4-argon', 'high')).toBe('gemini-4-argon-high');
    expect(resolveAgySlug('gemini-4-argon-medium', 'high')).toBe('gemini-4-argon-medium');
    expect(resolveAgySlug('gemini-4-argon')).toBe('gemini-4-argon');
  });

  it('spawns an agy-only swarm with the resolved slug', () => {
    const parsed = parse(['proj', '--label=impl-x', '--agy=2:gemini-4-argon:high']);
    expect(parsed.ok && buildNtmSpawnArgs(parsed.args)).toContain('--agy=2:gemini-4-argon-high');
  });
});

describe('strict non-agy lane values', () => {
  it.each(['cc', 'cod'])('rejects display names and spaces on --%s', (lane) => {
    for (const value of ['2:Claude Opus (High)', '2:opus (high)', '2:a b', '2.5', '-1']) {
      expect(parse(['proj', '--label=impl-x', `--${lane}=${value}`])).toMatchObject({ ok: false });
    }
  });

  it.each(['gmi', 'pi'])('rejects anything but a count on --%s', (lane) => {
    for (const value of ['1:gemini-4-argon', '1 ', '(1)']) {
      expect(parse(['proj', '--label=impl-x', '--cc=1', `--${lane}=${value}`, '--pi-model=xai/grok-4.7'])).toMatchObject({ ok: false });
    }
  });

  it.each(['1:Gemini 4 Argon (High)', '1:a b', '1:x/y'])('laneCount and laneModel ignore %j', (value) => {
    expect(laneCount(value)).toBe(0);
    expect(laneModel(value)).toBeUndefined();
  });
});

describe('laneModel', () => {
  it.each([
    ['2:opus', 'opus'],
    ['1:gpt-5.4', 'gpt-5.4'],
    ['2', undefined],
    ['x', undefined],
    [undefined, undefined],
  ])('%j extracts model %j', (value, model) => {
    expect(laneModel(value)).toBe(model);
  });
});

function args(overrides: Partial<SwarmSpawnArgs> = {}): SwarmSpawnArgs {
  return {
    project: 'proj',
    label: 'deep-plan-x',
    ntmLanes: { cc: '1' },
    piCount: 2,
    piModels: [DEEPSEEK, GLM],
    gmiCount: 0,
    piName: 'deep-plan',
    ntmArgs: [],
    cwd: '/repo',
    ...overrides,
  };
}

describe('command builders', () => {
  it('spawns NTM lanes in cc, cod, agy order with --no-user and smart stagger before passthrough flags, never gmi', () => {
    expect(buildNtmSpawnArgs(args({ ntmLanes: { agy: '1:argon', cod: '2', cc: '2' }, gmiCount: 2, ntmArgs: ['--auto-restart'] }))).toEqual([
      'spawn', 'proj', '--label', 'deep-plan-x', '--no-user', '--cc=2', '--cod=2', '--agy=1:argon', '--stagger-mode=smart', '--auto-restart',
    ]);
  });

  it('runs Pi with high thinking and no approval prompts', () => {
    expect(buildPiPaneCommand('/opt/bin/pi', GLM, 'impl-1')).toEqual([
      '/opt/bin/pi', '--model', GLM, '--thinking', 'high', '--no-approve', '--name', 'impl-1',
    ]);
  });

  it('labels Pi and Gemini panes by id and NTM panes by title', () => {
    const listing = [
      '0\t%45\tproj--deep-plan-x__cc_1',
      '1\t%46\tπ deep-plan-1',
      '2\t%47\tproj--deep-plan-x__pi_gmi_1',
      '3\t%48\tproj--deep-plan-x__gmi_1',
      '4\t%49\tzsh',
      '',
    ].join('\n');

    expect(classifyPanes(listing, new Map([
      ['%46', { lane: 'pi' as const, model: DEEPSEEK }],
      ['%47', { lane: 'gmi' as const, model: GEMINI_LANE_MODEL }],
    ]))).toEqual([
      { lane: 'cc', index: 0, paneId: '%45', title: 'proj--deep-plan-x__cc_1' },
      { lane: 'pi', index: 1, paneId: '%46', title: 'π deep-plan-1', model: DEEPSEEK },
      { lane: 'gmi', index: 2, paneId: '%47', title: 'proj--deep-plan-x__pi_gmi_1', model: GEMINI_LANE_MODEL },
      { lane: 'unknown', index: 3, paneId: '%48', title: 'proj--deep-plan-x__gmi_1' },
      { lane: 'unknown', index: 4, paneId: '%49', title: 'zsh' },
    ]);
  });

  it('includes models for cc, cod, and agy panes from N:model lane values or ntm variant titles', () => {
    const listing = [
      '0\t%45\tproj--impl-x__cc_1',
      '1\t%46\tproj--impl-x__cod_1',
      '2\t%47\tproj--impl-x__cc_2_opus',
      '3\t%48\tproj--impl-x__agy_1',
      '',
    ].join('\n');

    expect(classifyPanes(listing, new Map(), { cc: '2:claude-opus-4-7', cod: '1:gpt-5.4', agy: '1:gemini-4-argon-high' })).toEqual([
      { lane: 'cc', index: 0, paneId: '%45', title: 'proj--impl-x__cc_1', model: 'claude-opus-4-7' },
      { lane: 'cod', index: 1, paneId: '%46', title: 'proj--impl-x__cod_1', model: 'gpt-5.4' },
      { lane: 'cc', index: 2, paneId: '%47', title: 'proj--impl-x__cc_2_opus', model: 'claude-opus-4-7' },
      { lane: 'agy', index: 3, paneId: '%48', title: 'proj--impl-x__agy_1', model: 'gemini-4-argon-high' },
    ]);
    expect(classifyPanes('0\t%45\tproj--impl-x__cc_1_opus\n1\t%46\tproj--impl-x__agy_1_argon\n', new Map())).toEqual([
      { lane: 'cc', index: 0, paneId: '%45', title: 'proj--impl-x__cc_1_opus', model: 'opus' },
      { lane: 'agy', index: 1, paneId: '%46', title: 'proj--impl-x__agy_1_argon', model: 'argon' },
    ]);
  });
});

type Handler = (cmd: string, cmdArgs: string[]) => { code: number; stdout?: string; stderr?: string } | undefined;

function fakeTmux(overrides: Handler = () => undefined) {
  let nextPane = 46;
  const created: string[] = [];
  const titles = new Map<string, string>();
  const exec = vi.fn<ExecFn>(async (cmd, cmdArgs) => {
    const override = overrides(cmd, cmdArgs);
    if (override) return { stdout: '', stderr: '', ...override };
    if (cmd === 'which') return { code: 0, stdout: '/opt/bin/pi\n', stderr: '' };
    if (cmd === 'ntm') return { code: 0, stdout: 'spawned', stderr: '' };
    if (cmd === 'tmux' && cmdArgs[0] === 'split-window') {
      const paneId = `%${nextPane++}`;
      created.push(paneId);
      return { code: 0, stdout: `${paneId}\n`, stderr: '' };
    }
    if (cmd === 'tmux' && cmdArgs[0] === 'select-pane') titles.set(cmdArgs[2]!, cmdArgs[4]!);
    if (cmd === 'tmux' && cmdArgs[0] === 'list-panes') {
      const lines = ['0\t%45\tproj--deep-plan-x__cc_1', ...created.map((id, i) => `${i + 1}\t${id}\t${titles.get(id) ?? 'π'}`)];
      return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
  const calls = (sub: string): string[][] =>
    exec.mock.calls.filter(([cmd, cmdArgs]) => cmd === 'tmux' && cmdArgs[0] === sub).map(([, cmdArgs]) => cmdArgs);
  return { exec, calls };
}

describe('spawnSwarm', () => {
  it('spawns the NTM lanes, then Pi panes that cycle through the models', async () => {
    const { exec, calls } = fakeTmux();

    const result = await spawnSwarm(args({ piCount: 3 }), exec);

    expect(result).toEqual({
      session: 'proj--deep-plan-x',
      errors: [],
      panes: [
        { lane: 'cc', index: 0, paneId: '%45', title: 'proj--deep-plan-x__cc_1' },
        { lane: 'pi', index: 1, paneId: '%46', title: 'proj--deep-plan-x__pi_1', model: DEEPSEEK },
        { lane: 'pi', index: 2, paneId: '%47', title: 'proj--deep-plan-x__pi_2', model: GLM },
        { lane: 'pi', index: 3, paneId: '%48', title: 'proj--deep-plan-x__pi_3', model: DEEPSEEK },
      ],
    });
    expect(exec).toHaveBeenCalledWith(
      'ntm',
      ['spawn', 'proj', '--label', 'deep-plan-x', '--no-user', '--cc=1', '--stagger-mode=smart'],
      expect.objectContaining({ timeout: 180_000, cwd: '/repo' }),
    );
    expect(calls('split-window')[0]).toEqual([
      'split-window', '-t', 'proj--deep-plan-x:0', '-c', '/repo', '-P', '-F', '#{pane_id}',
      '/opt/bin/pi', '--model', DEEPSEEK, '--thinking', 'high', '--no-approve', '--name', 'deep-plan-1',
    ]);
    expect(calls('set-option')).toContainEqual(['set-option', '-p', '-t', '%46', 'remain-on-exit', 'on']);
    expect(calls('select-pane')).toContainEqual(['select-pane', '-t', '%48', '-T', 'proj--deep-plan-x__pi_3']);
    for (const [, , opts] of exec.mock.calls) expect(opts?.timeout).toBeGreaterThan(0);
  });

  it('adds Gemini panes as Pi on gemini-4-argon after the Pi panes, titled so ntm does not take them for gemini CLI panes', async () => {
    const { exec, calls } = fakeTmux();

    const result = await spawnSwarm(args({ piCount: 1, gmiCount: 2 }), exec);

    expect(result).toEqual({
      session: 'proj--deep-plan-x',
      errors: [],
      panes: [
        { lane: 'cc', index: 0, paneId: '%45', title: 'proj--deep-plan-x__cc_1' },
        { lane: 'pi', index: 1, paneId: '%46', title: 'proj--deep-plan-x__pi_1', model: DEEPSEEK },
        { lane: 'gmi', index: 2, paneId: '%47', title: 'proj--deep-plan-x__pi_gmi_1', model: GEMINI_LANE_MODEL },
        { lane: 'gmi', index: 3, paneId: '%48', title: 'proj--deep-plan-x__pi_gmi_2', model: GEMINI_LANE_MODEL },
      ],
    });
    expect(calls('split-window')[1]).toEqual([
      'split-window', '-t', 'proj--deep-plan-x:0', '-c', '/repo', '-P', '-F', '#{pane_id}',
      '/opt/bin/pi', '--model', 'vercel-ai-gateway/google/gemini-4-argon', '--thinking', 'high', '--no-approve', '--name', 'deep-plan-gmi-1',
    ]);
    expect(exec).toHaveBeenCalledWith(
      'ntm',
      ['spawn', 'proj', '--label', 'deep-plan-x', '--no-user', '--cc=1', '--stagger-mode=smart'],
      expect.anything(),
    );
  });

  it('probes for pi when only Gemini panes need it', async () => {
    const { exec } = fakeTmux((cmd) => (cmd === 'which' ? { code: 1 } : undefined));

    expect((await spawnSwarm(args({ piCount: 0, piModels: [], gmiCount: 1 }), exec)).errors).toEqual([
      'pi is not on PATH; drop --pi and --gmi or install Pi',
    ]);
    expect(exec).not.toHaveBeenCalledWith('ntm', expect.anything(), expect.anything());
  });

  it('skips the Pi probe and splits when there are no Pi lanes', async () => {
    const { exec, calls } = fakeTmux();

    const result = await spawnSwarm(args({ piCount: 0, piModels: [] }), exec);

    expect(exec).not.toHaveBeenCalledWith('which', expect.anything(), expect.anything());
    expect(calls('split-window')).toEqual([]);
    expect(result.panes.map((pane) => pane.lane)).toEqual(['cc']);
  });

  it('stops before ntm when Pi is not on PATH', async () => {
    const { exec } = fakeTmux((cmd) => (cmd === 'which' ? { code: 1 } : undefined));

    expect(await spawnSwarm(args(), exec)).toEqual({
      session: 'proj--deep-plan-x',
      panes: [],
      errors: ['pi is not on PATH; drop --pi and --gmi or install Pi'],
    });
    expect(exec).not.toHaveBeenCalledWith('ntm', expect.anything(), expect.anything());
  });

  it('reports an ntm spawn failure and a missing session', async () => {
    const ntmFails = fakeTmux((cmd) => (cmd === 'ntm' ? { code: 2, stderr: 'unknown flag: --pi\n' } : undefined));
    const noSession = fakeTmux((cmd, cmdArgs) => (cmd === 'tmux' && cmdArgs[0] === 'has-session' ? { code: 1 } : undefined));

    expect((await spawnSwarm(args(), ntmFails.exec)).errors).toEqual(['ntm spawn exited 2: unknown flag: --pi']);
    expect((await spawnSwarm(args(), noSession.exec)).errors).toEqual([
      'ntm spawn finished but tmux has no session proj--deep-plan-x',
    ]);
  });

  it('retiles and retries a split that fails for lack of space', async () => {
    let failures = 1;
    const { exec, calls } = fakeTmux((cmd, cmdArgs) => {
      if (cmd === 'tmux' && cmdArgs[0] === 'split-window' && failures > 0) {
        failures--;
        return { code: 1, stderr: 'no space for new pane' };
      }
      return undefined;
    });

    const result = await spawnSwarm(args({ piCount: 1 }), exec);

    expect(result.errors).toEqual([]);
    expect(result.panes.filter((pane) => pane.lane === 'pi')).toHaveLength(1);
    const order = exec.mock.calls
      .filter(([cmd]) => cmd === 'tmux')
      .map(([, cmdArgs]) => cmdArgs[0])
      .slice(1, 4);
    expect(order).toEqual(['split-window', 'select-layout', 'split-window']);
    expect(calls('split-window')).toHaveLength(2);
  });

  it('records a Pi pane that could not be created and keeps the rest', async () => {
    let splits = 0;
    const { exec } = fakeTmux((cmd, cmdArgs) => {
      if (cmd === 'tmux' && cmdArgs[0] === 'split-window' && splits++ < 2) return { code: 1, stderr: 'no space for new pane' };
      return undefined;
    });

    const result = await spawnSwarm(args(), exec);

    expect(result.errors).toEqual(['tmux split-window for deep-plan-1 failed: no space for new pane']);
    expect(result.panes.filter((pane) => pane.lane === 'pi')).toEqual([
      { lane: 'pi', index: 1, paneId: '%46', title: 'proj--deep-plan-x__pi_2', model: GLM },
    ]);
  });

  it('turns a thrown exec error into a reported failure', async () => {
    const exec = vi.fn<ExecFn>(async () => {
      throw new Error('spawn ntm ENOENT');
    });

    expect((await spawnSwarm(args({ piCount: 0, piModels: [] }), exec)).errors).toEqual([
      'ntm spawn exited 1: spawn ntm ENOENT',
    ]);
  });
});

describe('runCli', () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { cwd: '/repo', stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) } };
  }

  it('prints usage for --help', async () => {
    const { out, deps } = io();

    expect(await runCli(['--help'], deps)).toBe(0);
    expect(out.join('')).toContain('Usage: swarm-spawn <project> --label <label> [--cc=N[:model]] [--cod=N[:model]] [--agy=N[:model[:effort]]] [--gmi=N]');
  });

  it('exits 2 with the parse error and usage on bad flags', async () => {
    const { err, deps } = io();

    expect(await runCli(['proj', '--cc=1'], deps)).toBe(2);
    expect(err.join('')).toMatch(/^swarm-spawn: --label is required[\s\S]*Usage:/);
  });

  it('prints the pane JSON and exits 0 on success, 1 when a step failed', async () => {
    const ok = io();
    const { exec } = fakeTmux();
    expect(await runCli(['proj', '--label=deep-plan-x', '--cc=1:opus', '--pi=1', `--pi-model=${GLM}`], { ...ok.deps, exec })).toBe(0);
    expect(JSON.parse(ok.out.join(''))).toMatchObject({
      session: 'proj--deep-plan-x',
      panes: [{ lane: 'cc', index: 0, model: 'opus' }, { lane: 'pi', index: 1, model: GLM }],
      errors: [],
    });

    const gemini = io();
    expect(await runCli(['proj', '--label=deep-plan-x', '--cc=1', '--gmi=1'], { ...gemini.deps, exec: fakeTmux().exec })).toBe(0);
    expect(JSON.parse(gemini.out.join('')).panes).toEqual([
      { lane: 'cc', index: 0, paneId: '%45', title: 'proj--deep-plan-x__cc_1' },
      { lane: 'gmi', index: 1, paneId: '%46', title: 'proj--deep-plan-x__pi_gmi_1', model: GEMINI_LANE_MODEL },
    ]);

    const failed = io();
    const noPi = fakeTmux((cmd) => (cmd === 'which' ? { code: 1 } : undefined));
    expect(await runCli(['proj', '--label=x', '--cc=1', '--pi=1', `--pi-model=${GLM}`], { ...failed.deps, exec: noPi.exec })).toBe(1);
    expect(JSON.parse(failed.out.join('')).errors).toHaveLength(1);
  });
});
