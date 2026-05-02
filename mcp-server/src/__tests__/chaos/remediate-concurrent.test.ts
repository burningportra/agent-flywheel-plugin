/**
 * Chaos test: two concurrent `runRemediate` calls for the same checkName.
 *
 * Invariants:
 *   - Exactly one call wins; the other returns `remediate_already_running`.
 *   - The losing call surfaces the structured-error envelope, never throws.
 *   - After the winner completes, lock is released and a third call succeeds.
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

describe('chaos/remediate-concurrent', () => {
  beforeEach(() => {
    resetMutex();
  });

  it('second concurrent call returns remediate_already_running', async () => {
    const cwd = makeTmpCwd();
    try {
      // Slow build so the race window is real (winner is still running when
      // we fire the second call).
      const slowBuild: ExecStub = {
        match: (cmd, args) => cmd === 'npm' && args[0] === 'run' && args[1] === 'build',
        respond: { hangMs: 200 },
      };
      const exec = makeExecFn([slowBuild]);
      const ac = new AbortController();

      const winner = runRemediate(
        { cwd, checkName: 'dist_drift', autoConfirm: true, mode: 'execute' },
        exec,
        ac.signal,
      );

      // Yield once so the winner acquires the lock before we start the loser.
      await new Promise((r) => setTimeout(r, 20));

      const loser = await runRemediate(
        { cwd, checkName: 'dist_drift', autoConfirm: true, mode: 'execute' },
        exec,
        ac.signal,
      );

      expect('isError' in loser && (loser as { isError: boolean }).isError).toBe(true);
      const errResult = loser as {
        structuredContent: { data: { error: { code: string } } };
      };
      expect(errResult.structuredContent.data.error.code).toBe('remediate_already_running');

      // Winner finishes successfully.
      const winnerResult = await winner;
      expect('check' in winnerResult).toBe(true);
      const ok = winnerResult as { executed: boolean };
      expect(ok.executed).toBe(true);

      // Lock is released afterwards.
      expect(existsSync(join(cwd, LOCK_REL))).toBe(false);

      // A third call now succeeds — no stale lock state.
      const third = await runRemediate(
        { cwd, checkName: 'dist_drift', autoConfirm: true, mode: 'execute' },
        makeExecFn([
          {
            match: (cmd, args) => cmd === 'npm' && args[0] === 'run' && args[1] === 'build',
            respond: { result: { code: 0, stdout: '', stderr: '' } },
          },
        ]),
        new AbortController().signal,
      );
      expect('check' in third).toBe(true);
    } finally {
      cleanupTmpCwd(cwd);
    }
  });

  it('global file lock blocks any second remediation while one is in flight', async () => {
    // Note: the file lock at .pi-flywheel/remediate.lock is global (not
    // per-checkName), so even a different checkName collides while a
    // remediation is in flight. This documents the intentional behavior.
    const cwd = makeTmpCwd();
    try {
      const exec = makeExecFn([
        {
          match: (cmd, args) => cmd === 'npm' && args[0] === 'run' && args[1] === 'build',
          respond: { hangMs: 200 },
        },
        {
          match: (cmd, args) =>
            cmd === 'curl' && args.includes('http://127.0.0.1:8765/health/liveness'),
          respond: { result: { code: 0, stdout: '{"status":"alive"}', stderr: '' } },
        },
        {
          match: (cmd, args) => cmd === 'bash' && args[0] === '-lc',
          respond: { result: { code: 0, stdout: '', stderr: '' } },
        },
        {
          match: (cmd, args) => cmd === 'am' && args[0] === 'doctor',
          respond: { result: { code: 0, stdout: 'ok', stderr: '' } },
        },
      ]);
      const ac = new AbortController();

      const a = runRemediate(
        { cwd, checkName: 'dist_drift', autoConfirm: true, mode: 'execute' },
        exec,
        ac.signal,
      );
      await new Promise((r) => setTimeout(r, 20));

      const b = await runRemediate(
        { cwd, checkName: 'agent_mail_liveness', autoConfirm: true, mode: 'execute' },
        exec,
        ac.signal,
      );
      expect('isError' in b && (b as { isError: boolean }).isError).toBe(true);
      const errResult = b as {
        structuredContent: { data: { error: { code: string } } };
      };
      expect(errResult.structuredContent.data.error.code).toBe('remediate_already_running');

      // After the winner completes, a follow-up call for either checkName
      // proceeds — confirming the global lock is properly released.
      const aResult = await a;
      expect('check' in aResult).toBe(true);

      const followup = await runRemediate(
        { cwd, checkName: 'agent_mail_liveness', autoConfirm: true, mode: 'execute' },
        exec,
        new AbortController().signal,
      );
      expect('check' in followup).toBe(true);
    } finally {
      cleanupTmpCwd(cwd);
    }
  });
});
