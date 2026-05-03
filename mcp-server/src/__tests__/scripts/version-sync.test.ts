import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Tests for `mcp-server/scripts/version-sync.mjs`. We invoke the script via
 * a child Node process against a synthetic repo fixture so we exercise argv
 * parsing, exit codes, and the actual file-write path end-to-end.
 */

const SCRIPT = resolve(__dirname, '..', '..', '..', 'scripts', 'version-sync.mjs');

interface FixtureManifests {
  local?: string;
  marketplace?: string;
  pluginManifest?: string;
}

function makeFixture(versions: FixtureManifests): { repo: string; configPath: string } {
  const repo = mkdtempSync(join(tmpdir(), 'version-sync-test-'));

  if (versions.local) {
    mkdirSync(join(repo, 'mcp-server'), { recursive: true });
    writeFileSync(
      join(repo, 'mcp-server', 'package.json'),
      JSON.stringify({ name: 'mcp', version: versions.local }, null, 2) + '\n',
    );
  }
  if (versions.marketplace || versions.pluginManifest) {
    mkdirSync(join(repo, '.claude-plugin'), { recursive: true });
    if (versions.pluginManifest) {
      writeFileSync(
        join(repo, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'agent-flywheel', version: versions.pluginManifest }, null, 2) + '\n',
      );
    }
    if (versions.marketplace) {
      writeFileSync(
        join(repo, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({ name: 'mp', version: versions.marketplace }, null, 2) + '\n',
      );
    }
  }

  // Synthetic config that mirrors the real one but rooted under our fixture.
  const configPath = join(repo, 'sync.config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        manifests: [
          { path: 'mcp-server/package.json', kind: 'json', isSource: true },
          { path: '.claude-plugin/plugin.json', kind: 'json' },
          { path: '.claude-plugin/marketplace.json', kind: 'json', optional: true },
        ],
      },
      null,
      2,
    ),
  );
  return { repo, configPath };
}

function cleanup(p: string) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Run the script against a fixture repo. The script's REPO_ROOT is its own
 * `../..`, so we override the source-of-truth manifest path indirectly by
 * passing a custom config that resolves paths relative to its own repo root.
 *
 * We accomplish this by chdir-ing the spawned process into the fixture
 * **and** symlinking the script there — too clever. Simpler: copy the
 * script into the fixture and run it with the fixture as REPO_ROOT.
 */
function runScript(repo: string, args: string[]): { code: number; stdout: string; stderr: string } {
  // The script computes REPO_ROOT = resolve(HERE, '..', '..'), where HERE is
  // its own directory. To make REPO_ROOT resolve back to the fixture root,
  // we drop the script at `<repo>/_pkg/scripts/version-sync.mjs`:
  //   HERE      = <repo>/_pkg/scripts
  //   REPO_ROOT = resolve(HERE, '..', '..') = <repo>
  const scriptHome = join(repo, '_pkg', 'scripts');
  mkdirSync(scriptHome, { recursive: true });
  const scriptCopy = join(scriptHome, 'version-sync.mjs');
  writeFileSync(scriptCopy, readFileSync(SCRIPT, 'utf8'), 'utf8');
  const result = spawnSync(process.execPath, [scriptCopy, ...args], {
    cwd: repo,
    encoding: 'utf8',
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe('version-sync.mjs', () => {
  let repo: string | null = null;
  let configPath: string | null = null;

  afterEach(() => {
    if (repo) cleanup(repo);
    repo = null;
    configPath = null;
  });

  it('--check exits 0 when all manifests aligned', () => {
    ({ repo, configPath } = makeFixture({
      local: '3.11.5',
      pluginManifest: '3.11.5',
    }));
    const { code, stderr } = runScript(repo, ['--check', '--config', configPath]);
    expect(code).toBe(0);
    expect(stderr).toBe('');
  });

  it('--check exits 1 + reports drift when manifests differ', () => {
    ({ repo, configPath } = makeFixture({
      local: '3.11.5',
      pluginManifest: '3.10.0',
    }));
    const { code, stderr } = runScript(repo, ['--check', '--config', configPath]);
    expect(code).toBe(1);
    expect(stderr).toContain('drift detected');
    expect(stderr).toContain('.claude-plugin/plugin.json');
    expect(stderr).toContain('3.10.0 → 3.11.5');
  });

  it('default mode rewrites every drifting manifest to source version', () => {
    ({ repo, configPath } = makeFixture({
      local: '3.12.0',
      pluginManifest: '3.10.0',
      marketplace: '3.10.0',
    }));
    const { code, stdout } = runScript(repo, ['--config', configPath]);
    expect(code).toBe(0);
    expect(stdout).toContain('aligned');
    const plugin = JSON.parse(readFileSync(join(repo!, '.claude-plugin/plugin.json'), 'utf8'));
    expect(plugin.version).toBe('3.12.0');
    const market = JSON.parse(readFileSync(join(repo!, '.claude-plugin/marketplace.json'), 'utf8'));
    expect(market.version).toBe('3.12.0');
  });

  it('--version overrides source-derived target', () => {
    ({ repo, configPath } = makeFixture({
      local: '3.11.5',
      pluginManifest: '3.11.5',
    }));
    const { code, stdout } = runScript(repo, ['--version', '4.0.0', '--config', configPath]);
    expect(code).toBe(0);
    expect(stdout).toContain('4.0.0');
    const local = JSON.parse(readFileSync(join(repo!, 'mcp-server/package.json'), 'utf8'));
    expect(local.version).toBe('4.0.0');
    const plugin = JSON.parse(readFileSync(join(repo!, '.claude-plugin/plugin.json'), 'utf8'));
    expect(plugin.version).toBe('4.0.0');
  });

  it('rejects an invalid semver target', () => {
    ({ repo, configPath } = makeFixture({ local: '3.11.5', pluginManifest: '3.11.5' }));
    const { code, stderr } = runScript(repo, ['--version', 'not-semver', '--config', configPath]);
    expect(code).toBe(2);
    expect(stderr).toContain('not a valid semver');
  });

  it('errors when no source manifest is configured', () => {
    repo = mkdtempSync(join(tmpdir(), 'version-sync-test-'));
    const cfg = join(repo, 'cfg.json');
    writeFileSync(cfg, JSON.stringify({ manifests: [] }));
    const { code, stderr } = runScript(repo, ['--check', '--config', cfg]);
    expect(code).toBe(2);
    expect(stderr).toContain('no manifest with `isSource');
  });

  it('preserves indent style when rewriting JSON files', () => {
    ({ repo, configPath } = makeFixture({ local: '3.11.5' }));
    // Overwrite plugin.json with 4-space indent and assert it's preserved.
    mkdirSync(join(repo, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(repo, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'agent-flywheel', version: '3.10.0' }, null, 4) + '\n',
    );
    runScript(repo, ['--config', configPath]);
    const raw = readFileSync(join(repo, '.claude-plugin/plugin.json'), 'utf8');
    expect(raw).toContain('    "name"');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('--help prints usage and exits 0', () => {
    repo = mkdtempSync(join(tmpdir(), 'version-sync-test-'));
    const cfg = join(repo, 'cfg.json');
    writeFileSync(
      cfg,
      JSON.stringify({ manifests: [{ path: 'mcp-server/package.json', isSource: true }] }),
    );
    const { code, stdout } = runScript(repo, ['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('--check');
  });
});
