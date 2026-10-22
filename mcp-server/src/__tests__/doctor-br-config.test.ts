import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BR_CONFIG_LATENCY_HINT, runDoctorChecks } from '../tools/doctor.js';
import { REMEDIATION_REGISTRY } from '../tools/remediate.js';
import {
  brConfigLatencyHandler,
  ensureLowLatencyBrConfig,
} from '../tools/remediations/br_config_latency.js';
import { createMockExec } from './helpers/mocks.js';

const dirs: string[] = [];

function tempRepo(config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'br-config-'));
  dirs.push(dir);
  if (config !== undefined) {
    mkdirSync(join(dir, '.beads'));
    writeFileSync(join(dir, '.beads', 'config.yaml'), config);
  }
  return dir;
}

async function brConfigRow(cwd: string) {
  const report = await runDoctorChecks(cwd, undefined, { exec: createMockExec() });
  return report.checks.find((c) => c.name === 'br_config_latency');
}

function ctx(cwd: string) {
  return { cwd, exec: createMockExec(), signal: new AbortController().signal };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('br_config_latency doctor check', () => {
  it('is green when .beads is absent', async () => {
    expect((await brConfigRow(tempRepo()))?.severity).toBe('green');
  });

  it('is green when both settings are present', async () => {
    const row = await brConfigRow(tempRepo('no_auto_flush: true\nmetrics:\n  disabled: true\n'));
    expect(row?.severity).toBe('green');
  });

  it('is yellow with the remediate hint when metrics.disabled is missing', async () => {
    const row = await brConfigRow(tempRepo('no_auto_flush: true\nmetrics:\n  disabled: false\n'));
    expect(row?.severity).toBe('yellow');
    expect(row?.message).toContain('metrics.disabled: true');
    expect(row?.message).not.toContain('no_auto_flush');
    expect(row?.hint).toBe(BR_CONFIG_LATENCY_HINT);
    expect(row?.hint).toContain('flywheel_remediate');
  });

  it('is yellow when no_auto_flush is missing', async () => {
    const row = await brConfigRow(tempRepo('metrics:\n  disabled: true\n'));
    expect(row?.severity).toBe('yellow');
    expect(row?.message).toContain('no_auto_flush: true');
  });

  it('is yellow when .beads exists without config.yaml', async () => {
    const dir = tempRepo();
    mkdirSync(join(dir, '.beads'));
    expect((await brConfigRow(dir))?.severity).toBe('yellow');
  });
});

describe('ensureLowLatencyBrConfig', () => {
  it('adds both settings and keeps comments and other keys', () => {
    const out = ensureLowLatencyBrConfig('# keep me\nissue_prefix: abc\nmetrics:\n  disabled: false\n');
    expect(out).toContain('# keep me');
    expect(out).toContain('issue_prefix: abc');
    expect(out).toContain('no_auto_flush: true');
    expect(out).toMatch(/metrics:\n\s+disabled: true/);
  });

  it('returns already-compliant input unchanged', () => {
    const raw = 'metrics:\n  disabled: true # why\nno_auto_flush: true\n';
    expect(ensureLowLatencyBrConfig(raw)).toBe(raw);
  });

  it('fills an empty file', () => {
    const out = ensureLowLatencyBrConfig('');
    expect(out).toContain('no_auto_flush: true');
    expect(out).toMatch(/metrics:\n\s+disabled: true/);
  });
});

describe('brConfigLatencyHandler', () => {
  it('is registered for br_config_latency', () => {
    expect(REMEDIATION_REGISTRY.br_config_latency).toBe(brConfigLatencyHandler);
  });

  it('backs up the old config, rewrites it, and turns the check green', async () => {
    const original = 'issue_prefix: abc\n';
    const dir = tempRepo(original);
    expect(await brConfigLatencyHandler.verifyProbe(ctx(dir))).toBe(false);

    const result = await brConfigLatencyHandler.execute(ctx(dir));

    expect(result.stepsRun).toBe(2);
    expect(readFileSync(join(dir, '.beads', 'config.yaml.bak'), 'utf8')).toBe(original);
    expect(await brConfigLatencyHandler.verifyProbe(ctx(dir))).toBe(true);
    expect((await brConfigRow(dir))?.severity).toBe('green');
  });

  it('creates config.yaml without a backup when it is missing', async () => {
    const dir = tempRepo();
    mkdirSync(join(dir, '.beads'));
    await brConfigLatencyHandler.execute(ctx(dir));
    expect(existsSync(join(dir, '.beads', 'config.yaml.bak'))).toBe(false);
    expect(await brConfigLatencyHandler.verifyProbe(ctx(dir))).toBe(true);
  });

  it('leaves a compliant config alone', async () => {
    const dir = tempRepo('no_auto_flush: true\nmetrics:\n  disabled: true\n');
    expect((await brConfigLatencyHandler.execute(ctx(dir))).stepsRun).toBe(0);
    expect(existsSync(join(dir, '.beads', 'config.yaml.bak'))).toBe(false);
  });
});
