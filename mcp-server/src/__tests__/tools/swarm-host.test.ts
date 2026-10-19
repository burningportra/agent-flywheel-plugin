import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecFn } from '../../exec.js';
import { SWARM_HOST_RELATIVE_PATH, writeSwarmHost, type SwarmHost } from '../../swarm-host.js';
import { runCommandFor, runSwarmHost } from '../../tools/swarm-host.js';
import { createInitialState, type ToolContext } from '../../types.js';

const AIR: SwarmHost = {
  version: 1,
  name: 'Air',
  host: 'air.invalid',
  address: '10.9.8.7',
  user: 'kev',
  identityFile: null,
  repoPath: '/Users/kev/GitHub/demo-offload',
  ntmProject: 'demo-offload',
  localBranch: 'main',
  keepAwakePid: 4242,
  preparedAt: '2026-10-19T00:00:00.000Z',
};

let cwd: string;
let configHome: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'fw-swarm-host-tool-'));
  configHome = await mkdtemp(join(tmpdir(), 'fw-swarm-host-config-'));
  vi.stubEnv('XDG_CONFIG_HOME', configHome);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
  await rm(configHome, { recursive: true, force: true });
});

function makeCtx(exec: ExecFn): ToolContext {
  return { exec, cwd, state: createInitialState(), saveState: () => {}, clearState: () => {} } as ToolContext;
}

const nothingAnswers: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'not available' });
const data = (result: Awaited<ReturnType<typeof runSwarmHost>>) => (result.structuredContent as any).data;

describe('flywheel_swarm_host', () => {
  it('runs the swarm here without asking when no other Mac answers', async () => {
    const result = await runSwarmHost(makeCtx(nothingAnswers), { action: 'list' });
    expect(result.isError).toBeUndefined();
    expect(data(result)).toMatchObject({ kind: 'swarm_hosts_listed', question: null, hosts: [], current: null });
    expect(result.content[0]!.text).toContain('runs here');
  });

  it('lists a remembered host that refuses the key, with the fix', async () => {
    await mkdir(join(configHome, 'agent-flywheel'), { recursive: true });
    await writeFile(join(configHome, 'agent-flywheel', 'swarm-hosts.json'), JSON.stringify({
      version: 1,
      hosts: [{ name: 'Air', host: 'air.invalid', address: '10.9.8.7', user: 'kev', identityFile: null }],
    }));
    const exec: ExecFn = async (cmd) => cmd === 'ssh'
      ? { code: 255, stdout: '', stderr: 'kev@10.9.8.7: Permission denied (publickey).' }
      : { code: 1, stdout: '', stderr: '' };
    const listed = data(await runSwarmHost(makeCtx(exec), { action: 'list' }));
    expect(listed.question).toBeNull();
    expect(listed.hosts).toEqual([{ name: 'Air', host: 'air.invalid', reachable: false, blockers: [expect.stringContaining('authorized_keys')] }]);
  });

  it('needs a pick to choose, and a host to sync', async () => {
    const noPick = await runSwarmHost(makeCtx(nothingAnswers), { action: 'choose' });
    expect(data(noPick).error.code).toBe('invalid_input');
    const noHost = await runSwarmHost(makeCtx(nothingAnswers), { action: 'sync' });
    expect(data(noHost).error).toMatchObject({ code: 'missing_prerequisite', details: { reason: 'no_swarm_host' } });
    const badAction = await runSwarmHost(makeCtx(nothingAnswers), { action: 'teleport' });
    expect(data(badAction).error.code).toBe('invalid_input');
  });

  it('rejects a pick that matches no Mac and keeps "This Mac" a no-op', async () => {
    const unknown = await runSwarmHost(makeCtx(nothingAnswers), { action: 'choose', pick: 'Studio' });
    expect(data(unknown).error).toMatchObject({ code: 'invalid_input', details: { reason: 'unknown_host' } });
    const here = await runSwarmHost(makeCtx(nothingAnswers), { action: 'choose', pick: 'This Mac (Recommended)' });
    expect(data(here)).toMatchObject({ kind: 'swarm_host_chosen', host: null });
  });

  it('keeps the host when its last pull fails, and forgets it after a clean release', async () => {
    await writeSwarmHost(cwd, AIR);
    const offBranch: ExecFn = async (cmd, args) => (cmd === 'git' && args[0] === 'symbolic-ref'
      ? { code: 0, stdout: 'feature\n', stderr: '' }
      : { code: 1, stdout: '', stderr: '' });
    const refused = await runSwarmHost(makeCtx(offBranch), { action: 'release' });
    expect(data(refused).error).toMatchObject({ code: 'blocked_state', details: { reason: 'branch_changed' } });
    expect(JSON.parse(await readFile(join(cwd, SWARM_HOST_RELATIVE_PATH), 'utf8')).host).toBe('air.invalid');

    const scripts: string[] = [];
    const clean: ExecFn = async (cmd, args) => {
      if (cmd === 'ssh') scripts.push(args.at(-1)!);
      if (cmd === 'git' && args[0] === 'symbolic-ref') return { code: 0, stdout: 'main\n', stderr: '' };
      if (cmd === 'git' && args.includes('fetch')) return { code: 128, stdout: '', stderr: "fatal: couldn't find remote ref" };
      if (cmd === 'rsync') return { code: 23, stdout: '', stderr: 'No such file or directory' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const released = await runSwarmHost(makeCtx(clean), { action: 'release' });
    expect(data(released)).toMatchObject({ kind: 'swarm_host_released', released: { host: 'air.invalid' } });
    expect(scripts.some((script) => script.includes('kill 4242') && script.includes('grep -q caffeinate'))).toBe(true);
    await expect(readFile(join(cwd, SWARM_HOST_RELATIVE_PATH), 'utf8')).rejects.toThrow();
  });

  it('gives a run prefix bound to this checkout', () => {
    expect(runCommandFor('/repo/x')).toMatch(/^node ".*scripts\/swarm-host\.js" run --checkout "\/repo\/x" --$/);
  });
});
