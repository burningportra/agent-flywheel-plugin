/**
 * Regression test: shell-loop hygiene — transient non-zero exits from a
 * polling command must NOT cause spurious escalation.
 *
 * resilientExec is the wrapper in this codebase that runs repeated CLI calls
 * with retry logic. This test verifies:
 *   - 3 consecutive transient non-zero exits do NOT exceed the retry budget
 *     (i.e., they are retried until budget is exhausted, then return ok:false).
 *   - ok:false after budget exhaustion is NOT a throw — callers get a
 *     discriminated result to handle gracefully.
 *   - A single transient failure followed by success → ok:true.
 *   - The signal (AbortSignal) short-circuits the retry loop cleanly.
 */

import { describe, it, expect, vi } from 'vitest';
import { resilientExec } from '../../cli-exec.js';
import type { ExecFn } from '../../exec.js';

// ─── Tests ───────────────────────────────────────────────────

describe('regression/monitor-noise (resilientExec transient non-zero)', () => {
  it('3 consecutive non-zero exits exhaust retry budget but never throw', async () => {
    let callCount = 0;
    const exec: ExecFn = vi.fn(async () => {
      callCount++;
      return { code: 1, stdout: '', stderr: 'transient error' };
    });

    let threw = false;
    let result;
    try {
      result = await resilientExec(exec, 'br', ['list', '--json'], {
        maxRetries: 2,
        retryDelayMs: 0, // no sleep in tests
        logWarnings: false,
        isTransient: (_exitCode, _stderr, _err) => true, // treat every failure as transient
      });
    } catch {
      threw = true;
    }

    expect(threw, 'resilientExec must never throw').toBe(false);
    expect(result).toBeDefined();
    expect(result!.ok).toBe(false);
    // With maxRetries:2, we expect 3 total attempts (1 initial + 2 retries).
    expect(callCount).toBe(3);
  });

  it('transient failure then success → ok:true after one retry', async () => {
    let callCount = 0;
    const exec: ExecFn = vi.fn(async () => {
      callCount++;
      if (callCount < 2) {
        return { code: 127, stdout: '', stderr: 'command not found' };
      }
      return { code: 0, stdout: '[]', stderr: '' };
    });

    const result = await resilientExec(exec, 'br', ['list', '--json'], {
      maxRetries: 3,
      retryDelayMs: 0,
      logWarnings: false,
      isTransient: (exitCode) => exitCode !== 0,
    });

    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  it('non-transient failure on first attempt → ok:false, no retry', async () => {
    let callCount = 0;
    const exec: ExecFn = vi.fn(async () => {
      callCount++;
      return { code: 1, stdout: '', stderr: 'permanent error' };
    });

    const result = await resilientExec(exec, 'br', ['status'], {
      maxRetries: 5,
      retryDelayMs: 0,
      logWarnings: false,
      isTransient: () => false, // nothing is transient
    });

    expect(result.ok).toBe(false);
    // Non-transient: only 1 attempt, no retries.
    expect(callCount).toBe(1);
  });

  it('already-aborted signal short-circuits before first attempt', async () => {
    const exec: ExecFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const ac = new AbortController();
    ac.abort();

    let threw = false;
    let result;
    try {
      result = await resilientExec(exec, 'br', ['list'], {
        signal: ac.signal,
        logWarnings: false,
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).toBeDefined();
    expect(result!.ok).toBe(false);
    // exec should NOT have been called (short-circuit before first attempt).
    expect(exec).not.toHaveBeenCalled();
  });

  it('zero retries on persistent non-zero exit: ok:false with attempt count 1', async () => {
    const exec: ExecFn = vi.fn(async () => ({ code: 2, stdout: '', stderr: 'err' }));

    const result = await resilientExec(exec, 'git', ['status'], {
      maxRetries: 0,
      logWarnings: false,
      isTransient: () => true,
    });

    expect(result.ok).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
