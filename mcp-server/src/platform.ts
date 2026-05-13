/**
 * Cross-platform process-control wrappers shared by remediation handlers
 * (T6.1 / T6.2 from the v3.16.0 noob-onboarding plan).
 *
 * The Node `process.kill(pid, signal)` API exists on every supported
 * platform, but Windows ignores POSIX signals and instead routes signal 0
 * + Ctrl-C/Ctrl-Break via a separate path. To keep the remediation handlers
 * simple, callers funnel through these helpers and get a uniform
 * `{ alive, terminated, error }` shape on every OS.
 */

import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_SIGKILL_GRACE_MS = 1_000;

export interface KillOutcome {
  pid: number;
  /** True when the process accepted SIGTERM (or Windows graceful close). */
  signalled: boolean;
  /** True when the process is gone after the grace window. */
  terminated: boolean;
  /** True when a follow-up SIGKILL/forceful close was issued. */
  escalated: boolean;
  /** Captured stderr/error string when the signal call threw. */
  error?: string;
}

export interface KillOptions {
  /** Milliseconds to wait between SIGTERM and the liveness re-probe (default 1000). */
  graceMs?: number;
  /** Test injection for the actual kill primitive. */
  killFn?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  /** Test injection for sleep. */
  sleepFn?: (ms: number) => Promise<void>;
}

function defaultKill(pid: number, signal?: NodeJS.Signals | number): boolean {
  try {
    process.kill(pid, signal as NodeJS.Signals);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe whether a pid is alive without altering it. `process.kill(pid, 0)`
 * throws ESRCH when the process is gone; we treat any throw as "not
 * alive" to stay defensive across platforms.
 */
export function isAlive(pid: number, killFn: KillOptions['killFn'] = defaultKill): boolean {
  return killFn(pid, 0);
}

/**
 * Terminate a single pid using the SIGTERM → wait → SIGKILL escalation
 * required by the T6.2 spec. Always resolves; never throws.
 */
export async function terminate(pid: number, opts: KillOptions = {}): Promise<KillOutcome> {
  const killFn = opts.killFn ?? defaultKill;
  const sleepFn = opts.sleepFn ?? ((ms: number) => sleep(ms));
  const graceMs = opts.graceMs ?? DEFAULT_SIGKILL_GRACE_MS;

  const outcome: KillOutcome = {
    pid,
    signalled: false,
    terminated: false,
    escalated: false,
  };

  // Step 1 — SIGTERM
  const termOk = killFn(pid, 'SIGTERM');
  outcome.signalled = termOk;
  if (!termOk) {
    // ESRCH on the very first signal means the process was already gone.
    outcome.terminated = !isAlive(pid, killFn);
    if (!outcome.terminated) {
      outcome.error = `SIGTERM rejected for pid ${pid}`;
    }
    return outcome;
  }

  // Step 2 — sleep, then re-probe
  await sleepFn(graceMs);
  if (!isAlive(pid, killFn)) {
    outcome.terminated = true;
    return outcome;
  }

  // Step 3 — escalate to SIGKILL
  outcome.escalated = true;
  const killOk = killFn(pid, 'SIGKILL');
  if (!killOk) {
    outcome.error = `SIGKILL rejected for pid ${pid}`;
    outcome.terminated = !isAlive(pid, killFn);
    return outcome;
  }
  // Give the kernel a moment to reap; honour the same grace as the SIGTERM
  // step so test fakes don't need a second tick value.
  await sleepFn(graceMs);
  outcome.terminated = !isAlive(pid, killFn);
  return outcome;
}

export async function terminateMany(
  pids: number[],
  opts: KillOptions = {},
): Promise<KillOutcome[]> {
  const out: KillOutcome[] = [];
  for (const pid of pids) {
    out.push(await terminate(pid, opts));
  }
  return out;
}
