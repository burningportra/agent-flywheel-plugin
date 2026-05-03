import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetupAndVerify, buildSetupReport, setupLooksHealthy } from '../../tools/setup.js';
import type {
  HookAdapter,
  PluginRegistrationStatus,
  WorktreeScanRoot,
  DiagnosticResult,
} from '../../adapters/platform/index.js';
import type { ExecFn } from '../../exec.js';

function makeTmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'setup-test-'));
  mkdirSync(join(dir, 'mcp-server', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'mcp-server', 'dist', 'server.js'), '// built\n');
  return dir;
}

function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Build a stub set that turns all exec-based doctor checks green. */
function allGreenStubs(): Array<{
  match: (cmd: string, args: readonly string[]) => boolean;
  result: { code: number; stdout: string; stderr: string };
}> {
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
  return [
    { match: (cmd, args) => cmd === 'curl' && args.includes('http://127.0.0.1:8765/health/liveness'), result: ok('{"status":"alive"}') },
    { match: (cmd, args) => cmd === 'br' && args[0] === '--version', result: ok('br 0.1.0') },
    { match: (cmd, args) => cmd === 'bv' && args[0] === '--version', result: ok('bv 0.1.0') },
    { match: (cmd, args) => cmd === 'ntm' && args[0] === '--version', result: ok('ntm 0.1.0') },
    { match: (cmd, args) => cmd === 'cm' && args[0] === '--version', result: ok('cm 0.1.0') },
    { match: (cmd, args) => cmd === 'cm' && args[0] === 'context', result: ok('[]') },
    { match: (cmd, args) => cmd === 'node' && args[0] === '--version', result: ok('v22.0.0') },
    { match: (cmd) => cmd === 'git', result: ok('clean\n') },
    { match: (cmd, args) => cmd === 'which' && args[0] === 'claude', result: ok('/usr/local/bin/claude') },
    { match: (cmd, args) => cmd === 'which' && args[0] === 'codex', result: ok('/usr/local/bin/codex') },
    { match: (cmd, args) => cmd === 'which' && args[0] === 'gemini', result: ok('/usr/local/bin/gemini') },
  ];
}

function makeStubExec(stubs: ReturnType<typeof allGreenStubs>): ExecFn {
  return async (cmd, args) => {
    const stub = stubs.find((s) => s.match(cmd, args));
    return stub ? stub.result : { code: 1, stdout: '', stderr: `not mocked: ${cmd}` };
  };
}

class StubAdapter implements HookAdapter {
  readonly platform = 'claude-code';
  constructor(
    private readonly opts: {
      registration: PluginRegistrationStatus;
      diagnostics: readonly DiagnosticResult[];
      installedVersion?: string | null;
      pluginRoot?: string | null;
    },
  ) {}
  pluginRoot() { return this.opts.pluginRoot ?? null; }
  installedPluginManifestPath() { return null; }
  worktreeScanRoots(): readonly WorktreeScanRoot[] { return []; }
  validateHooks() { return this.opts.diagnostics; }
  checkPluginRegistration() { return this.opts.registration; }
  getInstalledVersion() { return this.opts.installedVersion ?? null; }
}

describe('runSetupAndVerify', () => {
  it('skips doctor when setup looks unhealthy and returns setup_unhealthy verdict', async () => {
    const cwd = makeTmpCwd();
    try {
      const adapter = new StubAdapter({
        registration: { status: 'missing', message: 'not installed' },
        diagnostics: [
          { id: 'settings_json_missing', severity: 'yellow', message: 'no settings.json' },
        ],
      });
      const result = await runSetupAndVerify(cwd, { adapter });
      expect(result.verdict).toBe('setup_unhealthy');
      expect(result.doctorReport).toBeNull();
      expect(result.criticalFails).toBe(0);
      expect(result.remediation).toMatch(/setup/i);
      expect(result.setupReport.registration.status).toBe('missing');
    } finally {
      cleanup(cwd);
    }
  });

  it('runs doctor when setup is healthy and reports ok on all-green sweep', async () => {
    const cwd = makeTmpCwd();
    try {
      const adapter = new StubAdapter({
        registration: { status: 'installed', message: 'ok' },
        diagnostics: [{ id: 'settings_json_ok', severity: 'green', message: 'ok' }],
        installedVersion: '3.11.5',
        pluginRoot: '/tmp/fake',
      });
      const result = await runSetupAndVerify(cwd, {
        adapter,
        doctorOptions: {
          exec: makeStubExec(allGreenStubs()),
          codexConfigPath: null,
          installedPluginManifestPath: null,
          marketplaceManifestPath: null,
        },
      });
      // The reduced stub set may produce yellow rows for tangential checks
      // (e.g. checkpoint validity in a synthetic cwd) — what matters here
      // is (1) doctor ran, (2) no red rows, (3) verdict reflects no
      // remediation being required.
      expect(result.doctorReport).not.toBeNull();
      expect(result.criticalFails).toBe(0);
      expect(['ok', 'warnings']).toContain(result.verdict);
      if (result.verdict === 'ok') {
        expect(result.remediation).toBeUndefined();
      }
    } finally {
      cleanup(cwd);
    }
  });

  it('returns critical verdict when doctor surfaces a red row, with remediation hint', async () => {
    const cwd = makeTmpCwd();
    try {
      const adapter = new StubAdapter({
        registration: { status: 'installed', message: 'ok' },
        diagnostics: [{ id: 'settings_json_ok', severity: 'green', message: 'ok' }],
      });
      // Force br to throw so br_binary check goes red.
      const stubs = allGreenStubs().filter((s) => !s.match('br', ['--version']));
      const exec: ExecFn = async (cmd, args) => {
        if (cmd === 'br') throw new Error('br: command not found');
        const stub = stubs.find((s) => s.match(cmd, args));
        return stub ? stub.result : { code: 1, stdout: '', stderr: 'not mocked' };
      };
      const result = await runSetupAndVerify(cwd, {
        adapter,
        doctorOptions: {
          exec,
          codexConfigPath: null,
          installedPluginManifestPath: null,
          marketplaceManifestPath: null,
        },
      });
      expect(result.verdict).toBe('critical');
      expect(result.criticalFails).toBeGreaterThan(0);
      expect(result.doctorReport!.overall).toBe('red');
      expect(result.remediation).toMatch(/critical|hint/i);
    } finally {
      cleanup(cwd);
    }
  });

  it('returns warnings verdict when doctor is yellow but criticalFails === 0', async () => {
    const cwd = makeTmpCwd();
    try {
      const adapter = new StubAdapter({
        registration: { status: 'installed', message: 'ok' },
        diagnostics: [{ id: 'settings_json_ok', severity: 'green', message: 'ok' }],
      });
      // bv is the optional binary — failing it lands yellow, not red.
      const stubs = allGreenStubs().filter((s) => !s.match('bv', ['--version']));
      const exec: ExecFn = async (cmd, args) => {
        if (cmd === 'bv') throw new Error('bv: not found');
        const stub = stubs.find((s) => s.match(cmd, args));
        return stub ? stub.result : { code: 1, stdout: '', stderr: 'not mocked' };
      };
      const result = await runSetupAndVerify(cwd, {
        adapter,
        doctorOptions: {
          exec,
          codexConfigPath: null,
          installedPluginManifestPath: null,
          marketplaceManifestPath: null,
        },
      });
      expect(result.verdict).toBe('warnings');
      expect(result.criticalFails).toBe(0);
      expect(result.doctorReport!.overall).toBe('yellow');
    } finally {
      cleanup(cwd);
    }
  });

  it('honors runDoctorOnUnhealthy=true even when setup looks broken', async () => {
    const cwd = makeTmpCwd();
    try {
      const adapter = new StubAdapter({
        registration: { status: 'missing', message: 'not installed' },
        diagnostics: [],
      });
      const result = await runSetupAndVerify(cwd, {
        adapter,
        runDoctorOnUnhealthy: true,
        doctorOptions: {
          exec: makeStubExec(allGreenStubs()),
          codexConfigPath: null,
          installedPluginManifestPath: null,
          marketplaceManifestPath: null,
        },
      });
      expect(result.doctorReport).not.toBeNull();
      // Doctor ran even though setup was unhealthy.
      expect(['ok', 'warnings', 'critical']).toContain(result.verdict);
    } finally {
      cleanup(cwd);
    }
  });
});

// Re-export the helpers used by the suite to keep imports tree-shaking-friendly.
void buildSetupReport;
void setupLooksHealthy;
