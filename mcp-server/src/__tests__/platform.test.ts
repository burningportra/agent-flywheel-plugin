import { describe, it, expect, vi } from 'vitest';
import type { KillOptions, KillOutcome } from '../platform.js';
import { isAlive, terminate, terminateMany } from '../platform.js';

/**
 * Builds a deterministic kill mock that simulates SIGTERM acceptance,
 * grace-window survival, and SIGKILL escalation. ESRCH-style failures
 * are modelled by returning false (matches platform.ts defaultKill).
 */
function makeKillFn(opts: {
  alive: boolean;
  acceptsSigterm?: boolean;
  diesOnSigterm?: boolean;
  acceptsSigkill?: boolean;
  diesOnSigkill?: boolean;
}): {
  kill: NonNullable<KillOptions['killFn']>;
  calls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }>;
} {
  let alive = opts.alive;
  const calls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
  const kill: NonNullable<KillOptions['killFn']> = (pid, signal) => {
    calls.push({ pid, signal });
    if (signal === 0) return alive;
    if (signal === 'SIGTERM') {
      if (!(opts.acceptsSigterm ?? true)) return false;
      if (opts.diesOnSigterm ?? false) alive = false;
      return true;
    }
    if (signal === 'SIGKILL') {
      if (!(opts.acceptsSigkill ?? true)) return false;
      if (opts.diesOnSigkill ?? true) alive = false;
      return true;
    }
    return true;
  };
  return { kill, calls };
}

const noopSleep = (_ms: number) => Promise.resolve();

describe('isAlive', () => {
  it('returns true when the kill probe succeeds', () => {
    const { kill } = makeKillFn({ alive: true });
    expect(isAlive(1234, kill)).toBe(true);
  });

  it('returns false when the kill probe fails (ESRCH)', () => {
    const { kill } = makeKillFn({ alive: false });
    expect(isAlive(1234, kill)).toBe(false);
  });

  it('passes signal 0 to the kill primitive (non-destructive probe)', () => {
    const { kill, calls } = makeKillFn({ alive: true });
    isAlive(99, kill);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ pid: 99, signal: 0 });
  });
});

describe('terminate', () => {
  it('SIGTERM kills the process within the grace window: signalled=true, terminated=true, no escalation', async () => {
    const { kill, calls } = makeKillFn({ alive: true, diesOnSigterm: true });
    const outcome = await terminate(4242, { killFn: kill, sleepFn: noopSleep });
    expect(outcome.pid).toBe(4242);
    expect(outcome.signalled).toBe(true);
    expect(outcome.terminated).toBe(true);
    expect(outcome.escalated).toBe(false);
    expect(outcome.error).toBeUndefined();
    // SIGTERM then liveness probe (signal 0). No SIGKILL.
    expect(calls.map((c) => c.signal)).toEqual(['SIGTERM', 0]);
  });

  it('non-existent PID: SIGTERM rejected and pid already gone → signalled=false, terminated=true, no error', async () => {
    const { kill } = makeKillFn({ alive: false, acceptsSigterm: false });
    const outcome = await terminate(9999, { killFn: kill, sleepFn: noopSleep });
    expect(outcome.signalled).toBe(false);
    expect(outcome.terminated).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(outcome.escalated).toBe(false);
  });

  it('process survives SIGTERM → escalates to SIGKILL, terminated=true', async () => {
    const { kill, calls } = makeKillFn({
      alive: true,
      acceptsSigterm: true,
      diesOnSigterm: false,
      acceptsSigkill: true,
      diesOnSigkill: true,
    });
    const outcome = await terminate(7, { killFn: kill, sleepFn: noopSleep, graceMs: 10 });
    expect(outcome.signalled).toBe(true);
    expect(outcome.escalated).toBe(true);
    expect(outcome.terminated).toBe(true);
    // SIGTERM → probe (alive) → SIGKILL → probe
    expect(calls.map((c) => c.signal)).toEqual(['SIGTERM', 0, 'SIGKILL', 0]);
  });

  it('SIGKILL also rejected → terminated reflects post-probe state, error populated', async () => {
    // Process never dies and rejects SIGKILL.
    const { kill } = makeKillFn({
      alive: true,
      acceptsSigterm: true,
      diesOnSigterm: false,
      acceptsSigkill: false,
    });
    const outcome = await terminate(11, { killFn: kill, sleepFn: noopSleep });
    expect(outcome.signalled).toBe(true);
    expect(outcome.escalated).toBe(true);
    expect(outcome.terminated).toBe(false);
    expect(outcome.error).toBe('SIGKILL rejected for pid 11');
  });

  it('SIGTERM rejected but process is still alive → terminated=false, error message populated', async () => {
    const { kill } = makeKillFn({
      alive: true,
      acceptsSigterm: false,
    });
    const outcome = await terminate(33, { killFn: kill, sleepFn: noopSleep });
    expect(outcome.signalled).toBe(false);
    expect(outcome.terminated).toBe(false);
    expect(outcome.error).toBe('SIGTERM rejected for pid 33');
  });

  it('honours custom graceMs by passing it to sleepFn', async () => {
    const { kill } = makeKillFn({ alive: true, diesOnSigterm: true });
    const sleepFn = vi.fn(async (_ms: number) => undefined);
    await terminate(55, { killFn: kill, sleepFn, graceMs: 250 });
    expect(sleepFn).toHaveBeenCalledWith(250);
  });

  it('uses default 1000ms graceMs when not provided', async () => {
    const { kill } = makeKillFn({ alive: true, diesOnSigterm: true });
    const sleepFn = vi.fn(async (_ms: number) => undefined);
    await terminate(56, { killFn: kill, sleepFn });
    expect(sleepFn).toHaveBeenCalledWith(1000);
  });

  it('never throws even when kill primitive returns falsy on every call', async () => {
    const kill: NonNullable<KillOptions['killFn']> = () => false;
    let outcome: KillOutcome | undefined;
    await expect(async () => {
      outcome = await terminate(77, { killFn: kill, sleepFn: noopSleep });
    }).not.toThrow();
    expect(outcome).toBeDefined();
    expect(outcome!.pid).toBe(77);
  });
});

describe('terminateMany', () => {
  it('processes each pid sequentially and returns outcomes in order', async () => {
    const { kill } = makeKillFn({ alive: true, diesOnSigterm: true });
    const outcomes = await terminateMany([1, 2, 3], { killFn: kill, sleepFn: noopSleep });
    expect(outcomes).toHaveLength(3);
    expect(outcomes.map((o) => o.pid)).toEqual([1, 2, 3]);
    for (const o of outcomes) {
      expect(o.terminated).toBe(true);
    }
  });

  it('returns an empty array for an empty pid list', async () => {
    const { kill } = makeKillFn({ alive: true });
    const outcomes = await terminateMany([], { killFn: kill, sleepFn: noopSleep });
    expect(outcomes).toEqual([]);
  });
});
