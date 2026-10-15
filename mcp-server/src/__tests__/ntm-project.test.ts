import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';

import { classifyNtmProjectTarget } from '../ntm-project.js';

describe('classifyNtmProjectTarget', () => {
  let scratch: string;
  let cwd: string;
  let projectsBase: string;
  let target: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'ntm-project-'));
    cwd = join(scratch, 'project');
    projectsBase = join(scratch, 'projects');
    target = join(projectsBase, basename(cwd));
    mkdirSync(cwd);
    mkdirSync(projectsBase);
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('classifies an absent target as missing', async () => {
    await expect(classifyNtmProjectTarget(cwd, projectsBase)).resolves.toEqual({
      kind: 'missing',
      project: basename(cwd),
      root: realpathSync(cwd),
      target,
    });
  });

  it('accepts a relative symlink that resolves to the project', async () => {
    symlinkSync(relative(projectsBase, cwd), target);

    await expect(
      classifyNtmProjectTarget(cwd, projectsBase),
    ).resolves.toMatchObject({
      kind: 'matching',
      root: realpathSync(cwd),
      target,
      resolvedTarget: realpathSync(cwd),
    });
  });

  it('accepts the project directory when it already lives under projects_base', async () => {
    const directBase = join(scratch, 'direct-projects');
    const directCwd = join(directBase, 'direct-project');
    mkdirSync(directCwd, { recursive: true });

    await expect(
      classifyNtmProjectTarget(directCwd, directBase),
    ).resolves.toMatchObject({
      kind: 'matching',
      root: realpathSync(directCwd),
      target: directCwd,
    });
  });

  it('classifies a symlink to another repository as a collision', async () => {
    const other = join(scratch, 'other');
    mkdirSync(other);
    symlinkSync(other, target);

    await expect(
      classifyNtmProjectTarget(cwd, projectsBase),
    ).resolves.toMatchObject({
      kind: 'collision',
      reason: 'different-target',
      target,
      resolvedTarget: realpathSync(other),
    });
  });

  it('classifies an unrelated directory as a collision', async () => {
    mkdirSync(target);

    await expect(
      classifyNtmProjectTarget(cwd, projectsBase),
    ).resolves.toMatchObject({
      kind: 'collision',
      reason: 'different-target',
      target,
    });
  });

  it('classifies a regular file as a collision', async () => {
    writeFileSync(target, 'occupied\n');

    await expect(
      classifyNtmProjectTarget(cwd, projectsBase),
    ).resolves.toMatchObject({
      kind: 'collision',
      reason: 'regular-file',
      target,
    });
  });

  it('classifies a dangling symlink as an occupied collision', async () => {
    const missing = join(scratch, 'missing');
    symlinkSync(missing, target);

    await expect(
      classifyNtmProjectTarget(cwd, projectsBase),
    ).resolves.toMatchObject({
      kind: 'collision',
      reason: 'dangling-symlink',
      target,
      resolvedTarget: missing,
    });
  });
});
