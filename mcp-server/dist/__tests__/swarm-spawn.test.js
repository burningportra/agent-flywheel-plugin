import { describe, expect, it, vi } from 'vitest';
import { buildNtmSpawnArgs, buildPiPaneCommand, classifyPanes, laneCount, parseSwarmSpawnArgs, runCli, spawnSwarm, } from '../swarm-spawn.js';
const DEEPSEEK = 'vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017';
const GLM = 'vercel-ai-gateway/zai/glm-5.3';
function parse(argv) {
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
                piName: 'deep-plan',
                ntmArgs: ['--auto-restart'],
                cwd: '/repo',
            },
        });
    });
    it('keeps N:model lane values, drops zero lanes, and names Pi panes after the label by default', () => {
        const parsed = parse(['proj', '--label=impl-x', '--cc=2:opus', '--cod=0', '--gmi=2']);
        expect(parsed).toMatchObject({
            ok: true,
            args: { ntmLanes: { cc: '2:opus', gmi: '2' }, piCount: 0, piModels: [], piName: 'impl-x', ntmArgs: [] },
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
        [['proj', '--label=x', '--pi=2', `--pi-model=${GLM}`], 'at least one of --cc, --cod, --gmi must be above 0; ntm creates the session the Pi panes join'],
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
function args(overrides = {}) {
    return {
        project: 'proj',
        label: 'deep-plan-x',
        ntmLanes: { cc: '1' },
        piCount: 2,
        piModels: [DEEPSEEK, GLM],
        piName: 'deep-plan',
        ntmArgs: [],
        cwd: '/repo',
        ...overrides,
    };
}
describe('command builders', () => {
    it('spawns NTM lanes in cc, cod, gmi order with --no-user and smart stagger before passthrough flags', () => {
        expect(buildNtmSpawnArgs(args({ ntmLanes: { gmi: '2', cc: '2' }, ntmArgs: ['--auto-restart'] }))).toEqual([
            'spawn', 'proj', '--label', 'deep-plan-x', '--no-user', '--cc=2', '--gmi=2', '--stagger-mode=smart', '--auto-restart',
        ]);
    });
    it('runs Pi with high thinking and no approval prompts', () => {
        expect(buildPiPaneCommand('/opt/bin/pi', GLM, 'impl-1')).toEqual([
            '/opt/bin/pi', '--model', GLM, '--thinking', 'high', '--no-approve', '--name', 'impl-1',
        ]);
    });
    it('labels Pi panes by id and NTM panes by title', () => {
        const listing = [
            '0\t%45\tproj--deep-plan-x__cc_1',
            '1\t%46\tπ deep-plan-1',
            '2\t%47\tzsh',
            '',
        ].join('\n');
        expect(classifyPanes(listing, new Map([['%46', DEEPSEEK]]))).toEqual([
            { lane: 'cc', index: 0, paneId: '%45', title: 'proj--deep-plan-x__cc_1' },
            { lane: 'pi', index: 1, paneId: '%46', title: 'π deep-plan-1', model: DEEPSEEK },
            { lane: 'unknown', index: 2, paneId: '%47', title: 'zsh' },
        ]);
    });
});
function fakeTmux(overrides = () => undefined) {
    let nextPane = 46;
    const created = [];
    const exec = vi.fn(async (cmd, cmdArgs) => {
        const override = overrides(cmd, cmdArgs);
        if (override)
            return { stdout: '', stderr: '', ...override };
        if (cmd === 'which')
            return { code: 0, stdout: '/opt/bin/pi\n', stderr: '' };
        if (cmd === 'ntm')
            return { code: 0, stdout: 'spawned', stderr: '' };
        if (cmd === 'tmux' && cmdArgs[0] === 'split-window') {
            const paneId = `%${nextPane++}`;
            created.push(paneId);
            return { code: 0, stdout: `${paneId}\n`, stderr: '' };
        }
        if (cmd === 'tmux' && cmdArgs[0] === 'list-panes') {
            const lines = ['0\t%45\tproj--deep-plan-x__cc_1', ...created.map((id, i) => `${i + 1}\t${id}\tproj--deep-plan-x__pi_${i + 1}`)];
            return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
    });
    const calls = (sub) => exec.mock.calls.filter(([cmd, cmdArgs]) => cmd === 'tmux' && cmdArgs[0] === sub).map(([, cmdArgs]) => cmdArgs);
    return { exec, calls };
}
describe('spawnSwarm', () => {
    it('spawns the NTM lanes, then one Pi pane per model with the last model repeating', async () => {
        const { exec, calls } = fakeTmux();
        const result = await spawnSwarm(args({ piCount: 3 }), exec);
        expect(result).toEqual({
            session: 'proj--deep-plan-x',
            errors: [],
            panes: [
                { lane: 'cc', index: 0, paneId: '%45', title: 'proj--deep-plan-x__cc_1' },
                { lane: 'pi', index: 1, paneId: '%46', title: 'proj--deep-plan-x__pi_1', model: DEEPSEEK },
                { lane: 'pi', index: 2, paneId: '%47', title: 'proj--deep-plan-x__pi_2', model: GLM },
                { lane: 'pi', index: 3, paneId: '%48', title: 'proj--deep-plan-x__pi_3', model: GLM },
            ],
        });
        expect(exec).toHaveBeenCalledWith('ntm', ['spawn', 'proj', '--label', 'deep-plan-x', '--no-user', '--cc=1', '--stagger-mode=smart'], expect.objectContaining({ timeout: 180_000, cwd: '/repo' }));
        expect(calls('split-window')[0]).toEqual([
            'split-window', '-t', 'proj--deep-plan-x:0', '-c', '/repo', '-P', '-F', '#{pane_id}',
            '/opt/bin/pi', '--model', DEEPSEEK, '--thinking', 'high', '--no-approve', '--name', 'deep-plan-1',
        ]);
        expect(calls('set-option')).toContainEqual(['set-option', '-p', '-t', '%46', 'remain-on-exit', 'on']);
        expect(calls('select-pane')).toContainEqual(['select-pane', '-t', '%48', '-T', 'proj--deep-plan-x__pi_3']);
        for (const [, , opts] of exec.mock.calls)
            expect(opts?.timeout).toBeGreaterThan(0);
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
            errors: ['pi is not on PATH; drop --pi or install Pi'],
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
            if (cmd === 'tmux' && cmdArgs[0] === 'split-window' && splits++ < 2)
                return { code: 1, stderr: 'no space for new pane' };
            return undefined;
        });
        const result = await spawnSwarm(args(), exec);
        expect(result.errors).toEqual(['tmux split-window for Pi pane 1 failed: no space for new pane']);
        expect(result.panes.filter((pane) => pane.lane === 'pi')).toEqual([
            { lane: 'pi', index: 1, paneId: '%46', title: 'proj--deep-plan-x__pi_1', model: GLM },
        ]);
    });
    it('turns a thrown exec error into a reported failure', async () => {
        const exec = vi.fn(async () => {
            throw new Error('spawn ntm ENOENT');
        });
        expect((await spawnSwarm(args({ piCount: 0, piModels: [] }), exec)).errors).toEqual([
            'ntm spawn exited 1: spawn ntm ENOENT',
        ]);
    });
});
describe('runCli', () => {
    function io() {
        const out = [];
        const err = [];
        return { out, err, deps: { cwd: '/repo', stdout: (text) => out.push(text), stderr: (text) => err.push(text) } };
    }
    it('prints usage for --help', async () => {
        const { out, deps } = io();
        expect(await runCli(['--help'], deps)).toBe(0);
        expect(out.join('')).toContain('Usage: swarm-spawn <project> --label <label>');
    });
    it('exits 2 with the parse error and usage on bad flags', async () => {
        const { err, deps } = io();
        expect(await runCli(['proj', '--cc=1'], deps)).toBe(2);
        expect(err.join('')).toMatch(/^swarm-spawn: --label is required[\s\S]*Usage:/);
    });
    it('prints the pane JSON and exits 0 on success, 1 when a step failed', async () => {
        const ok = io();
        const { exec } = fakeTmux();
        expect(await runCli(['proj', '--label=deep-plan-x', '--cc=1', '--pi=1', `--pi-model=${GLM}`], { ...ok.deps, exec })).toBe(0);
        expect(JSON.parse(ok.out.join(''))).toMatchObject({
            session: 'proj--deep-plan-x',
            panes: [{ lane: 'cc', index: 0 }, { lane: 'pi', index: 1, model: GLM }],
            errors: [],
        });
        const failed = io();
        const noPi = fakeTmux((cmd) => (cmd === 'which' ? { code: 1 } : undefined));
        expect(await runCli(['proj', '--label=x', '--cc=1', '--pi=1', `--pi-model=${GLM}`], { ...failed.deps, exec: noPi.exec })).toBe(1);
        expect(JSON.parse(failed.out.join('')).errors).toHaveLength(1);
    });
});
//# sourceMappingURL=swarm-spawn.test.js.map