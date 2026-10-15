/**
 * T6.1 — projects_base_misconfig remediation contract tests.
 *
 * Covers the pure helper `remediateProjectsBase` directly (dry-run / execute
 * / skip) plus the `projectsBaseMisconfigHandler` registry shape. Execute
 * mode uses a real tmp directory so the symlink syscall is exercised; no
 * mutation lands outside `os.tmpdir()`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import {
  remediateProjectsBase,
  projectsBaseMisconfigHandler,
} from '../../tools/remediations/projects_base_misconfig.js';
import type { HandlerCtx } from '../../tools/remediate.js';

describe('remediateProjectsBase (T6.1)', () => {
  let scratch: string;
  let cwdDir: string;
  let ntmBase: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'fw-t61-'));
    cwdDir = join(scratch, 'my-project');
    ntmBase = join(scratch, 'ntm-base');
    mkdirSync(cwdDir);
    mkdirSync(ntmBase);
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('dry-run returns the ln -s command without symlinking', async () => {
    const result = await remediateProjectsBase({
      cwd: cwdDir,
      ntmBase,
      mode: 'dry-run',
    });
    const expectedTarget = join(ntmBase, basename(cwdDir));
    expect(result.executed).toBe(false);
    expect(result.target).toBe(expectedTarget);
    expect(result.command).toBe(
      `ln -s "${realpathSync(cwdDir)}" "${expectedTarget}"`,
    );
    expect(existsSync(expectedTarget)).toBe(false);
  });

  it('skip mode behaves like dry-run (no mutation)', async () => {
    const result = await remediateProjectsBase({
      cwd: cwdDir,
      ntmBase,
      mode: 'skip',
    });
    expect(result.executed).toBe(false);
    expect(existsSync(result.target)).toBe(false);
  });

  it('execute mode creates the symlink and reports executed=true', async () => {
    const result = await remediateProjectsBase({
      cwd: cwdDir,
      ntmBase,
      mode: 'execute',
    });
    expect(result.executed).toBe(true);
    expect(existsSync(result.target)).toBe(true);
    expect(lstatSync(result.target).isSymbolicLink()).toBe(true);
  });

  it('execute mode is idempotent when target already exists', async () => {
    // First call creates it…
    await remediateProjectsBase({ cwd: cwdDir, ntmBase, mode: 'execute' });
    // …second call must not throw EEXIST.
    const second = await remediateProjectsBase({
      cwd: cwdDir,
      ntmBase,
      mode: 'execute',
    });
    expect(second.executed).toBe(true);
    expect(existsSync(second.target)).toBe(true);
  });

  it('handles ntmBase paths with and without a trailing slash', async () => {
    const slashed = `${ntmBase}/`;
    const result = await remediateProjectsBase({
      cwd: cwdDir,
      ntmBase: slashed,
      mode: 'dry-run',
    });
    expect(result.target).toBe(`${ntmBase}/${basename(cwdDir)}`);
  });

  it('refuses a target that points at another repository', async () => {
    const otherRepo = join(scratch, 'other-repo');
    const target = join(ntmBase, basename(cwdDir));
    mkdirSync(otherRepo);
    symlinkSync(otherRepo, target);

    await expect(
      remediateProjectsBase({ cwd: cwdDir, ntmBase, mode: 'execute' }),
    ).rejects.toThrow(/refus|collision/i);
    expect(realpathSync(target)).toBe(realpathSync(otherRepo));
  });
});

describe('projectsBaseMisconfigHandler (T6.1 registry shape)', () => {
  it('declares mutating + reversible flags on the handler', () => {
    expect(projectsBaseMisconfigHandler.mutating).toBe(true);
    expect(projectsBaseMisconfigHandler.reversible).toBe(true);
    expect(typeof projectsBaseMisconfigHandler.description).toBe('string');
    expect(typeof projectsBaseMisconfigHandler.buildPlan).toBe('function');
    expect(typeof projectsBaseMisconfigHandler.execute).toBe('function');
    expect(typeof projectsBaseMisconfigHandler.verifyProbe).toBe('function');
  });

  it('buildPlan returns an empty step list when ntm config show fails', async () => {
    const plan = await projectsBaseMisconfigHandler.buildPlan({
      cwd: '/nonexistent/proj',
      // Stub `exec` to behave like ntm-not-installed (non-zero exit).
      exec: async () => ({ code: 127, stdout: '', stderr: 'ntm: not found' }),
    } as unknown as Parameters<typeof projectsBaseMisconfigHandler.buildPlan>[0]);
    expect(plan.steps).toEqual([]);
    expect(plan.mutating).toBe(false);
  });

  it('reports and preserves a project-name collision', async () => {
    const localScratch = mkdtempSync(join(tmpdir(), 'fw-t61-collision-'));
    try {
      const project = join(localScratch, 'my-project');
      const base = join(localScratch, 'ntm-base');
      const otherRepo = join(localScratch, 'other-repo');
      const target = join(base, basename(project));
      mkdirSync(project);
      mkdirSync(base);
      mkdirSync(otherRepo);
      symlinkSync(otherRepo, target);
      const ctx: HandlerCtx = {
        cwd: project,
        signal: new AbortController().signal,
        exec: async (cmd, args) => cmd === 'ntm' && args[0] === 'config'
          ? {
              code: 0,
              stdout: `projects_base = "${base}"\n`,
              stderr: '',
            }
          : { code: 1, stdout: '', stderr: 'unexpected command' },
      };

      const plan = await projectsBaseMisconfigHandler.buildPlan(ctx);
      expect(plan.description).toMatch(/collision|refus/i);
      expect(plan.steps).toEqual([]);
      await expect(projectsBaseMisconfigHandler.execute(ctx)).rejects.toThrow(
        /refus|collision/i,
      );
      expect(await projectsBaseMisconfigHandler.verifyProbe(ctx)).toBe(false);
      expect(realpathSync(target)).toBe(realpathSync(otherRepo));
    } finally {
      rmSync(localScratch, { recursive: true, force: true });
    }
  });

  it('links the Git root when invoked from a subdirectory and verifies green', async () => {
    const localScratch = mkdtempSync(join(tmpdir(), 'fw-t61-subdir-'));
    try {
      const project = join(localScratch, 'my-project');
      const nestedCwd = join(project, 'mcp-server');
      const base = join(localScratch, 'ntm-base');
      const target = join(base, basename(project));
      mkdirSync(join(project, '.git'), { recursive: true });
      mkdirSync(nestedCwd);
      mkdirSync(base);
      const ctx: HandlerCtx = {
        cwd: nestedCwd,
        signal: new AbortController().signal,
        exec: async (cmd, args) => cmd === 'ntm' && args[0] === 'config'
          ? {
              code: 0,
              stdout: `projects_base = "${base}"\n`,
              stderr: '',
            }
          : { code: 1, stdout: '', stderr: 'unexpected command' },
      };

      const plan = await projectsBaseMisconfigHandler.buildPlan(ctx);
      expect(plan.steps).toEqual([
        `ln -s "${realpathSync(project)}" "${target}"`,
      ]);
      await expect(projectsBaseMisconfigHandler.execute(ctx)).resolves.toMatchObject({
        stepsRun: 1,
      });
      expect(realpathSync(target)).toBe(realpathSync(project));
      expect(await projectsBaseMisconfigHandler.verifyProbe(ctx)).toBe(true);
    } finally {
      rmSync(localScratch, { recursive: true, force: true });
    }
  });
});
