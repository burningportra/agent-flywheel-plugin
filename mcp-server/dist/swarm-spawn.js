/**
 * `swarm-spawn` starts a flywheel swarm: `ntm spawn` for the lanes NTM runs
 * (cc, cod), then one tmux pane per Pi or Gemini pane in the same session
 * window, because ntm has no Pi agent type. Gemini panes are Pi on
 * gemini-4-argon; ntm's own gmi lane would start the gemini CLI. It prints
 * every pane's lane and tmux index as JSON so the coordinator can address
 * those panes with `ntm --robot-send --panes=<index>`.
 */
import process from 'node:process';
import { makeExec } from './exec.js';
import { GEMINI_LANE_MODEL } from './pi-models.js';
const NTM_LANES = ['cc', 'cod'];
/** `provider/id` with an optional nested id, e.g. `vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017`. */
const PI_MODEL_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/;
const LANE_VALUE_PATTERN = /^(\d+)(:[A-Za-z0-9._@:+-]+)?$/;
const NTM_SPAWN_TIMEOUT_MS = 180_000;
const TMUX_TIMEOUT_MS = 10_000;
function usageText() {
    return [
        'Usage: swarm-spawn <project> --label <label> [--cc=N] [--cod=N] [--gmi=N]',
        '                   [--pi=N --pi-model=<provider/model> [--pi-model=...]] [--pi-name=<prefix>]',
        '                   [-- <extra ntm spawn flags>]',
        '',
        'Runs ntm spawn --no-user --stagger-mode=smart for the cc/cod lanes, then adds',
        'the Pi panes to the session with tmux split-window, cycling through the models, and the',
        `Gemini panes, which are Pi on ${GEMINI_LANE_MODEL}. Each runs`,
        '`pi --model <model> --thinking high --no-approve`. Prints',
        '{"session","panes":[{"lane","index","paneId","model"}]}.',
    ].join('\n');
}
export function laneCount(value) {
    const match = value === undefined ? null : LANE_VALUE_PATTERN.exec(value);
    return match ? Number(match[1]) : 0;
}
export function parseSwarmSpawnArgs(argv, cwd) {
    const separator = argv.indexOf('--');
    const own = separator === -1 ? [...argv] : argv.slice(0, separator);
    const ntmArgs = separator === -1 ? [] : argv.slice(separator + 1);
    const positional = [];
    const values = new Map();
    for (let i = 0; i < own.length; i++) {
        const token = own[i];
        if (!token.startsWith('--')) {
            positional.push(token);
            continue;
        }
        const eq = token.indexOf('=');
        const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
        let value = eq === -1 ? undefined : token.slice(eq + 1);
        if (value === undefined) {
            value = own[i + 1];
            if (value === undefined || value.startsWith('--'))
                return { ok: false, error: `--${key} needs a value` };
            i++;
        }
        values.set(key, [...(values.get(key) ?? []), value]);
    }
    const known = new Set(['label', 'cc', 'cod', 'gmi', 'pi', 'pi-model', 'pi-name']);
    for (const key of values.keys()) {
        if (!known.has(key))
            return { ok: false, error: `unknown flag --${key} (pass ntm spawn flags after --)` };
    }
    if (positional.length !== 1)
        return { ok: false, error: 'pass exactly one project name' };
    const label = values.get('label')?.at(-1);
    if (!label || !/^[A-Za-z0-9._-]+$/.test(label))
        return { ok: false, error: '--label is required (letters, digits, . _ -)' };
    const ntmLanes = {};
    for (const lane of NTM_LANES) {
        const value = values.get(lane)?.at(-1);
        if (value === undefined)
            continue;
        if (!LANE_VALUE_PATTERN.test(value))
            return { ok: false, error: `--${lane}=${value} is not N or N:model` };
        if (laneCount(value) > 0)
            ntmLanes[lane] = value;
    }
    const piValue = values.get('pi')?.at(-1) ?? '0';
    if (!/^\d+$/.test(piValue))
        return { ok: false, error: `--pi=${piValue} is not a count` };
    const piCount = Number(piValue);
    const gmiValue = values.get('gmi')?.at(-1) ?? '0';
    if (!/^\d+$/.test(gmiValue)) {
        return { ok: false, error: `--gmi=${gmiValue} is not a count; Gemini panes always run ${GEMINI_LANE_MODEL}` };
    }
    const gmiCount = Number(gmiValue);
    const piModels = (values.get('pi-model') ?? []).flatMap((value) => value.split(',')).filter(Boolean);
    for (const model of piModels) {
        if (!PI_MODEL_PATTERN.test(model))
            return { ok: false, error: `--pi-model=${model} is not a provider/model id` };
    }
    if (piCount > 0 && piModels.length === 0)
        return { ok: false, error: '--pi needs at least one --pi-model' };
    if (Object.keys(ntmLanes).length === 0) {
        return { ok: false, error: 'at least one of --cc, --cod must be above 0; ntm creates the session the Pi and Gemini panes join' };
    }
    const piName = values.get('pi-name')?.at(-1) ?? label;
    if (!/^[A-Za-z0-9._-]+$/.test(piName))
        return { ok: false, error: '--pi-name allows letters, digits, . _ -' };
    return {
        ok: true,
        args: { project: positional[0], label, ntmLanes, piCount, piModels, gmiCount, piName, ntmArgs, cwd },
    };
}
export function buildNtmSpawnArgs(args) {
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
export function buildPiPaneCommand(piBin, model, name) {
    return [piBin, '--model', model, '--thinking', 'high', '--no-approve', '--name', name];
}
const NTM_TITLE_PATTERN = /__(cc|cod)_\d+$/;
function planPiPanes(args, session) {
    const pi = Array.from({ length: args.piCount }, (_, i) => ({
        lane: 'pi',
        model: args.piModels[i % args.piModels.length],
        name: `${args.piName}-${i + 1}`,
        title: `${session}__pi_${i + 1}`,
    }));
    const gmi = Array.from({ length: args.gmiCount }, (_, i) => ({
        lane: 'gmi',
        model: GEMINI_LANE_MODEL,
        name: `${args.piName}-gmi-${i + 1}`,
        title: `${session}__pi_gmi_${i + 1}`,
    }));
    return [...pi, ...gmi];
}
export function classifyPanes(listing, piPanes) {
    return listing
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
        const [index = '', paneId = '', title = ''] = line.split('\t');
        const pane = piPanes.get(paneId);
        if (pane !== undefined)
            return { lane: pane.lane, index: Number(index), paneId, title, model: pane.model };
        const lane = NTM_TITLE_PATTERN.exec(title)?.[1];
        return { lane: lane ?? 'unknown', index: Number(index), paneId, title };
    });
}
export async function spawnSwarm(args, exec) {
    const session = `${args.project}--${args.label}`;
    const target = `${session}:0`;
    const errors = [];
    const run = async (cmd, cmdArgs, timeout = TMUX_TIMEOUT_MS) => {
        try {
            return await exec(cmd, cmdArgs, { timeout, cwd: args.cwd });
        }
        catch (err) {
            return { code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
        }
    };
    const planned = planPiPanes(args, session);
    let piBin = 'pi';
    if (planned.length > 0) {
        const which = await run('which', ['pi']);
        const path = which.stdout.trim().split('\n')[0] ?? '';
        if (which.code !== 0 || path.length === 0) {
            return { session, panes: [], errors: ['pi is not on PATH; drop --pi and --gmi or install Pi'] };
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
    const piPanes = new Map();
    for (const pane of planned) {
        const command = buildPiPaneCommand(piBin, pane.model, pane.name);
        const split = ['split-window', '-t', target, '-c', args.cwd, '-P', '-F', '#{pane_id}', ...command];
        let created = await run('tmux', split);
        if (created.code !== 0) {
            await run('tmux', ['select-layout', '-t', target, 'tiled']);
            created = await run('tmux', split);
        }
        const paneId = created.stdout.trim();
        if (created.code !== 0 || !paneId.startsWith('%')) {
            errors.push(`tmux split-window for ${pane.name} failed: ${created.stderr.trim()}`);
            continue;
        }
        piPanes.set(paneId, pane);
        await run('tmux', ['set-option', '-p', '-t', paneId, 'remain-on-exit', 'on']);
        await run('tmux', ['set-option', '-p', '-t', paneId, 'allow-set-title', 'off']);
        await run('tmux', ['select-pane', '-t', paneId, '-T', pane.title]);
        await run('tmux', ['select-layout', '-t', target, 'tiled']);
    }
    const listing = await run('tmux', ['list-panes', '-t', target, '-F', '#{pane_index}\t#{pane_id}\t#{pane_title}']);
    if (listing.code !== 0)
        errors.push(`tmux list-panes failed: ${listing.stderr.trim()}`);
    return { session, panes: classifyPanes(listing.stdout, piPanes), errors };
}
export async function runCli(argv, deps = {}) {
    const stdout = deps.stdout ?? ((text) => process.stdout.write(text));
    const stderr = deps.stderr ?? ((text) => process.stderr.write(text));
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
//# sourceMappingURL=swarm-spawn.js.map