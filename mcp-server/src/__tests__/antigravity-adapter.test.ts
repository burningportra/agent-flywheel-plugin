import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecFn } from '../exec.js';
import {
  AntigravityAdapter,
  buildAgyNtmArgs,
  detectAgyCli,
  probeAgyModels,
  probeNtmAgySupport,
  resolveAgySlug,
} from '../adapters/antigravity.js';
import { computeDispatchRatio } from '../model-detection.js';
import { runEmitAgy } from '../tools/emit-agy.js';
import { runDoctorChecks } from '../tools/doctor.js';
import { runRemediate } from '../tools/remediate.js';
import { makeState } from './helpers/mocks.js';

type Result = { code: number; stdout: string; stderr: string };
interface Call {
  cmd: string;
  args: string[];
  opts?: { timeout?: number; cwd?: string; signal?: AbortSignal };
}

function recordingExec(respond: (cmd: string, args: string[]) => Result | Error) {
  const calls: Call[] = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const out = respond(cmd, args);
    if (out instanceof Error) throw out;
    return out;
  };
  return { exec, calls };
}

const ok = (stdout: string): Result => ({ code: 0, stdout, stderr: '' });
const fail = (code = 1, stderr = 'nope'): Result => ({ code, stdout: '', stderr });

function syncReport(mode: string, target: string, summary: Partial<Record<'ok' | 'add' | 'update' | 'local' | 'prune', number>> = {}) {
  const full = { ok: 10, add: 0, update: 0, local: 0, prune: 0, ...summary };
  return JSON.stringify({ mode, target, summary: { ...full, total: full.ok + full.add + full.update + full.local } });
}

let root: string;
let pluginRoot: string;
let portParent: string;
let portTarget: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-adapter-')));
  pluginRoot = join(root, 'plugin');
  portParent = join(root, 'agy-plugins');
  portTarget = join(portParent, 'agent-flywheel');
  mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
  mkdirSync(join(pluginRoot, 'agy'), { recursive: true });
  mkdirSync(portParent, { recursive: true });
  writeFileSync(join(pluginRoot, 'scripts', 'sync-agy.sh'), '#!/usr/bin/env bash\n');
  writeFileSync(join(pluginRoot, 'agy', 'manifest.json'), JSON.stringify({ target: portTarget }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('AntigravityAdapter', () => {
  it('exports the four lane helpers', () => {
    expect(AntigravityAdapter.detectAgyCli).toBe(detectAgyCli);
    expect(AntigravityAdapter.probeAgyModels).toBe(probeAgyModels);
    expect(AntigravityAdapter.resolveAgySlug).toBe(resolveAgySlug);
    expect(AntigravityAdapter.buildAgyNtmArgs).toBe(buildAgyNtmArgs);
  });

  describe('detectAgyCli', () => {
    it('reports the version and passes timeout and signal to exec', async () => {
      const signal = new AbortController().signal;
      const { exec, calls } = recordingExec(() => ok('1.4.4\n'));
      expect(await detectAgyCli(exec, signal)).toEqual({ available: true, installed: true, version: '1.4.4' });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ cmd: 'agy', args: ['--version'] });
      expect(calls[0]!.opts?.timeout).toBeGreaterThan(0);
      expect(calls[0]!.opts?.signal).toBe(signal);
    });

    it('marks agy on PATH with a failing --version as installed but unavailable', async () => {
      const signal = new AbortController().signal;
      const { exec, calls } = recordingExec((cmd) => (cmd === 'which' ? ok('/opt/bin/agy\n') : fail(1, 'crashed')));
      expect(await detectAgyCli(exec, signal)).toEqual({ available: false, installed: true, path: '/opt/bin/agy', reason: 'crashed' });
      for (const call of calls) {
        expect(call.opts?.timeout).toBeGreaterThan(0);
        expect(call.opts?.signal).toBe(signal);
      }
    });

    it('reports agy missing when exec throws', async () => {
      const { exec } = recordingExec(() => new Error('ENOENT'));
      expect(await detectAgyCli(exec)).toMatchObject({ available: false, installed: false });
    });
  });

  describe('probeAgyModels', () => {
    it('parses slug and display name rows after the banner', async () => {
      const signal = new AbortController().signal;
      const { exec, calls } = recordingExec(() =>
        ok('Fetching available models...\ngemini-4-argon-high\tGemini 4 Argon (High)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\n'),
      );
      expect(await probeAgyModels(exec, signal)).toEqual({
        ok: true,
        models: [
          { slug: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
          { slug: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
        ],
      });
      expect(calls[0]!.opts).toMatchObject({ signal });
      expect(calls[0]!.opts?.timeout).toBeGreaterThan(0);
    });

    it.each([
      [fail(1, 'not logged in'), 'not logged in'],
      [ok('Fetching available models...\n'), 'agy models listed no models'],
    ])('fails on %j', async (result, reason) => {
      const { exec } = recordingExec(() => result);
      expect(await probeAgyModels(exec)).toEqual({ ok: false, reason });
    });
  });

  it.each([
    [undefined, undefined, 'gemini-4-argon-high'],
    ['gemini-4-argon', 'high', 'gemini-4-argon-high'],
    ['gemini-4-argon', 'low', 'gemini-4-argon-low'],
    ['gemini-4-argon-medium', 'high', 'gemini-4-argon-medium'],
    ['claude-opus-5-5', undefined, 'claude-opus-5-5-high'],
  ] as const)('resolveAgySlug(%s, %s) is %s', (model, effort, slug) => {
    expect(resolveAgySlug(model, effort)).toBe(slug);
  });

  describe('buildAgyNtmArgs', () => {
    it.each([
      [[0], []],
      [[2], ['--agy=2']],
      [[1, 'gemini-4-argon', 'high'], ['--agy=1:gemini-4-argon-high']],
      [[3, undefined, 'low'], ['--agy=3:gemini-4-argon-low']],
      [[1, 'gemini-3.8-flash-medium'], ['--agy=1:gemini-3.8-flash-medium']],
    ] as const)('%j → %j', (input, expected) => {
      expect(buildAgyNtmArgs(...(input as unknown as Parameters<typeof buildAgyNtmArgs>))).toEqual(expected);
    });

    it.each([
      [-1],
      [1.5],
      [1, 'Gemini 4 Argon (High)'],
      [1, 'gemini 4 argon'],
      [1, 'gemini-4-argon', 'turbo'],
    ])('rejects %j', (...input) => {
      expect(() => buildAgyNtmArgs(...(input as Parameters<typeof buildAgyNtmArgs>))).toThrow();
    });
  });

  it('probeNtmAgySupport reads --agy from ntm spawn --help', async () => {
    const yes = recordingExec(() => ok('      --agy N[:model[:effort]]   Antigravity agents'));
    const no = recordingExec(() => ok('      --cc N   Claude agents'));
    expect(await probeNtmAgySupport(yes.exec)).toBe(true);
    expect(await probeNtmAgySupport(no.exec)).toBe(false);
    expect(yes.calls[0]).toMatchObject({ cmd: 'ntm', args: ['spawn', '--help'] });
    expect(yes.calls[0]!.opts?.timeout).toBeGreaterThan(0);
  });
});

describe('computeDispatchRatio', () => {
  it('keeps the Gemini seat on gmi unless agy and ntm --agy are both ready', () => {
    for (const route of [
      { agyReady: false, ntmAgy: false },
      { agyReady: true, ntmAgy: false },
      { agyReady: false, ntmAgy: true },
    ]) {
      expect(computeDispatchRatio('2:2:2', route)).toEqual({
        ratio: { claude: 2, pi: 2, gemini: 2 },
        ratioByLane: { cc: 2, pi: 2, gmi: 2, agy: 0 },
      });
    }
  });

  it('routes the Gemini seat through agy when both are ready', () => {
    expect(computeDispatchRatio('3:2:2', { agyReady: true, ntmAgy: true })).toEqual({
      ratio: { claude: 3, pi: 2, gemini: 2 },
      ratioByLane: { cc: 3, pi: 2, gmi: 0, agy: 2 },
    });
  });

  it('reads a malformed ratio as zeros', () => {
    expect(computeDispatchRatio('x:-1', { agyReady: true, ntmAgy: true }).ratio).toEqual({ claude: 0, pi: 0, gemini: 0 });
  });
});

describe('flywheel_emit_agy', () => {
  function ctx(exec: ExecFn, signal?: AbortSignal) {
    return { exec, cwd: pluginRoot, state: makeState(), saveState: vi.fn(), clearState: vi.fn(), signal };
  }
  const error = (result: Awaited<ReturnType<typeof runEmitAgy>>) =>
    (result.structuredContent as { data: { error: { code: string } } }).data.error.code;

  it('runs sync-agy.sh with the mode, --json, --target, a timeout, and the signal', async () => {
    const signal = new AbortController().signal;
    const { exec, calls } = recordingExec(() => ok(syncReport('write', portTarget, { add: 0 })));
    const result = await runEmitAgy(ctx(exec, signal), { cwd: pluginRoot, targetDir: portTarget, mode: 'write' });

    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cmd: 'bash',
      args: [join(pluginRoot, 'scripts', 'sync-agy.sh'), '--write', '--json', '--target', portTarget],
    });
    expect(calls[0]!.opts?.timeout).toBeGreaterThan(0);
    expect(calls[0]!.opts?.signal).toBe(signal);
    expect((result.structuredContent as { data: Record<string, unknown> }).data).toMatchObject({
      kind: 'emit_agy_report',
      mode: 'write',
      target: portTarget,
      clean: true,
    });
  });

  it('defaults to check and reports drift without failing', async () => {
    const { exec, calls } = recordingExec(() => ({ code: 1, stdout: syncReport('check', portTarget, { add: 3 }), stderr: '' }));
    const result = await runEmitAgy(ctx(exec), { cwd: pluginRoot, targetDir: portTarget });
    expect(calls[0]!.args).toContain('--check');
    expect((result.structuredContent as { data: Record<string, unknown> }).data).toMatchObject({ clean: false, exitCode: 1 });
  });

  it('accepts a target inside cwd', async () => {
    const { exec, calls } = recordingExec(() => ok(syncReport('check', '')));
    await runEmitAgy(ctx(exec), { cwd: pluginRoot, targetDir: 'out/agy' });
    expect(calls[0]!.args.at(-1)).toBe(join(pluginRoot, 'out', 'agy'));
  });

  it.each([
    ['an outside absolute path', () => join(root, 'elsewhere')],
    ['a .. escape', () => '../agy-plugins/../elsewhere'],
    ['the plugins directory itself', () => portParent],
    ['cwd itself', () => '.'],
  ])('rejects %s', async (_label, target) => {
    const { exec, calls } = recordingExec(() => ok('{}'));
    const result = await runEmitAgy(ctx(exec), { cwd: pluginRoot, targetDir: target() });
    expect(error(result)).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('rejects a symlink inside cwd that points outside', async () => {
    mkdirSync(join(root, 'outside'));
    symlinkSync(join(root, 'outside'), join(pluginRoot, 'link'));
    const { exec, calls } = recordingExec(() => ok('{}'));
    const result = await runEmitAgy(ctx(exec), { cwd: pluginRoot, targetDir: 'link/agy' });
    expect(error(result)).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('rejects an unknown mode and a pluginRoot outside cwd', async () => {
    const { exec } = recordingExec(() => ok('{}'));
    expect(error(await runEmitAgy(ctx(exec), { cwd: pluginRoot, targetDir: portTarget, mode: 'nuke' as never }))).toBe('invalid_input');
    expect(error(await runEmitAgy(ctx(exec), { cwd: pluginRoot, targetDir: portTarget, pluginRoot: root }))).toBe('invalid_input');
  });

  it('returns cli_failure when sync-agy.sh fails to run', async () => {
    const { exec } = recordingExec(() => fail(2, 'sync-agy: Node 20+ is required'));
    const result = await runEmitAgy(ctx(exec), { cwd: pluginRoot, targetDir: portTarget });
    expect(error(result)).toBe('cli_failure');
    expect(result.content[0]!.text).toContain('Node 20+ is required');
  });
});

describe('doctor agy and pstack checks', () => {
  async function rows(respond: (cmd: string, args: string[]) => Result, options: Parameters<typeof runDoctorChecks>[2] = {}) {
    const { exec, calls } = recordingExec(respond);
    const report = await runDoctorChecks(pluginRoot, undefined, {
      exec,
      codexConfigPath: null,
      marketplaceManifestPath: null,
      installedPluginManifestPath: null,
      agyPortTarget: portTarget,
      ...options,
    });
    const byName = Object.fromEntries(report.checks.map((check) => [check.name, check]));
    return { byName, calls };
  }
  const agyOk = (extra: (cmd: string, args: string[]) => Result | undefined) => (cmd: string, args: string[]) =>
    (cmd === 'agy' && args[0] === '--version' ? ok('1.4.4\n') : extra(cmd, args)) ?? fail();

  it('agy_cli is green without agy and yellow when agy is broken', async () => {
    expect((await rows(() => fail())).byName['agy_cli']).toMatchObject({ severity: 'green', message: expect.stringContaining('not installed') });
    const broken = await rows((cmd) => (cmd === 'which' ? ok('/opt/bin/agy') : fail(1, 'segfault')));
    expect(broken.byName['agy_cli']).toMatchObject({ severity: 'yellow', message: expect.stringContaining('/opt/bin/agy') });
    expect((await rows(agyOk(() => undefined))).byName['agy_cli']).toMatchObject({ severity: 'green', message: 'agy 1.4.4' });
  });

  it('agy_port_sync skips without agy, and is yellow when the port is missing', async () => {
    expect((await rows(() => fail())).byName['agy_port_sync']).toMatchObject({ severity: 'green', message: expect.stringContaining('skipped') });
    expect((await rows(agyOk(() => undefined))).byName['agy_port_sync']).toMatchObject({
      severity: 'yellow',
      message: expect.stringContaining('not installed'),
      hint: expect.stringContaining('agy_port_sync'),
    });
  });

  it('agy_port_sync runs sync-agy.sh --check against the port', async () => {
    mkdirSync(portTarget);
    const clean = await rows(agyOk((cmd) => (cmd === 'bash' ? ok(syncReport('check', portTarget)) : undefined)));
    expect(clean.byName['agy_port_sync']).toMatchObject({ severity: 'green', message: expect.stringContaining('in sync') });
    const bash = clean.calls.find((call) => call.cmd === 'bash')!;
    expect(bash.args).toEqual([join(pluginRoot, 'scripts', 'sync-agy.sh'), '--check', '--json', '--target', portTarget]);
    expect(bash.opts?.timeout).toBeGreaterThan(0);
    expect(bash.opts?.signal).toBeInstanceOf(AbortSignal);

    const drift = await rows(agyOk((cmd) => (cmd === 'bash' ? { code: 1, stdout: syncReport('check', portTarget, { update: 2 }), stderr: '' } : undefined)));
    expect(drift.byName['agy_port_sync']).toMatchObject({ severity: 'yellow', message: expect.stringContaining('2 update') });

    const broken = await rows(agyOk((cmd) => (cmd === 'bash' ? fail(2, 'cannot resolve the repository root') : undefined)));
    expect(broken.byName['agy_port_sync']).toMatchObject({ severity: 'yellow', message: expect.stringContaining('repository root') });
  });

  it('pstack_plugin is green when vendored or installed and yellow otherwise', async () => {
    const vendor = join(root, 'PSTACK_VENDOR.json');
    writeFileSync(vendor, JSON.stringify({ upstreamVersion: '0.15.29', skills: ['poteto-mode', 'why'] }));
    expect((await rows(() => fail(), { pstackVendorPath: vendor, installedPluginsPath: null })).byName['pstack_plugin']).toMatchObject({
      severity: 'green',
      message: 'pstack 0.15.29 vendored (poteto-mode, why)',
    });

    const installed = join(root, 'installed_plugins.json');
    writeFileSync(installed, JSON.stringify({ version: 2, plugins: { 'pstack@pstack-claude': [{}] } }));
    expect((await rows(() => fail(), { pstackVendorPath: null, installedPluginsPath: installed })).byName['pstack_plugin']).toMatchObject({
      severity: 'green',
      message: 'pstack plugin installed (pstack@pstack-claude)',
    });

    writeFileSync(installed, JSON.stringify({ version: 2, plugins: { 'other@market': [{}] } }));
    expect((await rows(() => fail(), { pstackVendorPath: null, installedPluginsPath: installed })).byName['pstack_plugin']).toMatchObject({
      severity: 'yellow',
      hint: expect.stringContaining('pstack'),
    });
  });
});

describe('agy_port_sync remediation', () => {
  it('dry_run plans sync-agy.sh --write without running it', async () => {
    const { exec, calls } = recordingExec(() => ok('{}'));
    const result = await runRemediate(
      { cwd: pluginRoot, checkName: 'agy_port_sync', autoConfirm: false, mode: 'dry_run' },
      exec,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      executed: false,
      plan: { mutating: true, reversible: true, steps: [expect.stringContaining('--write --json --target')] },
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses execute without autoConfirm', async () => {
    const { exec, calls } = recordingExec(() => ok('{}'));
    const result = await runRemediate(
      { cwd: pluginRoot, checkName: 'agy_port_sync', autoConfirm: false, mode: 'execute' },
      exec,
      new AbortController().signal,
    );
    expect(JSON.stringify(result)).toContain('remediation_requires_confirm');
    expect(calls).toHaveLength(0);
  });

  it('writes the port, then verifies with --check', async () => {
    const signal = new AbortController().signal;
    const { exec, calls } = recordingExec((_cmd, args) => ok(syncReport(args[1]!.slice(2), portTarget, { ok: 12 })));
    const result = await runRemediate({ cwd: pluginRoot, checkName: 'agy_port_sync', autoConfirm: true, mode: 'execute' }, exec, signal);

    expect(result).toMatchObject({ executed: true, stepsRun: 1, verifiedGreen: true, stdout: expect.stringContaining('12/12 ok') });
    expect(calls.map((call) => call.args[1])).toEqual(['--write', '--check']);
    for (const call of calls) {
      expect(call.args.slice(2)).toEqual(['--json', '--target', portTarget]);
      expect(call.opts?.timeout).toBeGreaterThan(0);
      expect(call.opts?.signal).toBe(signal);
    }
  });

  it('reports remediation_failed when the write cannot run', async () => {
    const { exec } = recordingExec(() => fail(2, 'sync-agy: Node 20+ is required'));
    const result = await runRemediate(
      { cwd: pluginRoot, checkName: 'agy_port_sync', autoConfirm: true, mode: 'execute' },
      exec,
      new AbortController().signal,
    );
    expect(JSON.stringify(result)).toContain('remediation_failed');
  });
});
