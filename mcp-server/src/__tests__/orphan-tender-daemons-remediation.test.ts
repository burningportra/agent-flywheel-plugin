import { describe, it, expect } from 'vitest';
import {
  remediateOrphanDaemons,
  orphanTenderDaemonsHandler,
} from '../tools/remediations/orphan_tender_daemons.js';
import { REMEDIATION_REGISTRY, type HandlerCtx } from '../tools/remediate.js';
import { terminate, terminateMany, isAlive } from '../platform.js';
import type { ExecFn } from '../exec.js';

/**
 * T6.2 doctor remediation for orphan tender-daemons. The handler escalates
 * SIGTERM → 1s grace → SIGKILL via platform.terminateMany; tests inject a
 * fake `killFn` to drive every branch without spawning real processes.
 */

function makeKillFn(behavior: Record<number, 'gone-after-term' | 'gone-after-kill' | 'survives' | 'esrch-immediately'>) {
  // Track liveness state per pid across calls.
  const state = new Map<number, boolean>(); // true=alive, false=gone
  for (const [pidStr, kind] of Object.entries(behavior)) {
    const pid = Number(pidStr);
    state.set(pid, kind !== 'esrch-immediately');
  }
  return (pid: number, signal?: NodeJS.Signals | number): boolean => {
    const kind = behavior[pid];
    if (kind === undefined) {
      // unknown pid → simulate ESRCH
      return false;
    }
    if (signal === 0) {
      // liveness probe
      return state.get(pid) === true;
    }
    if (signal === 'SIGTERM') {
      if (kind === 'esrch-immediately') return false;
      if (kind === 'gone-after-term') state.set(pid, false);
      // 'gone-after-kill' and 'survives' both stay alive after SIGTERM
      return true;
    }
    if (signal === 'SIGKILL') {
      if (kind === 'gone-after-kill') {
        state.set(pid, false);
        return true;
      }
      if (kind === 'survives') return true;
      return true;
    }
    return true;
  };
}

const fastSleep = (_ms: number) => Promise.resolve();

describe('remediateOrphanDaemons (T6.2) — pure helper', () => {
  it('dry-run returns kill -TERM commands without firing signals', async () => {
    const result = await remediateOrphanDaemons({
      pids: [9491],
      mode: 'dry-run',
    });
    expect(result.commands).toEqual(['kill -TERM 9491']);
    expect(result.executed).toBe(false);
  });

  it('skip behaves like dry-run', async () => {
    const result = await remediateOrphanDaemons({
      pids: [9491, 12345],
      mode: 'skip',
    });
    expect(result.commands).toEqual(['kill -TERM 9491', 'kill -TERM 12345']);
    expect(result.executed).toBe(false);
  });

  it('execute reports "terminated" when SIGTERM alone clears the pid', async () => {
    const result = await remediateOrphanDaemons({
      pids: [9491],
      mode: 'execute',
      killOptions: { killFn: makeKillFn({ 9491: 'gone-after-term' }), sleepFn: fastSleep },
    });
    expect(result.executed).toBe(true);
    expect(result.results).toEqual([{ pid: 9491, status: 'terminated' }]);
  });

  it('execute reports "killed" when SIGTERM does not but SIGKILL does', async () => {
    const result = await remediateOrphanDaemons({
      pids: [9491],
      mode: 'execute',
      killOptions: { killFn: makeKillFn({ 9491: 'gone-after-kill' }), sleepFn: fastSleep },
    });
    expect(result.results?.[0]).toEqual({ pid: 9491, status: 'killed' });
  });

  it('execute reports "error" when the process survives SIGKILL escalation', async () => {
    const result = await remediateOrphanDaemons({
      pids: [9491],
      mode: 'execute',
      killOptions: { killFn: makeKillFn({ 9491: 'survives' }), sleepFn: fastSleep },
    });
    expect(result.results?.[0]?.status).toBe('error');
  });

  it('handles multiple pids in a single call', async () => {
    const result = await remediateOrphanDaemons({
      pids: [1, 2, 3],
      mode: 'execute',
      killOptions: {
        killFn: makeKillFn({
          1: 'gone-after-term',
          2: 'gone-after-kill',
          3: 'esrch-immediately',
        }),
        sleepFn: fastSleep,
      },
    });
    expect(result.commands).toEqual(['kill -TERM 1', 'kill -TERM 2', 'kill -TERM 3']);
    // pid 3 was already gone (ESRCH on SIGTERM, isAlive returns false), so the
    // outcome is the no-op "terminated" path — not "error". Only a process
    // that survives even the SIGKILL escalation is reported as "error".
    expect(result.results?.map((r) => r.status)).toEqual(['terminated', 'killed', 'terminated']);
  });
});

describe('platform.terminate / terminateMany (T6.2)', () => {
  it('terminate single pid: SIGTERM is enough', async () => {
    const o = await terminate(9491, {
      killFn: makeKillFn({ 9491: 'gone-after-term' }),
      sleepFn: fastSleep,
    });
    expect(o).toMatchObject({ pid: 9491, signalled: true, terminated: true, escalated: false });
  });

  it('terminate escalates to SIGKILL when SIGTERM is ignored', async () => {
    const o = await terminate(9491, {
      killFn: makeKillFn({ 9491: 'gone-after-kill' }),
      sleepFn: fastSleep,
    });
    expect(o.escalated).toBe(true);
    expect(o.terminated).toBe(true);
  });

  it('terminate reports terminated=false when even SIGKILL fails', async () => {
    const o = await terminate(9491, {
      killFn: makeKillFn({ 9491: 'survives' }),
      sleepFn: fastSleep,
    });
    expect(o.escalated).toBe(true);
    expect(o.terminated).toBe(false);
  });

  it('terminateMany preserves input pid order in the outcome list', async () => {
    const outcomes = await terminateMany([3, 1, 2], {
      killFn: makeKillFn({ 1: 'gone-after-term', 2: 'gone-after-term', 3: 'gone-after-term' }),
      sleepFn: fastSleep,
    });
    expect(outcomes.map((o) => o.pid)).toEqual([3, 1, 2]);
  });

  it('isAlive returns true for a running process (self pid) and false for a never-allocated one', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(2_147_483_640)).toBe(false);
  });
});

describe('orphanTenderDaemonsHandler (T6.2) — doctor integration', () => {
  it('is registered in REMEDIATION_REGISTRY under orphan_tender_daemons', () => {
    expect(REMEDIATION_REGISTRY['orphan_tender_daemons']).toBeDefined();
    expect(REMEDIATION_REGISTRY['orphan_tender_daemons']).toBe(orphanTenderDaemonsHandler);
  });

  it('handler advertises mutating + reversible:false', () => {
    expect(orphanTenderDaemonsHandler.mutating).toBe(true);
    expect(orphanTenderDaemonsHandler.reversible).toBe(false);
  });

  it('buildPlan returns an empty plan when ps lists no tender-daemons', async () => {
    const exec: ExecFn = async (cmd: string) => {
      if (cmd === 'ps') return { code: 0, stdout: 'PID COMMAND\n1234 zsh\n', stderr: '' };
      if (cmd === 'tmux') return { code: 0, stdout: 'main\n', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    };
    const ctx: HandlerCtx = { cwd: '/tmp', exec, signal: new AbortController().signal };
    const plan = await orphanTenderDaemonsHandler.buildPlan(ctx);
    expect(plan.steps).toEqual([]);
    expect(plan.mutating).toBe(false);
  });

  it('buildPlan returns kill -TERM steps for an orphan PID whose tmux session is gone', async () => {
    const exec: ExecFn = async (cmd: string) => {
      if (cmd === 'ps') {
        return {
          code: 0,
          stdout:
            'PID COMMAND\n9491 node /opt/tender-daemon.js --session ghost-session\n12345 zsh\n',
          stderr: '',
        };
      }
      if (cmd === 'tmux') return { code: 0, stdout: 'main\n', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    };
    const ctx: HandlerCtx = { cwd: '/tmp', exec, signal: new AbortController().signal };
    const plan = await orphanTenderDaemonsHandler.buildPlan(ctx);
    expect(plan.steps.length).toBeGreaterThanOrEqual(1);
    expect(plan.steps[0]).toMatch(/^kill -TERM \d+/);
    expect(plan.mutating).toBe(true);
    expect(plan.reversible).toBe(false);
  });
});
