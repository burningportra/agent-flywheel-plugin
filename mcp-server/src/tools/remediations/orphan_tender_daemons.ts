/**
 * orphan_tender_daemons remediation (T6.2, v3.16.0 noob-onboarding).
 *
 * The doctor probe in `mcp-server/src/checks/orphan-tender-daemons.ts` already
 * enumerates `node tender-daemon.js` PIDs whose `--session <name>` is no
 * longer in `tmux list-sessions`. This handler re-runs that classifier in
 * buildPlan, renders the `kill -TERM <pid>` plan, then escalates SIGTERM →
 * 1s wait → SIGKILL via `platform.terminateMany` on execute. verifyProbe
 * re-runs the classifier and confirms zero orphans remain.
 *
 * Mutating + reversible:false (a killed process is gone; restart is operator
 * driven). The dispatcher in `remediate.ts` enforces `autoConfirm:true` for
 * mutating handlers, matching the SKILL.md remediation menu.
 */

import type { HandlerCtx, RemediationHandler } from '../remediate.js';
import { createLogger } from '../../logger.js';
import { terminateMany, type KillOptions } from '../../platform.js';
import {
  classifyOrphans,
  parseTenderDaemonProcesses,
  parseTmuxSessions,
} from '../../checks/orphan-tender-daemons.js';

const PS_TIMEOUT_MS = 10_000;
const TMUX_TIMEOUT_MS = 5_000;

const log = createLogger('remediation.orphan_tender_daemons');

export interface RemediateOrphanDaemonsOptions {
  pids: number[];
  mode: 'dry-run' | 'execute' | 'skip';
  killOptions?: KillOptions;
}

export interface RemediateOrphanDaemonsResult {
  commands: string[];
  executed: boolean;
  results?: Array<{ pid: number; status: 'terminated' | 'killed' | 'error'; error?: string }>;
}

/**
 * Standalone helper covering the plan's documented entry point. Unit tests
 * construct {pids, mode} directly to avoid the full registry plumbing.
 */
export async function remediateOrphanDaemons(
  opts: RemediateOrphanDaemonsOptions,
): Promise<RemediateOrphanDaemonsResult> {
  const commands = opts.pids.map((pid) => `kill -TERM ${pid}`);
  if (opts.mode !== 'execute') {
    return { commands, executed: false };
  }
  const outcomes = await terminateMany(opts.pids, opts.killOptions);
  const results = outcomes.map((o) => {
    if (!o.terminated) {
      return { pid: o.pid, status: 'error' as const, error: o.error ?? 'process still alive' };
    }
    return { pid: o.pid, status: o.escalated ? ('killed' as const) : ('terminated' as const) };
  });
  return { commands, executed: true, results };
}

async function listOrphanPids(ctx: HandlerCtx): Promise<number[]> {
  const ps = await ctx.exec('ps', ['-eo', 'pid,command'], {
    cwd: ctx.cwd,
    timeout: PS_TIMEOUT_MS,
    signal: ctx.signal,
  });
  if (ps.code !== 0) {
    log.warn('ps -eo pid,command non-zero exit', { exitCode: ps.code });
    return [];
  }
  const daemons = parseTenderDaemonProcesses(ps.stdout);
  if (daemons.length === 0) return [];
  let live = new Set<string>();
  try {
    const tmux = await ctx.exec('tmux', ['list-sessions', '-F', '#S'], {
      cwd: ctx.cwd,
      timeout: TMUX_TIMEOUT_MS,
      signal: ctx.signal,
    });
    if (tmux.code === 0) live = parseTmuxSessions(tmux.stdout);
  } catch {
    /* tmux missing — treat all session-bound daemons as orphans */
  }
  return classifyOrphans(daemons, live).map((d) => d.pid);
}

export const orphanTenderDaemonsHandler: RemediationHandler = {
  description: 'Terminate orphan tender-daemon processes with SIGTERM → 1s grace → SIGKILL.',
  mutating: true,
  reversible: false,

  async buildPlan(ctx: HandlerCtx) {
    const pids = await listOrphanPids(ctx);
    if (pids.length === 0) {
      return {
        description: 'No orphan tender-daemon processes detected.',
        steps: [],
        mutating: false,
        reversible: false,
      };
    }
    return {
      description: `Terminate ${pids.length} orphan tender-daemon process${pids.length === 1 ? '' : 'es'} (SIGTERM, 1s grace, SIGKILL if alive).`,
      steps: pids.map((pid) => `kill -TERM ${pid}`),
      mutating: true,
      reversible: false,
    };
  },

  async execute(ctx: HandlerCtx) {
    const pids = await listOrphanPids(ctx);
    if (pids.length === 0) return { stepsRun: 0 };
    const outcomes = await terminateMany(pids);
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];
    let stepsRun = 0;
    for (const outcome of outcomes) {
      stepsRun += 1;
      if (outcome.terminated) {
        const tag = outcome.escalated ? 'SIGKILL' : 'SIGTERM';
        stdoutParts.push(`pid ${outcome.pid} ${tag} ok`);
      } else {
        stderrParts.push(`pid ${outcome.pid}: ${outcome.error ?? 'still alive after escalation'}`);
        log.warn('orphan daemon survived escalation', { pid: outcome.pid, error: outcome.error });
      }
    }
    return {
      stepsRun,
      stdout: stdoutParts.join('\n') || undefined,
      stderr: stderrParts.join('\n') || undefined,
    };
  },

  async verifyProbe(ctx: HandlerCtx) {
    const remaining = await listOrphanPids(ctx);
    if (remaining.length > 0) {
      log.warn('orphan tender-daemons remain after remediation', { pids: remaining });
      return false;
    }
    return true;
  },
};
