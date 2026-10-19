/**
 * `swarm-spawn` starts a flywheel swarm: `ntm spawn` for the lanes NTM runs
 * (cc, cod, gmi), then one tmux pane per Pi lane in the same session window,
 * because ntm has no Pi agent type. It prints every pane's lane and tmux
 * index as JSON so the coordinator can address Pi panes with
 * `ntm --robot-send --panes=<index>`.
 */

import process from 'node:process';

import { makeExec, type ExecFn } from './exec.js';

const NTM_LANES = ['cc', 'cod', 'gmi'] as const;
export type NtmLane = (typeof NTM_LANES)[number];
export type SwarmLane = NtmLane | 'pi';

/** `provider/id` with an optional nested id, e.g. `vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017`. */
const PI_MODEL_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/;
const LANE_VALUE_PATTERN = /^(\d+)(:[A-Za-z0-9._@:+-]+)?$/;
const NTM_SPAWN_TIMEOUT_MS = 180_000;
const TMUX_TIMEOUT_MS = 10_000;

export interface SwarmSpawnArgs {
  project: string;
  label: string;
  /** Raw NTM lane values (`2` or `2:opus`), passed through to ntm. */
  ntmLanes: Partial<Record<NtmLane, string>>;
  piCount: number;
  /** One model per Pi pane; the last one repeats when there are more panes than models. */
  piModels: string[];
  piName: string;
  ntmArgs: string[];
  cwd: string;
}

export interface SwarmPane {
  lane: SwarmLane | 'unknown';
  index: number;
  paneId: string;
  title: string;
  model?: string;
}

export interface SwarmSpawnResult {
  session: string;
  panes: SwarmPane[];
  errors: string[];
}

function usageText(): string {
  return [
    'Usage: swarm-spawn <project> --label <label> [--cc=N] [--cod=N] [--gmi=N]',
    '                   [--pi=N --pi-model=<provider/model> [--pi-model=...]] [--pi-name=<prefix>]',
    '                   [-- <extra ntm spawn flags>]',
    '',
    'Runs ntm spawn --no-user --stagger-mode=smart for the cc/cod/gmi lanes, then adds',
    'N Pi panes to the session with tmux split-window. Each Pi pane runs',
    '`pi --model <model> --thinking high --no-approve` and prints',
    '{"session","panes":[{"lane","index","paneId","model"}]}.',
  ].join('\n');
}

export function laneCount(value: string | undefined): number {
  const match = value === undefined ? null : LANE_VALUE_PATTERN.exec(value);
  return match ? Number(match[1]) : 0;
}

export function parseSwarmSpawnArgs(
  argv: readonly string[],
  cwd: string,
): { ok: true; args: SwarmSpawnArgs } | { ok: false; error: string } {
  const separator = argv.indexOf('--');
  const own = separator === -1 ? [...argv] : argv.slice(0, separator);
  const ntmArgs = separator === -1 ? [] : argv.slice(separator + 1);
  const positional: string[] = [];
  const values = new Map<string, string[]>();

  for (let i = 0; i < own.length; i++) {
    const token = own[i]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
    let value = eq === -1 ? undefined : token.slice(eq + 1);
    if (value === undefined) {
      value = own[i + 1];
      if (value === undefined || value.startsWith('--')) return { ok: false, error: `--${key} needs a value` };
      i++;
    }
    values.set(key, [...(values.get(key) ?? []), value]);
  }

  const known = new Set(['label', 'cc', 'cod', 'gmi', 'pi', 'pi-model', 'pi-name']);
  for (const key of values.keys()) {
    if (!known.has(key)) return { ok: false, error: `unknown flag --${key} (pass ntm spawn flags after --)` };
  }
  if (positional.length !== 1) return { ok: false, error: 'pass exactly one project name' };
  const label = values.get('label')?.at(-1);
  if (!label || !/^[A-Za-z0-9._-]+$/.test(label)) return { ok: false, error: '--label is required (letters, digits, . _ -)' };

  const ntmLanes: Partial<Record<NtmLane, string>> = {};
  for (const lane of NTM_LANES) {
    const value = values.get(lane)?.at(-1);
    if (value === undefined) continue;
    if (!LANE_VALUE_PATTERN.test(value)) return { ok: false, error: `--${lane}=${value} is not N or N:model` };
    if (laneCount(value) > 0) ntmLanes[lane] = value;
  }
  const piValue = values.get('pi')?.at(-1) ?? '0';
  if (!/^\d+$/.test(piValue)) return { ok: false, error: `--pi=${piValue} is not a count` };
  const piCount = Number(piValue);
  const piModels = (values.get('pi-model') ?? []).flatMap((value) => value.split(',')).filter(Boolean);
  for (const model of piModels) {
    if (!PI_MODEL_PATTERN.test(model)) return { ok: false, error: `--pi-model=${model} is not a provider/model id` };
  }
  if (piCount > 0 && piModels.length === 0) return { ok: false, error: '--pi needs at least one --pi-model' };
  if (Object.keys(ntmLanes).length === 0) {
    return { ok: false, error: 'at least one of --cc, --cod, --gmi must be above 0; ntm creates the session the Pi panes join' };
  }
  const piName = values.get('pi-name')?.at(-1) ?? label;
  if (!/^[A-Za-z0-9._-]+$/.test(piName)) return { ok: false, error: '--pi-name allows letters, digits, . _ -' };

  return {
    ok: true,
    args: { project: positional[0]!, label, ntmLanes, piCount, piModels, piName, ntmArgs, cwd },
  };
}

export function buildNtmSpawnArgs(args: SwarmSpawnArgs): string[] {
  return [
    'spawn',
    args.project,
    '--label',
    args.label,
    '--no-user',
    ...NTM_LANES.flatMap((lane) => (args.ntmLanes[lane] ? [`--${lane}=${args.ntmLanes[lane]}`] : [])),
    '--stagger-mode=smart',
    ...args.ntmArgs,
  ];
}

export function buildPiPaneCommand(piBin: string, model: string, name: string): string[] {
  return [piBin, '--model', model, '--thinking', 'high', '--no-approve', '--name', name];
}

const NTM_TITLE_PATTERN = /__(cc|cod|gmi)_\d+$/;

export function classifyPanes(
  listing: string,
  piPanes: ReadonlyMap<string, string>,
): SwarmPane[] {
  return listing
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [index = '', paneId = '', title = ''] = line.split('\t');
      const model = piPanes.get(paneId);
      if (model !== undefined) return { lane: 'pi' as const, index: Number(index), paneId, title, model };
      const lane = NTM_TITLE_PATTERN.exec(title)?.[1] as NtmLane | undefined;
      return { lane: lane ?? ('unknown' as const), index: Number(index), paneId, title };
    });
}

export async function spawnSwarm(args: SwarmSpawnArgs, exec: ExecFn): Promise<SwarmSpawnResult> {
  const session = `${args.project}--${args.label}`;
  const target = `${session}:0`;
  const errors: string[] = [];
  const run = async (cmd: string, cmdArgs: string[], timeout = TMUX_TIMEOUT_MS) => {
    try {
      return await exec(cmd, cmdArgs, { timeout, cwd: args.cwd });
    } catch (err) {
      return { code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
    }
  };

  let piBin = 'pi';
  if (args.piCount > 0) {
    const which = await run('which', ['pi']);
    const path = which.stdout.trim().split('\n')[0] ?? '';
    if (which.code !== 0 || path.length === 0) {
      return { session, panes: [], errors: ['pi is not on PATH; drop --pi or install Pi'] };
    }
    piBin = path;
  }

  const spawned = await run('ntm', buildNtmSpawnArgs(args), NTM_SPAWN_TIMEOUT_MS);
  if (spawned.code !== 0) {
    return { session, panes: [], errors: [`ntm spawn exited ${spawned.code}: ${spawned.stderr.trim() || spawned.stdout.trim()}`] };
  }
  const exists = await run('tmux', ['has-session', '-t', `=${session}`]);
  if (exists.code !== 0) {
    return { session, panes: [], errors: [`ntm spawn finished but tmux has no session ${session}`] };
  }

  const piPanes = new Map<string, string>();
  for (let i = 0; i < args.piCount; i++) {
    const model = args.piModels[Math.min(i, args.piModels.length - 1)]!;
    const command = buildPiPaneCommand(piBin, model, `${args.piName}-${i + 1}`);
    const split = ['split-window', '-t', target, '-c', args.cwd, '-P', '-F', '#{pane_id}', ...command];
    let created = await run('tmux', split);
    if (created.code !== 0) {
      await run('tmux', ['select-layout', '-t', target, 'tiled']);
      created = await run('tmux', split);
    }
    const paneId = created.stdout.trim();
    if (created.code !== 0 || !paneId.startsWith('%')) {
      errors.push(`tmux split-window for Pi pane ${i + 1} failed: ${created.stderr.trim()}`);
      continue;
    }
    piPanes.set(paneId, model);
    await run('tmux', ['set-option', '-p', '-t', paneId, 'remain-on-exit', 'on']);
    await run('tmux', ['set-option', '-p', '-t', paneId, 'allow-set-title', 'off']);
    await run('tmux', ['select-pane', '-t', paneId, '-T', `${session}__pi_${i + 1}`]);
    await run('tmux', ['select-layout', '-t', target, 'tiled']);
  }

  const listing = await run('tmux', ['list-panes', '-t', target, '-F', '#{pane_index}\t#{pane_id}\t#{pane_title}']);
  if (listing.code !== 0) errors.push(`tmux list-panes failed: ${listing.stderr.trim()}`);
  return { session, panes: classifyPanes(listing.stdout, piPanes), errors };
}

export interface SwarmSpawnDeps {
  exec?: ExecFn;
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export async function runCli(argv: string[], deps: SwarmSpawnDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout(`${usageText()}\n`);
    return 0;
  }
  const cwd = deps.cwd ?? process.cwd();
  const parsed = parseSwarmSpawnArgs(argv, cwd);
  if (!parsed.ok) {
    stderr(`swarm-spawn: ${parsed.error}\n\n${usageText()}\n`);
    return 2;
  }
  const result = await spawnSwarm(parsed.args, deps.exec ?? makeExec(cwd));
  stdout(`${JSON.stringify(result, null, 2)}\n`);
  return result.errors.length === 0 ? 0 : 1;
}
