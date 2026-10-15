/**
 * projects_base_misconfig remediation (T6.1, v3.16.0 noob-onboarding).
 *
 * Symptom: `ntm` is installed and configured with a `projects_base` directory,
 * but the current project (`basename(cwd)`) is NOT reachable under it. Without
 * this symlink, `ntm spawn` resolves to the wrong working tree and the
 * flywheel's planning/impl phases silently fall back to plain `Agent()`.
 *
 * Fix: `ln -s <cwd> <projects_base>/<basename(cwd)>`.
 *
 * Mutating but reversible (a single symlink that can be removed with `rm`).
 */

import { symlink } from 'node:fs/promises';
import type { HandlerCtx, RemediationHandler } from '../remediate.js';
import { createLogger } from '../../logger.js';
import {
  classifyNtmProjectTarget,
  parseNtmProjectsBase,
  type NtmProjectTarget,
} from '../../ntm-project.js';

const log = createLogger('remediation.projects_base_misconfig');

const NTM_CONFIG_TIMEOUT_MS = 5_000;

export type RemediateProjectsBaseInput = {
  cwd: string;
  ntmBase: string;
  mode: 'dry-run' | 'execute' | 'skip';
};

export type RemediateProjectsBaseResult = {
  command: string;
  executed: boolean;
  changed: boolean;
  source: string;
  target: string;
};

/**
 * Pure helper used by the plan's contract test. The doctor remediation
 * registry (below) wraps this with the standard buildPlan/execute/verifyProbe
 * shape; this overload is the standalone entry point the plan calls out.
 */
export async function remediateProjectsBase(
  opts: RemediateProjectsBaseInput,
): Promise<RemediateProjectsBaseResult> {
  const targetState = await classifyNtmProjectTarget(opts.cwd, opts.ntmBase);
  const source = targetState.root;
  const command = symlinkCommand(source, targetState.target);
  if (opts.mode === 'skip') {
    return { command, executed: false, changed: false, source, target: targetState.target };
  }
  if (targetState.kind === 'collision') {
    throw new Error(collisionMessage(targetState));
  }
  if (opts.mode === 'dry-run') {
    return { command, executed: false, changed: false, source, target: targetState.target };
  }
  if (targetState.kind === 'matching') {
    return { command, executed: true, changed: false, source, target: targetState.target };
  }
  await symlink(source, targetState.target);
  return { command, executed: true, changed: true, source, target: targetState.target };
}

function symlinkCommand(source: string, target: string): string {
  return `ln -s "${source}" "${target}"`;
}

function collisionMessage(target: Extract<NtmProjectTarget, { kind: 'collision' }>): string {
  const actual = target.resolvedTarget ?? target.reason;
  return `Refusing projects_base name collision at ${target.target}: resolves to ${actual}; expected ${target.root}.`;
}

async function readNtmBase(ctx: HandlerCtx): Promise<string | null> {
  try {
    const res = await ctx.exec('ntm', ['config', 'show'], {
      cwd: ctx.cwd,
      timeout: NTM_CONFIG_TIMEOUT_MS,
      signal: ctx.signal,
    });
    if (res.code !== 0) return null;
    return parseNtmProjectsBase(res.stdout);
  } catch (err) {
    log.warn('readNtmBase failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export const projectsBaseMisconfigHandler: RemediationHandler = {
  description:
    'Symlink the current project under ntm projects_base so ntm spawn resolves to the correct working tree.',
  mutating: true,
  reversible: true,

  async buildPlan(ctx) {
    const ntmBase = await readNtmBase(ctx);
    if (ntmBase === null) {
      return {
        description:
          'ntm is not installed or `ntm config show` did not return a projects_base — no symlink to create.',
        steps: [],
        mutating: false,
        reversible: false,
      };
    }
    const target = await classifyNtmProjectTarget(ctx.cwd, ntmBase);
    if (target.kind === 'collision') {
      return {
        description: collisionMessage(target),
        steps: [],
        mutating: false,
        reversible: false,
      };
    }
    if (target.kind === 'matching') {
      return {
        description: `projects_base target already resolves to ${target.root} — nothing to do.`,
        steps: [],
        mutating: false,
        reversible: false,
      };
    }
    return {
      description: `Symlink ${target.root} → ${target.target} so ntm spawn resolves correctly.`,
      steps: [symlinkCommand(target.root, target.target)],
      mutating: true,
      reversible: true,
    };
  },

  async execute(ctx) {
    const ntmBase = await readNtmBase(ctx);
    if (ntmBase === null) {
      return { stepsRun: 0, stderr: 'ntm config show did not return a projects_base; nothing to symlink.' };
    }
    const { changed, executed, source, target } = await remediateProjectsBase({
      cwd: ctx.cwd,
      ntmBase,
      mode: 'execute',
    });
    return {
      stepsRun: changed ? 1 : 0,
      stdout: changed
        ? `Symlinked ${source} → ${target}`
        : executed
          ? `projects_base target already resolves to ${source}`
          : undefined,
    };
  },

  async verifyProbe(ctx) {
    const ntmBase = await readNtmBase(ctx);
    if (ntmBase === null) return false;
    try {
      return (await classifyNtmProjectTarget(ctx.cwd, ntmBase)).kind === 'matching';
    } catch {
      return false;
    }
  },
};
