/**
 * Unit tests for cli-exec.ts (bead claude-orchestrator-s2is).
 *
 * Covers resilientExec retry logic, br structured-error parsing,
 * transient classification, and the telemetry side-channel hook.
 *
 * Uses vi.useFakeTimers for retry-backoff sleeps to keep tests fast.
 * Abort/cancellation paths live in cli-exec.abort.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExecFn } from '../exec.js';
import {
  brExec,
  brExecJson,
  isTransientBrError,
  registerCliExecTelemetryHook,
  resilientExec,
} from '../cli-exec.js';

beforeEach(() => {
  vi.useFakeTimers();
  // Reset telemetry hook between tests.
  registerCliExecTelemetryHook(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

function mockExec(results: Array<{ code: number; stdout?: string; stderr?: string } | Error>): ExecFn {
  let i = 0;
  return vi.fn(async () => {
    const next = results[i++];
    if (next instanceof Error) throw next;
    return { code: next.code, stdout: next.stdout ?? '', stderr: next.stderr ?? '' };
  }) as unknown as ExecFn;
}

describe('resilientExec — happy path', () => {
  it('returns ok:true with raw output on first-attempt success', async () => {
    const exec = mockExec([{ code: 0, stdout: 'hello', stderr: '' }]);
    const p = resilientExec(exec, 'echo', ['hi'], { logWarnings: false });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.code).toBe(0);
      expect(result.value.stdout).toBe('hello');
    }
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on a successful first attempt', async () => {
    const exec = mockExec([{ code: 0, stdout: 'ok' }]);
    const p = resilientExec(exec, 'cmd', [], { maxRetries: 3, logWarnings: false });
    await vi.runAllTimersAsync();
    await p;
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('resilientExec — retry on transient', () => {
  it('retries up to maxRetries on transient (timeout) error and succeeds on 2nd attempt', async () => {
    const exec = mockExec([
      new Error('Timed out after 1000ms'),
      { code: 0, stdout: 'recovered', stderr: '' },
    ]);
    const p = resilientExec(exec, 'br', ['list'], { maxRetries: 2, retryDelayMs: 50, logWarnings: false });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('returns structured error after exhausting retries on persistent transient failures', async () => {
    const exec = mockExec([
      new Error('ETIMEDOUT'),
      new Error('ETIMEDOUT'),
      new Error('ETIMEDOUT'),
    ]);
    const p = resilientExec(exec, 'br', ['list'], { maxRetries: 2, retryDelayMs: 10, logWarnings: false });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.attempts).toBe(3); // initial + 2 retries
      expect(result.error.isTransient).toBe(true);
    }
    expect(exec).toHaveBeenCalledTimes(3);
  });
});

describe('resilientExec — permanent failure (no retry)', () => {
  it('fails immediately on ENOENT (CLI missing)', async () => {
    const exec = mockExec([new Error('spawn br ENOENT')]);
    const p = resilientExec(exec, 'br', ['list'], {
      maxRetries: 3,
      retryDelayMs: 10,
      isTransient: (_c, _s, err) => {
        const msg = err instanceof Error ? err.message : '';
        return !msg.includes('ENOENT');
      },
      logWarnings: false,
    });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.attempts).toBe(1);
      expect(result.error.isTransient).toBe(false);
    }
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('non-retryable non-zero exit code is returned as ok:false without retry', async () => {
    const exec = mockExec([{ code: 2, stdout: '', stderr: 'permanent failure' }]);
    const p = resilientExec(exec, 'br', ['x'], {
      maxRetries: 3,
      retryDelayMs: 10,
      isTransient: () => false,
      logWarnings: false,
    });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.exitCode).toBe(2);
      expect(result.error.attempts).toBe(1);
    }
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('resilientExec — BrStructuredError parsing', () => {
  it('parses a structured br JSON error from stderr and surfaces it in error.brError', async () => {
    const errPayload = JSON.stringify({
      error: { code: 'DATABASE_ERROR', message: 'database is busy', retryable: false },
    });
    const exec = mockExec([{ code: 1, stdout: '', stderr: errPayload }]);
    const p = brExec(exec, ['update', 'bd-1'], { maxRetries: 0, logWarnings: false });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.brError?.code).toBe('DATABASE_ERROR');
      expect(result.error.brError?.message).toBe('database is busy');
    }
  });

  it('treats br DATABASE_ERROR with "database is busy" as transient (retries despite retryable=false)', () => {
    const stderr = JSON.stringify({
      error: { code: 'DATABASE_ERROR', message: 'database is busy', retryable: false },
    });
    expect(isTransientBrError(1, stderr, null)).toBe(true);
  });

  it('treats explicit retryable=true in structured br error as transient', () => {
    const stderr = JSON.stringify({
      error: { code: 'SOME_RACE', message: 'try again', retryable: true },
    });
    expect(isTransientBrError(2, stderr, null)).toBe(true);
  });
});

describe('isTransientBrError — classification rules', () => {
  it('ENOENT is permanent', () => {
    expect(isTransientBrError(null, '', new Error('spawn ENOENT'))).toBe(false);
  });

  it('null exit code (signal kill) is transient', () => {
    expect(isTransientBrError(null, '', null)).toBe(true);
  });

  it('exit code 1 + empty stderr is transient (suspected DB race)', () => {
    expect(isTransientBrError(1, '   ', null)).toBe(true);
  });

  it('exit code > 1 with no structured payload is permanent', () => {
    expect(isTransientBrError(2, 'plain error', null)).toBe(false);
  });

  it('timeout message is transient', () => {
    expect(isTransientBrError(null, '', new Error('Timed out after 1000ms'))).toBe(true);
  });
});

describe('resilientExec — telemetry hook', () => {
  it('fires the telemetry hook on permanent failure', async () => {
    const codes: string[] = [];
    registerCliExecTelemetryHook((code) => codes.push(code));
    const exec = mockExec([{ code: 2, stdout: '', stderr: 'fatal' }]);
    const p = resilientExec(exec, 'br', ['x'], {
      maxRetries: 0,
      isTransient: () => false,
      logWarnings: false,
    });
    await vi.runAllTimersAsync();
    await p;
    expect(codes.length).toBe(1);
    // Code maps from classifyExecError; non-zero exit with default exec error → cli_failure family.
    expect(['cli_failure', 'exec_timeout', 'exec_aborted']).toContain(codes[0]);
  });

  it('does NOT fire telemetry on successful exec', async () => {
    let fired = 0;
    registerCliExecTelemetryHook(() => fired++);
    const exec = mockExec([{ code: 0, stdout: 'ok', stderr: '' }]);
    const p = resilientExec(exec, 'cmd', [], { logWarnings: false });
    await vi.runAllTimersAsync();
    await p;
    expect(fired).toBe(0);
  });

  it('swallows telemetry-hook exceptions (never propagates)', async () => {
    registerCliExecTelemetryHook(() => {
      throw new Error('telemetry boom');
    });
    const exec = mockExec([{ code: 1, stdout: '', stderr: 'plain' }]);
    const p = resilientExec(exec, 'cmd', [], {
      maxRetries: 0,
      isTransient: () => false,
      logWarnings: false,
    });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
  });
});

describe('brExecJson — JSON parsing wrapper', () => {
  it('returns parsed JSON value on success', async () => {
    const exec = mockExec([{ code: 0, stdout: '{"k":42}', stderr: '' }]);
    const p = brExecJson<{ k: number }>(exec, ['list'], { maxRetries: 0, logWarnings: false });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.k).toBe(42);
  });

  it('returns ok:false with parse error when stdout is malformed JSON', async () => {
    const exec = mockExec([{ code: 0, stdout: 'not json', stderr: '' }]);
    const p = brExecJson(exec, ['list'], { maxRetries: 0, logWarnings: false });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stderr).toMatch(/JSON parse error/);
      expect(result.error.isTransient).toBe(false);
    }
  });

  it('uses custom validator when provided', async () => {
    const exec = mockExec([{ code: 0, stdout: 'raw text', stderr: '' }]);
    const p = brExecJson<string>(exec, ['x'], {
      maxRetries: 0,
      logWarnings: false,
      validator: (raw) => (raw.length > 0 ? { ok: true, data: raw } : { ok: false, error: 'empty' }),
    });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('raw text');
  });

  it('validator failure surfaces as a permanent error', async () => {
    const exec = mockExec([{ code: 0, stdout: '', stderr: '' }]);
    const p = brExecJson(exec, ['x'], {
      maxRetries: 0,
      logWarnings: false,
      validator: () => ({ ok: false, error: 'invalid shape' }),
    });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.stderr).toMatch(/invalid shape/);
  });
});
