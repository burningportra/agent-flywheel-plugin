import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { runDoctorChecks } from '../../tools/doctor.js';
import type { ExecFn } from '../../exec.js';

describe('doctor NTM readiness', () => {
  let scratch: string;
  let cwd: string;
  let projectsBase: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'doctor-ntm-'));
    cwd = join(scratch, 'project');
    projectsBase = join(scratch, 'projects');
    mkdirSync(cwd);
    mkdirSync(projectsBase);
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function ntmExec(configOutput: string): ExecFn {
    return async (cmd, args) => {
      if (cmd === 'ntm' && args[0] === '--version') {
        return { code: 0, stdout: 'ntm 1.0.0', stderr: '' };
      }
      if (cmd === 'ntm' && args[0] === 'config') {
        return { code: 0, stdout: configOutput, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'not mocked' };
    };
  }

  it('returns machine-readable unavailable state when the project link is missing', async () => {
    const report = await runDoctorChecks(cwd, undefined, {
      exec: ntmExec(`projects_base = "${projectsBase}"\n`),
      codexConfigPath: null,
      probeCachePath: null,
    });

    expect(report.ntm).toMatchObject({
      NTM_AVAILABLE: false,
      NTM_PROJECT: basename(cwd),
      reason: 'missing',
      target: join(projectsBase, basename(cwd)),
    });
  });

  it('returns ready only when the configured target resolves to the project', async () => {
    symlinkSync(cwd, join(projectsBase, basename(cwd)));

    const report = await runDoctorChecks(cwd, undefined, {
      exec: ntmExec(`projects_base = "${projectsBase}"\n`),
      codexConfigPath: null,
      probeCachePath: null,
    });

    expect(report.ntm).toEqual({
      NTM_AVAILABLE: true,
      NTM_PROJECT: basename(cwd),
      reason: 'ready',
      target: join(projectsBase, basename(cwd)),
      resolvedTarget: realpathSync(cwd),
    });
  });

  it('returns collision and a yellow row for another repository', async () => {
    const other = join(scratch, 'other');
    mkdirSync(other);
    symlinkSync(other, join(projectsBase, basename(cwd)));

    const report = await runDoctorChecks(cwd, undefined, {
      exec: ntmExec(`projects_base = "${projectsBase}"\n`),
      codexConfigPath: null,
      probeCachePath: null,
    });
    const row = report.checks.find(
      (check) => check.name === 'projects_base_misconfig',
    );

    expect(report.ntm).toMatchObject({
      NTM_AVAILABLE: false,
      NTM_PROJECT: basename(cwd),
      reason: 'collision',
      resolvedTarget: realpathSync(other),
    });
    expect(row).toMatchObject({ severity: 'yellow' });
    expect(row?.message).toContain('name collision');
  });

  it('treats missing projects_base configuration as unavailable', async () => {
    const report = await runDoctorChecks(cwd, undefined, {
      exec: ntmExec('theme = "dark"\n'),
      codexConfigPath: null,
      probeCachePath: null,
    });

    expect(report.ntm).toEqual({
      NTM_AVAILABLE: false,
      NTM_PROJECT: basename(cwd),
      reason: 'config_unavailable',
    });
  });
});
