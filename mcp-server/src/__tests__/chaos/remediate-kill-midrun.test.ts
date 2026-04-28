/**
 * Chaos test: abort `runRemediate` mid-execute and verify the lock file is
 * cleaned up so a follow-up call succeeds.
 *
 * Invariants:
 *   - Aborting during handler.execute releases the in-process mutex AND
 *     unlinks `.pi-flywheel/remediate.lock`.
 *   - A second call after abort completes successfully (no stale lock).
 *   - The first call's result is a `remediation_failed` envelope (caught by
 *     the dispatcher's execute try/catch) — not a thrown promise.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { runRemediate } from '../../tools/remediate.js';
import { _resetForTest as resetMutex } from '../../mutex.js';
import {
  makeTmpCwd,
  cleanupTmpCwd,
  makeExecFn,
  type ExecStub,
} from './_helpers.js';

const LOCK_REL = join('.pi-flywheel', 'remediate.lock');

describe('chaos/remediate-kill-midrun', () => {
  beforeEach(() => {
    resetMutex();
  });

  it('aborting mid-execute cleans up lock; subsequent call succeeds', async () => {
    const cwd = makeTmpCwd();
    try {
      // dist_drift.execute runs `npm run build`. Make it hang so we can abort.
      const hangBuild: ExecStub = {
        match: (cmd, args) => cmd === 'npm' && args[0] === 'run' && args[1] === 'build',
        respond: { hangMs: 60_000 },
      };
      const exec = makeExecFn([hangBuild]);

      const ac = new AbortController();
      const inflight = runRemediate(
        { cwd, checkName: 'dist_drift', autoConfirm: true, mode: 'execute' },
        exec,
        ac.signal,
      );

      // Give the dispatcher time to acquire the lock and call handler.execute.
      await new Promise((r) => setTimeout(r, 30));

      // Lock should exist on disk while execute is in-flight.
      expect(existsSync(join(cwd, LOCK_REL))).toBe(true);

      ac.abort();

      const result = await inflight;
      // Dispatcher catches the abort throw and returns the envelope.
      expect('isError' in result && (result as { isError: boolean }).isError).toBe(true);
      const errResult = result as {
        structuredContent: { data: { error: { code: string; details?: { stage?: string } } } };
      };
      expect(errResult.structuredContent.data.error.code).toBe('remediation_failed');
      expect(errResult.structuredContent.data.error.details?.stage).toBe('execute');

      // Lock must be released on disk after the dispatcher's finally block.
      expect(existsSync(join(cwd, LOCK_REL))).toBe(false);

      // A second call (now that the abort is settled) should not be blocked
      // by `remediate_already_running` — i.e. no stale in-process mutex.
      const okExec = makeExecFn([
        {
          match: (cmd, args) => cmd === 'npm' && args[0] === 'run' && args[1] === 'build',
          respond: { result: { code: 0, stdout: 'built', stderr: '' } },
        },
      ]);
      const ac2 = new AbortController();
      const followup = await runRemediate(
        { cwd, checkName: 'dist_drift', autoConfirm: true, mode: 'execute' },
        okExec,
        ac2.signal,
      );
      expect('check' in followup).toBe(true);
      const ok = followup as { executed: boolean; mode: string };
      expect(ok.mode).toBe('execute');
      expect(ok.executed).toBe(true);

      // And the lock is cleaned up after the successful call as well.
      expect(existsSync(join(cwd, LOCK_REL))).toBe(false);
    } finally {
      cleanupTmpCwd(cwd);
    }
  });

  it('pre-aborted signal during execute is caught and lock is cleaned up', async () => {
    const cwd = makeTmpCwd();
    try {
      const exec = makeExecFn([
        {
          match: (cmd) => cmd === 'npm',
          respond: { throws: new Error('Aborted') },
        },
      ]);
      const ac = new AbortController();
      ac.abort();

      const result = await runRemediate(
        { cwd, checkName: 'dist_drift', autoConfirm: true, mode: 'execute' },
        exec,
        ac.signal,
      );

      // Either the handler throws (→ remediation_failed envelope) or the
      // exec stub throws — either way no thrown promise, no stale lock.
      expect('isError' in result && (result as { isError: boolean }).isError).toBe(true);
      expect(existsSync(join(cwd, LOCK_REL))).toBe(false);
    } finally {
      cleanupTmpCwd(cwd);
    }
  });
});
