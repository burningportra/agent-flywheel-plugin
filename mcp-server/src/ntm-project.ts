import { lstat, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

type NtmProjectTargetBase = {
  project: string;
  root: string;
  target: string;
};

export type NtmProjectTarget =
  | (NtmProjectTargetBase & { kind: 'missing' })
  | (NtmProjectTargetBase & {
      kind: 'matching';
      resolvedTarget: string;
    })
  | (NtmProjectTargetBase & {
      kind: 'collision';
      reason: 'different-target' | 'regular-file' | 'dangling-symlink';
      resolvedTarget?: string;
    });

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && Reflect.get(error, 'code') === code;
}

export function parseNtmProjectsBase(raw: string): string | null {
  const match = raw.match(/projects_base\s*[=:]\s*"?([^"\n]+)"?/);
  return match?.[1]?.trim() || null;
}

export function ntmProjectName(cwd: string): string {
  return basename(cwd);
}

async function resolveProjectRoot(cwd: string): Promise<string> {
  const resolvedCwd = await realpath(cwd);
  let candidate = resolvedCwd;

  while (true) {
    try {
      const marker = await lstat(join(candidate, '.git'));
      if (marker.isDirectory() || marker.isFile()) return candidate;
    } catch (error: unknown) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }

    const parent = dirname(candidate);
    if (parent === candidate) return resolvedCwd;
    candidate = parent;
  }
}

export async function classifyNtmProjectTarget(
  cwd: string,
  projectsBase: string,
): Promise<NtmProjectTarget> {
  const root = await resolveProjectRoot(cwd);
  const project = ntmProjectName(root);
  const target = join(projectsBase, project);

  let targetStat: Awaited<ReturnType<typeof lstat>>;
  try {
    targetStat = await lstat(target);
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return { kind: 'missing', project, root, target };
    }
    throw error;
  }

  let resolvedTarget: string;
  try {
    resolvedTarget = await realpath(target);
  } catch (error: unknown) {
    if (targetStat.isSymbolicLink() && hasErrorCode(error, 'ENOENT')) {
      const link = await readlink(target);
      return {
        kind: 'collision',
        reason: 'dangling-symlink',
        project,
        root,
        target,
        resolvedTarget: isAbsolute(link)
          ? link
          : resolve(dirname(target), link),
      };
    }
    throw error;
  }

  if (!targetStat.isDirectory() && !targetStat.isSymbolicLink()) {
    return {
      kind: 'collision',
      reason: 'regular-file',
      project,
      root,
      target,
      resolvedTarget,
    };
  }
  if (resolvedTarget === root) {
    return { kind: 'matching', project, root, target, resolvedTarget };
  }
  return {
    kind: 'collision',
    reason: 'different-target',
    project,
    root,
    target,
    resolvedTarget,
  };
}
