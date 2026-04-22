/**
 * Cancellation contract for resilientExec (v3.4.0 F1).
 *
 * Aborting the supplied AbortSignal during the retry-delay window must:
 *   - stop resilientExec within one retry-delay (no unbounded sleep),
 *   - return `{ ok: false, error.lastError }`, and
 *   - have `classifyExecError(error.lastError)` yield `exec_aborted`.
 */

import { describe, it, expect, vi } from 'vitest';
import { resilientExec } from '../cli-exec.js';
import { classifyExecError } from '../errors.js';
import type { ExecFn } from '../exec.js';

describe('resilientExec — AbortSignal cancellation', () => {
  it('forwards the signal into the underlying exec call', async () => {
    const ac = new AbortController();
    const exec: ExecFn = vi.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });

    await resilientExec(exec, 'echo', ['hello'], { signal: ac.signal, timeout: 1000 });

    expect(exec).toHaveBeenCalledTimes(1);
    const callArgs = (exec as any).mock.calls[0];
    expect(callArgs[2]).toEqual(expect.objectContaining({ signal: ac.signal }));
  });

  it('short-circuits immediately when signal is already aborted before first attempt', async () => {
    const ac = new AbortController();
    ac.abort();

    const exec: ExecFn = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    const start = Date.now();
    const result = await resilientExec(exec, 'echo', ['hi'], {
      signal: ac.signal,
      logWarnings: false,
    });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    // Should return near-instantly, well under any retry-delay window.
    expect(elapsed).toBeLessThan(100);
    if (!result.ok) {
      expect(result.error.lastError).toBeInstanceOf(Error);
      const classified = classifyExecError(result.error.lastError);
      expect(classified.code).toBe('exec_aborted');
      expect(classified.retryable).toBe(false);
    }
  });

  it('aborting mid-retry-delay exits within one retry window and classifies as exec_aborted', async () => {
    const ac = new AbortController();

    // First attempt: transient failure (non-zero exit, empty stderr → transient
    // by default detector on null exit / timeout-only, so we use a mock
    // transient detector that always classifies as transient to force a retry
    // path regardless of default heuristics).
    let attempts = 0;
    const exec: ExecFn = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        // Simulate a transient exec error via exception path.
        throw new Error('ETIMEDOUT: transient network glitch');
      }
      // Second attempt would succeed — but abort should prevent it.
      return { code: 0, stdout: 'late', stderr: '' };
    });

    // Abort after 50ms, well inside the 500ms default retry-delay window.
    setTimeout(() => ac.abort(), 50);

    const start = Date.now();
    const result = await resilientExec(exec, 'fake-cli', ['--foo'], {
      signal: ac.signal,
      timeout: 1000,
      // Use default retryDelayMs (500ms). We should exit *before* it elapses.
      // isTransient forced true so the first failure schedules a retry sleep.
      isTransient: () => true,
      maxRetries: 3,
      logWarnings: false,
    });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    // Loop exits within one retry window (500ms + small slack).
    expect(elapsed).toBeLessThan(500);
    // Only the first attempt ran; abort prevented the retry.
    expect(attempts).toBe(1);

    if (!result.ok) {
      expect(result.error.lastError).toBeInstanceOf(Error);
      const classified = classifyExecError(result.error.lastError);
      expect(classified.code).toBe('exec_aborted');
      expect(classified.retryable).toBe(false);
    }
  });

  it('aborted error result has no positive exitCode and is non-transient', async () => {
    const ac = new AbortController();
    ac.abort();

    const exec: ExecFn = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    const result = await resilientExec(exec, 'echo', ['hi'], {
      signal: ac.signal,
      logWarnings: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.exitCode).toBeNull();
      expect(result.error.isTransient).toBe(false);
      expect(result.error.stdout).toBe('');
      expect(result.error.stderr).toBe('');
    }
  });
});
