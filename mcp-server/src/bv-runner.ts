/**
 * bv-runner: thin wrapper around `bv --robot-*` graph-analysis flags.
 *
 * Every call carries an explicit `timeout` (default 5s) and propagates the
 * caller's `AbortSignal`, per the degraded-mode contract: when `bv` is
 * missing, exits non-zero, or emits unparsable output, the result is
 * `{ available: false, warning }` — never a throw — so callers can enrich
 * responses best-effort and keep working.
 */
import type { ExecFn } from './exec.js';
import { createLogger } from './logger.js';

const log = createLogger('bv-runner');

export type BvRobotMode = 'triage' | 'next' | 'plan' | 'insights';

export interface BvRobotResult {
  available: boolean;
  data: unknown;
  raw?: string;
  warning?: string;
}

export interface BvRobotOpts {
  timeout?: number;
  signal?: AbortSignal;
}

/** Default per-call budget for `bv --robot-*` (ms). */
export const BV_ROBOT_TIMEOUT_MS = 5000;

export async function runBvRobot(
  exec: ExecFn,
  cwd: string,
  mode: BvRobotMode,
  opts: BvRobotOpts = {},
): Promise<BvRobotResult> {
  const flag = `--robot-${mode}`;
  const timeout = opts.timeout ?? BV_ROBOT_TIMEOUT_MS;
  const signal = opts.signal;
  if (signal?.aborted) {
    return { available: false, data: null, warning: `bv ${flag} skipped: aborted` };
  }
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await exec('bv', [flag], { cwd, timeout, signal });
  } catch (err) {
    // Spawn failure (bv missing) or timeout — ExecFn rejects on both.
    log.warn(`bv ${flag} unavailable`, { err: String(err) });
    return { available: false, data: null, warning: `bv ${flag} unavailable: ${String(err)}` };
  }
  if (result.code !== 0) {
    log.warn(`bv ${flag} exited non-zero`, { code: result.code, stderr: result.stderr.slice(0, 200) });
    return {
      available: false,
      data: null,
      warning: `bv ${flag} exited ${result.code}: ${result.stderr.trim().slice(0, 200)}`,
    };
  }
  try {
    return { available: true, data: JSON.parse(result.stdout), raw: result.stdout };
  } catch (err) {
    log.warn(`bv ${flag} output unparsable`, { err: String(err) });
    return { available: false, data: null, warning: `bv ${flag} output is not JSON` };
  }
}
