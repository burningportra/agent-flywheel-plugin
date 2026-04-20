import { describe, it, expect } from 'vitest';
import { makeExec } from '../exec.js';
import { classifyExecError } from '../errors.js';

describe('makeExec', () => {
  it('rejects with timeout message when command exceeds timeout', async () => {
    const exec = makeExec();
    await expect(
      exec('sleep', ['10'], { timeout: 100 })
    ).rejects.toThrow(/Timed out after 100ms/);
  });

  it('timeout rejection classifies as exec_timeout', async () => {
    const exec = makeExec();
    try {
      await exec('sleep', ['10'], { timeout: 100 });
      expect.unreachable();
    } catch (err) {
      const classified = classifyExecError(err);
      expect(classified.code).toBe('exec_timeout');
      expect(classified.retryable).toBe(true);
    }
  });

  it('rejects immediately when signal is already aborted', async () => {
    const exec = makeExec();
    const ac = new AbortController();
    ac.abort();

    await expect(
      exec('echo', ['hello'], { signal: ac.signal })
    ).rejects.toThrow(/Aborted/);
  });

  it('pre-aborted signal classifies as exec_aborted', async () => {
    const exec = makeExec();
    const ac = new AbortController();
    ac.abort();

    try {
      await exec('echo', ['hello'], { signal: ac.signal });
      expect.unreachable();
    } catch (err) {
      const classified = classifyExecError(err);
      expect(classified.code).toBe('exec_aborted');
      expect(classified.retryable).toBe(false);
    }
  });

  it('resolves normally for a fast command', async () => {
    const exec = makeExec();
    const result = await exec('echo', ['hi'], { timeout: 5000 });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
  });

  it('passes signal through to child process', async () => {
    const exec = makeExec();
    const ac = new AbortController();

    const promise = exec('sleep', ['10'], { signal: ac.signal, timeout: 5000 });
    setTimeout(() => ac.abort(), 50);

    await expect(promise).rejects.toThrow();
  });
});
