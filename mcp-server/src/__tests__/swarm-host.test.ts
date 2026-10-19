import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecFn } from '../exec.js';
import {
  buildSwarmHostQuestion,
  handOffWave,
  hostBlockers,
  hostSlug,
  makeSshExec,
  matchHostPick,
  parseDnsSdBrowse,
  parseDnsSdLookup,
  parseHostProbe,
  parseRunArgs,
  pullFromSwarmHost,
  pushToSwarmHost,
  readSwarmHost,
  recommendHost,
  remoteScript,
  resolveRoute,
  resolveSwarmLane,
  shellQuote,
  SWARM_HOST_RELATIVE_PATH,
  writeSwarmHost,
  type HostCandidate,
  type HostProbe,
  type MachineLoad,
  type SwarmHost,
} from '../swarm-host.js';
import { startTenderDaemon } from '../tender-daemon.js';

type Result = { code: number; stdout: string; stderr: string };
type Call = { cmd: string; args: string[] };

/** An exec whose answers are picked by the first matching rule; ssh rules match the remote script. */
function scriptedExec(rules: Array<[RegExp, Result | ((call: Call) => Result)]>) {
  const calls: Call[] = [];
  const exec: ExecFn = async (cmd, args) => {
    const call = { cmd, args };
    calls.push(call);
    const line = cmd === 'ssh' ? `ssh ${args.at(-1)}` : `${cmd} ${args.join(' ')}`;
    const rule = rules.find(([pattern]) => pattern.test(line));
    if (!rule) return { code: 1, stdout: '', stderr: `not scripted: ${line}` };
    return typeof rule[1] === 'function' ? rule[1](call) : rule[1];
  };
  return { exec, calls };
}

const ok = (stdout = ''): Result => ({ code: 0, stdout, stderr: '' });
const failed = (code: number, stderr: string): Result => ({ code, stdout: '', stderr });

const AIR: SwarmHost = {
  version: 1,
  name: 'Kevin’s MacBook Air',
  host: 'air.invalid',
  address: '10.9.8.7',
  user: 'kev',
  identityFile: '/keys/id_ed25519',
  repoPath: '/Users/kev/GitHub/demo-offload',
  ntmProject: 'demo-offload',
  localBranch: 'main',
  keepAwakePid: null,
  preparedAt: '2026-10-19T00:00:00.000Z',
};

const candidate = (name: string, host = `${name.toLowerCase()}.local`): HostCandidate =>
  ({ name, host, address: null, user: 'kev', identityFile: null });

function readyProbe(name: string, load: Partial<MachineLoad> = {}): Extract<HostProbe, { ok: true }> {
  return {
    ok: true,
    candidate: candidate(name),
    cores: 10,
    memGB: 24,
    load: 1,
    onBattery: false,
    batteryPercent: null,
    diskFreeGB: 90,
    home: '/Users/kev',
    projectsBase: '/Users/kev/GitHub',
    tools: {},
    missingTools: [],
    agentMail: true,
    ...load,
  };
}

const LOCAL_BUSY: MachineLoad = { cores: 12, memGB: 32, load: 30, onBattery: false, batteryPercent: null };
const LOCAL_IDLE: MachineLoad = { cores: 12, memGB: 32, load: 0.5, onBattery: false, batteryPercent: null };

describe('Bonjour parsing', () => {
  it('reads instance names from dns-sd -B and hostnames from dns-sd -L', () => {
    const browse = [
      'Browsing for _ssh._tcp.local.',
      'Timestamp     A/R    Flags  if Domain               Service Type         Instance Name',
      '11:02:33.180  Add        3  19 local.               _ssh._tcp.           Kevin’s MacBook Air',
      '11:02:33.180  Add        2  19 local.               _ssh._tcp.           Kevin’s MacBook Air',
      '11:02:33.181  Rmv        2  19 local.               _ssh._tcp.           Old Mac',
    ].join('\n');
    expect(parseDnsSdBrowse(browse)).toEqual(['Kevin’s MacBook Air']);
    expect(parseDnsSdLookup("11:02:35.1  Kevin’s\\032MacBook\\032Air._ssh._tcp.local. can be reached at Kevins-MacBook-Air.local.:22 (interface 19)"))
      .toBe('Kevins-MacBook-Air.local');
    expect(parseDnsSdLookup('Lookup Kevin’s MacBook Air._ssh._tcp.local')).toBeNull();
  });
});

describe('host probes', () => {
  it('expands a ~ projects_base and reports the tools a worker lacks', () => {
    const probe = parseHostProbe(candidate('Air'), [
      'cores=10',
      'memBytes=25769803776',
      'load=4.01',
      'diskKB=95420416',
      "power=Now drawing from 'Battery Power'",
      'battery=47%',
      'home=/Users/kev',
      'projectsBase=projects_base = "~/Documents/GitHub"',
      'tool.git=/usr/bin/git',
      'tool.tmux=/opt/homebrew/bin/tmux',
      'tool.br=/Users/kev/.local/bin/br',
      'tool.am=',
      'tool.rsync=/usr/bin/rsync',
      'mail={"status":"alive"}',
    ].join('\n'));
    expect(probe).toMatchObject({
      cores: 10,
      memGB: 24,
      load: 4.01,
      onBattery: true,
      batteryPercent: 47,
      diskFreeGB: 91,
      projectsBase: '/Users/kev/Documents/GitHub',
      agentMail: true,
      missingTools: ['ntm', 'am'],
    });
    expect(hostBlockers(probe)).toEqual(['missing ntm, am']);
  });

  it('turns ssh failures into the step that fixes them', () => {
    const blockers = (reason: 'auth' | 'host_key' | 'unreachable') =>
      hostBlockers({ ok: false, candidate: candidate('Air'), reason, detail: 'Operation timed out' }).join(' ');
    expect(blockers('auth')).toContain('authorized_keys');
    expect(blockers('host_key')).toContain('ssh kev@air.local');
    expect(blockers('unreachable')).toContain('Remote Login');
    expect(hostBlockers({ ...readyProbe('Air'), projectsBase: null })).toEqual(['ntm has no projects_base in ~/.config/ntm/config.toml']);
  });
});

describe('the swarm host question', () => {
  it('recommends a clearly lighter Mac and lists it first', () => {
    const question = buildSwarmHostQuestion(LOCAL_BUSY, [readyProbe('Air', { load: 4 })]);
    expect(question?.header).toBe('Swarm host');
    expect(question?.options.map((option) => option.label)).toEqual(['Air (Recommended)', 'This Mac']);
  });

  it('recommends this Mac when it is no busier', () => {
    const question = buildSwarmHostQuestion(LOCAL_IDLE, [readyProbe('Air', { load: 4 })]);
    expect(question?.options.map((option) => option.label)).toEqual(['This Mac (Recommended)', 'Air']);
  });

  it('never recommends a Mac on low battery, and asks nothing when no Mac can take the swarm', () => {
    expect(recommendHost(LOCAL_BUSY, [readyProbe('Air', { onBattery: true, batteryPercent: 12 })])).toBeNull();
    expect(buildSwarmHostQuestion(LOCAL_BUSY, [{ ok: false, candidate: candidate('Air'), reason: 'unreachable', detail: 'x' }])).toBeNull();
    expect(buildSwarmHostQuestion(LOCAL_BUSY, [{ ...readyProbe('Air'), missingTools: ['ntm'] }])).toBeNull();
  });

  it('matches answers with or without the recommendation suffix', () => {
    const probes = [readyProbe('Air')];
    expect(matchHostPick('Air (Recommended)', probes)).toBe(probes[0]);
    expect(matchHostPick('air.local', probes)).toBe(probes[0]);
    expect(matchHostPick('This Mac (Recommended)', probes)).toBe('this_mac');
    expect(matchHostPick('Studio', probes)).toBeNull();
  });
});

describe('remote commands', () => {
  it('quotes every argument for the worker shell', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(remoteScript('/Users/kev/My Repo', 'exec git status')).toMatch(/&& cd '\/Users\/kev\/My Repo' && exec git status$/);
    expect(remoteScript(null, 'true')).not.toContain(' cd ');
  });

  it('falls back to the recorded address when the hostname stops resolving', async () => {
    const lost = async () => { throw new Error('ENOTFOUND'); };
    expect(await resolveRoute(AIR, lost)).toEqual({ address: '10.9.8.7', alias: 'air.invalid', resolved: null });
    expect(await resolveRoute({ ...AIR, address: null }, lost)).toEqual({ address: 'air.invalid', alias: null, resolved: null });
    expect(await resolveRoute(AIR, async () => '10.0.0.5')).toEqual({ address: '10.0.0.5', alias: 'air.invalid', resolved: '10.0.0.5' });
  });

  it('runs in the clone over a reused connection checked against the hostname key', async () => {
    const { exec, calls } = scriptedExec([[/^ssh /, ok('main\n')]]);
    const remote = makeSshExec(exec, AIR, AIR.repoPath);
    await remote('git', ['log', '--format=%H %s'], { timeout: 1_000, cwd: '/ignored' });
    const argv = calls[0]!.args;
    expect(argv).toEqual(expect.arrayContaining(['HostKeyAlias=air.invalid', 'ControlMaster=auto', 'BatchMode=yes', '-i', '/keys/id_ed25519', 'kev@10.9.8.7']));
    expect(argv.at(-1)).toContain(`cd '/Users/kev/GitHub/demo-offload' && 'exec' 'git' 'log' '--format=%H %s'`);
  });

  it('retries a dropped connection but not a refused login', async () => {
    let attempts = 0;
    const { exec } = scriptedExec([[/^ssh /, () => (++attempts === 1 ? failed(255, 'Connection reset by peer') : ok('done'))]]);
    expect(await makeSshExec(exec, AIR, null)('true', [])).toEqual(ok('done'));
    expect(attempts).toBe(2);

    let denied = 0;
    const refusing = scriptedExec([[/^ssh /, () => { denied++; return failed(255, 'Permission denied (publickey).'); }]]);
    expect((await makeSshExec(refusing.exec, AIR, null)('true', [])).code).toBe(255);
    expect(denied).toBe(1);
  }, 15_000);
});

describe('run arguments', () => {
  it('parses the checkout, subdirectory, timeout, and command', () => {
    expect(parseRunArgs(['run', '--checkout', '/repo', '--cd', './mcp-server', '--timeout', '60', '--', 'npm', 'test'], '/cwd'))
      .toEqual({ ok: true, run: { checkout: '/repo', subdir: 'mcp-server', timeoutMs: 60_000, command: ['npm', 'test'] } });
    expect(parseRunArgs(['run', '--', 'ls'], '/cwd')).toMatchObject({ ok: true, run: { checkout: '/cwd', subdir: null } });
  });

  it('rejects a missing command and a subdirectory outside the checkout', () => {
    expect(parseRunArgs(['run', '--'], '/cwd').ok).toBe(false);
    expect(parseRunArgs(['run', '--cd', '../other', '--', 'ls'], '/cwd').ok).toBe(false);
    expect(parseRunArgs(['run', '--cd', '/etc', '--', 'ls'], '/cwd').ok).toBe(false);
    expect(parseRunArgs(['exec', '--', 'ls'], '/cwd').ok).toBe(false);
  });
});

describe('wave-boundary sync', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'fw-swarm-host-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const withBeads = async () => {
    await mkdir(join(cwd, '.beads'), { recursive: true });
    await writeFile(join(cwd, '.beads', 'beads.db'), '');
  };

  it('stores the host record per checkout and ignores a corrupt one', async () => {
    expect(await readSwarmHost(cwd)).toBeNull();
    await writeSwarmHost(cwd, AIR);
    expect(await readSwarmHost(cwd)).toEqual(AIR);
    const lane = await resolveSwarmLane(cwd, scriptedExec([]).exec);
    expect(lane).toMatchObject({ projectKey: AIR.repoPath, probeScope: hostSlug(AIR.host), verifyClaudeLogin: true });
    await writeFile(join(cwd, SWARM_HOST_RELATIVE_PATH), '{"version":2}');
    expect(await readSwarmHost(cwd)).toBeNull();
    const local = scriptedExec([]).exec;
    expect(await resolveSwarmLane(cwd, local)).toEqual({ host: null, exec: local, projectKey: cwd, verifyClaudeLogin: false });
  });

  it('refuses to pull into a different branch than the swarm started from', async () => {
    const { exec } = scriptedExec([[/^git symbolic-ref/, ok('feature\n')]]);
    expect(await pullFromSwarmHost({ cwd, exec }, AIR)).toMatchObject({ ok: false, code: 'blocked_state', reason: 'branch_changed' });
  });

  it('skips beads and reports for a clone that has never been pushed to', async () => {
    await withBeads();
    const { exec, calls } = scriptedExec([
      [/^git symbolic-ref/, ok('main\n')],
      [/^git .*fetch/, failed(128, "fatal: couldn't find remote ref refs/heads/flywheel-offload")],
      [/^ssh .*\.beads\/beads\.db/, ok('')],
      [/^rsync /, failed(23, 'rsync: change_dir "/x/.pi-flywheel/completion" failed: No such file or directory (2)')],
      [/^git rev-parse HEAD/, ok('abc123\n')],
    ]);
    expect(await pullFromSwarmHost({ cwd, exec }, AIR)).toEqual({ ok: true, commits: 'up_to_date', head: 'abc123', beads: 'skipped', completionReports: 'none' });
    expect(calls.some((call) => call.cmd === 'scp')).toBe(false);
  });

  it('stops at a conflicting merge and names the files', async () => {
    const { exec, calls } = scriptedExec([
      [/^git symbolic-ref/, ok('main\n')],
      [/^git .*fetch/, ok()],
      [/^git merge-base/, failed(1, '')],
      [/^git merge-tree/, { code: 1, stdout: '4b825dc\nREADME.md\nsrc/a.ts\n\nAuto-merging README.md\nCONFLICT (content): Merge conflict in README.md\n', stderr: '' }],
    ]);
    expect(await pullFromSwarmHost({ cwd, exec }, AIR)).toMatchObject({
      ok: false,
      code: 'blocked_state',
      reason: 'merge_conflict',
      details: { conflicts: ['README.md', 'src/a.ts'] },
    });
    expect(calls.some((call) => call.cmd === 'git' && call.args[0] === 'merge' && call.args.includes('--no-ff'))).toBe(false);
  });

  it('merges diverged work and brings the beads back', async () => {
    await withBeads();
    const { exec, calls } = scriptedExec([
      [/^git symbolic-ref/, ok('main\n')],
      [/^git .*fetch/, ok()],
      [/^git merge-base/, failed(1, '')],
      [/^git merge-tree/, ok('4b825dc\n')],
      [/^git merge --no-ff/, ok()],
      [/^ssh .*\.beads\/beads\.db/, ok('mirrored\n')],
      [/^br sync/, ok()],
      [/^scp /, ok()],
      [/^rsync /, ok()],
      [/^git rev-parse HEAD/, ok('def456\n')],
    ]);
    expect(await pullFromSwarmHost({ cwd, exec }, AIR)).toEqual({ ok: true, commits: 'merged', head: 'def456', beads: 'merged', completionReports: 'copied' });
    const brCalls = calls.filter((call) => call.cmd === 'br').map((call) => call.args.join(' '));
    expect(brCalls).toEqual(['sync --flush-only', 'sync --merge --force']);
  });

  it('reports a failed copy as the command failing, not the Mac being unreachable', async () => {
    await withBeads();
    const { exec } = scriptedExec([
      [/^git symbolic-ref/, ok('main\n')],
      [/^git .*fetch/, ok()],
      [/^git merge-base --is-ancestor refs/, ok()],
      [/^ssh .*\.beads\/beads\.db/, ok('mirrored\n')],
      [/^br sync/, ok()],
      [/^scp /, failed(1, 'scp: /x/.beads/issues.jsonl: No such file or directory')],
    ]);
    expect(await pullFromSwarmHost({ cwd, exec }, AIR)).toMatchObject({ ok: false, code: 'cli_failure', reason: 'remote_command_failed' });
  });

  it('refuses to push over uncommitted pane edits, ignoring the bead export', async () => {
    const { exec, calls } = scriptedExec([
      [/^git symbolic-ref/, ok('main\n')],
      [/^ssh .*git status --porcelain/, ok(' M src/a.ts\n')],
    ]);
    expect(await pushToSwarmHost({ cwd, exec }, AIR)).toMatchObject({ ok: false, code: 'blocked_state', reason: 'worker_dirty', details: { files: [' M src/a.ts'.trim()] } });
    expect(calls.find((call) => call.cmd === 'ssh')!.args.at(-1)).toContain(`':(exclude).beads'`);
  });

  it('tells a refused push apart from one that needs a pull first', async () => {
    const push = (stderr: string) => scriptedExec([
      [/^git symbolic-ref/, ok('main\n')],
      [/^ssh .*git status --porcelain/, ok('')],
      [/^git .*push/, failed(1, stderr)],
    ]).exec;
    expect(await pushToSwarmHost({ cwd, exec: push(' ! [remote rejected] HEAD -> flywheel-offload (Working directory has unstaged changes)\n') }, AIR))
      .toMatchObject({ ok: false, reason: 'worker_refused', message: expect.stringContaining('Working directory has unstaged changes') });
    expect(await pushToSwarmHost({ cwd, exec: push(' ! [rejected]        HEAD -> flywheel-offload (fetch first)\n') }, AIR))
      .toMatchObject({ ok: false, reason: 'push_rejected' });
    expect(await pushToSwarmHost({ cwd, exec: push('ssh: connect to host 10.9.8.7 port 22: Operation timed out\nfatal: Could not read from remote repository.') }, AIR))
      .toMatchObject({ ok: false, code: 'missing_prerequisite', reason: 'host_unreachable' });
  });

  it('mirrors the bead workspace on the first push and merges after that', async () => {
    await withBeads();
    for (const file of ['config.yaml', 'metadata.json', 'issues.jsonl']) await writeFile(join(cwd, '.beads', file), '');
    const run = async (present: boolean) => scriptedExec([
      [/^git symbolic-ref/, ok('main\n')],
      [/^ssh .*git status --porcelain/, ok('')],
      [/^git .*push/, ok()],
      [/^ssh .*git checkout/, ok()],
      [/^ssh .*test -f/, ok(present ? 'present\n' : '')],
      [/^ssh .*br.*sync/, ok()],
      [/^br sync/, ok()],
      [/^scp /, ok()],
      [/^git rev-parse HEAD/, ok('abc123\n')],
    ]);
    const first = await run(false);
    expect(await pushToSwarmHost({ cwd, exec: first.exec }, AIR)).toEqual({ ok: true, head: 'abc123', beads: 'mirrored' });
    expect(first.calls.find((call) => call.cmd === 'scp')!.args.filter((arg) => arg.startsWith(cwd))).toEqual(
      ['config.yaml', 'metadata.json', 'issues.jsonl'].map((file) => join(cwd, '.beads', file)),
    );
    expect(first.calls.some((call) => call.cmd === 'ssh' && call.args.at(-1)!.includes(`'--import-only'`))).toBe(true);
    const later = await run(true);
    expect(await pushToSwarmHost({ cwd, exec: later.exec }, AIR)).toEqual({ ok: true, head: 'abc123', beads: 'merged' });
    expect(later.calls.some((call) => call.cmd === 'ssh' && call.args.at(-1)!.includes(`'--merge' '--force'`))).toBe(true);
  });

  it('reports a failed hand-off instead of throwing', async () => {
    const throwing: ExecFn = async () => { throw new Error('Timed out after 30000ms: git symbolic-ref'); };
    expect(await handOffWave({ cwd, exec: throwing }, AIR)).toMatchObject({ synced: false, detail: expect.stringContaining('flywheel_swarm_host') });
    const dirty = scriptedExec([[/^git symbolic-ref/, ok('main\n')], [/^ssh .*git status/, ok(' M a.ts\n')]]).exec;
    expect(await handOffWave({ cwd, exec: dirty }, AIR)).toMatchObject({ synced: false, name: AIR.name, ntmProject: 'demo-offload' });
  });

  it('points the tender daemon at the worker’s ntm and Agent Mail', async () => {
    await writeSwarmHost(cwd, AIR);
    const { exec, calls } = scriptedExec([[/^ssh /, ok('{}')]]);
    const fetchInboxFn = vi.fn(async () => []);
    const daemon = await startTenderDaemon(
      { session: 'demo-offload--impl', project: cwd, interval: 60_000, logfile: 'tender.log', agent: 'Coordinator', ntmTimeoutMs: 1_000 },
      { makeExecFn: () => exec, fetchInboxFn: fetchInboxFn as never },
    );
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    await daemon.stop('test');
    expect(fetchInboxFn).toHaveBeenCalledWith(expect.any(Function), AIR.repoPath, 'Coordinator', expect.anything());
    expect(calls.map((call) => call.args.at(-1)).join('\n')).toContain('ntm --robot-is-working');
    expect(await readFile(join(cwd, 'tender.log'), 'utf8')).toContain('daemon_stopped');
  });
});
