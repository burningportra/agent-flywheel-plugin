import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ExecFn } from '../exec.js';
import {
  WorktreePool,
  autoCommitWorktree,
  createWorktree,
  listWorktrees,
  removeWorktree,
} from '../worktree.js';

type ExecResult = { code: number; stdout: string; stderr: string };
type ExecCall = { cmd: string; args: string[]; cwd?: string };

/**
 * Builds a scripted ExecFn that returns canned responses keyed by an
 * argv-prefix match. Calls are recorded in `calls`.
 */
function makeExec(
  scripts: Array<{ matches: (cmd: string, args: string[]) => boolean; result: ExecResult; throws?: Error }>,
): { exec: ExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    const script = scripts.find((s) => s.matches(cmd, args));
    if (!script) {
      return { code: 0, stdout: '', stderr: '' };
    }
    if (script.throws) throw script.throws;
    return script.result;
  };
  return { exec, calls };
}

const argv = (...prefix: string[]) =>
  (cmd: string, args: string[]) =>
    cmd === 'git' && prefix.every((p, i) => args[i] === p);

describe('createWorktree', () => {
  it('returns ok:true when git worktree add succeeds', async () => {
    const { exec, calls } = makeExec([
      { matches: argv('worktree', 'add'), result: { code: 0, stdout: '', stderr: '' } },
    ]);
    const r = await createWorktree(exec, '/repo', 'feat-branch', '/repo/.pi-flywheel/worktrees/step-1');
    expect(r.ok).toBe(true);
    expect(calls[0].args).toEqual(['worktree', 'add', '-b', 'feat-branch', '/repo/.pi-flywheel/worktrees/step-1']);
    expect(calls[0].cwd).toBe('/repo');
  });

  it('returns ok:false with stderr trimmed when add fails (e.g., branch exists)', async () => {
    const { exec } = makeExec([
      { matches: argv('worktree', 'add'), result: { code: 128, stdout: '', stderr: "fatal: A branch named 'feat' already exists.\n" } },
    ]);
    const r = await createWorktree(exec, '/repo', 'feat', '/path');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("fatal: A branch named 'feat' already exists.");
  });

  it('synthesises an error when stderr is empty but exit code non-zero', async () => {
    const { exec } = makeExec([
      { matches: argv('worktree', 'add'), result: { code: 7, stdout: '', stderr: '' } },
    ]);
    const r = await createWorktree(exec, '/repo', 'b', '/p');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/code 7/);
  });

  it('wraps thrown errors in WorktreeResult { ok:false }', async () => {
    const { exec } = makeExec([
      { matches: argv('worktree', 'add'), result: { code: 0, stdout: '', stderr: '' }, throws: new Error('ENOENT git') },
    ]);
    const r = await createWorktree(exec, '/repo', 'b', '/p');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ENOENT git');
  });
});

describe('removeWorktree', () => {
  it('returns ok:true on direct success', async () => {
    const { exec, calls } = makeExec([
      { matches: argv('worktree', 'remove'), result: { code: 0, stdout: '', stderr: '' } },
    ]);
    const r = await removeWorktree(exec, '/repo', '/path');
    expect(r.ok).toBe(true);
    expect(calls[0].args).toEqual(['worktree', 'remove', '--force', '/path']);
  });

  it('falls back to prune when remove fails but directory is already gone', async () => {
    const { exec } = makeExec([
      { matches: argv('worktree', 'remove'), result: { code: 1, stdout: '', stderr: 'missing' } },
      { matches: argv('worktree', 'prune'), result: { code: 0, stdout: '', stderr: '' } },
    ]);
    // existsSync on a path that does NOT exist returns false → success branch
    const r = await removeWorktree(exec, '/repo', '/definitely/does/not/exist/abc123');
    expect(r.ok).toBe(true);
  });
});

describe('listWorktrees', () => {
  it('parses porcelain output and returns the worktree paths', async () => {
    const porcelain = [
      'worktree /repo',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /repo/.pi-flywheel/worktrees/step-1',
      'HEAD def',
      'branch refs/heads/main--worktree-step-1',
      '',
    ].join('\n');
    const { exec } = makeExec([
      { matches: argv('worktree', 'list'), result: { code: 0, stdout: porcelain, stderr: '' } },
    ]);
    const r = await listWorktrees(exec, '/repo');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual(['/repo', '/repo/.pi-flywheel/worktrees/step-1']);
    }
  });

  it('returns ok:false with stderr on git failure', async () => {
    const { exec } = makeExec([
      { matches: argv('worktree', 'list'), result: { code: 128, stdout: '', stderr: 'not a git repo' } },
    ]);
    const r = await listWorktrees(exec, '/repo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not a git repo');
  });
});

describe('autoCommitWorktree', () => {
  it('returns data:false when the worktree is clean', async () => {
    const { exec, calls } = makeExec([
      { matches: argv('status', '--porcelain'), result: { code: 0, stdout: '', stderr: '' } },
    ]);
    const r = await autoCommitWorktree(exec, '/wt', 'msg');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe(false);
    expect(calls).toHaveLength(1); // only status was called
  });

  it('stages and commits when dirty, returning data:true', async () => {
    const { exec, calls } = makeExec([
      { matches: argv('status', '--porcelain'), result: { code: 0, stdout: ' M file.ts\n', stderr: '' } },
      { matches: argv('add', '-A'), result: { code: 0, stdout: '', stderr: '' } },
      { matches: argv('commit', '-m'), result: { code: 0, stdout: '', stderr: '' } },
    ]);
    const r = await autoCommitWorktree(exec, '/wt', 'auto');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe(true);
    expect(calls.map((c) => c.args[0])).toEqual(['status', 'add', 'commit']);
    expect(calls[2].args).toContain('auto');
  });

  it('returns error string when git add fails', async () => {
    const { exec } = makeExec([
      { matches: argv('status', '--porcelain'), result: { code: 0, stdout: ' M f\n', stderr: '' } },
      { matches: argv('add', '-A'), result: { code: 1, stdout: '', stderr: 'permission denied' } },
    ]);
    const r = await autoCommitWorktree(exec, '/wt', 'm');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/git add failed.*permission denied/);
  });
});

describe('WorktreePool', () => {
  let pool: WorktreePool;
  let exec: ExecFn;
  let calls: ExecCall[];

  beforeEach(() => {
    const m = makeExec([
      { matches: argv('worktree', 'add'), result: { code: 0, stdout: '', stderr: '' } },
      { matches: argv('worktree', 'remove'), result: { code: 0, stdout: '', stderr: '' } },
      { matches: argv('branch', '-D'), result: { code: 0, stdout: '', stderr: '' } },
      { matches: argv('worktree', 'prune'), result: { code: 0, stdout: '', stderr: '' } },
    ]);
    exec = m.exec;
    calls = m.calls;
    pool = new WorktreePool(exec, '/repo', 'main');
  });

  it('acquire creates a new worktree and tracks it in state', async () => {
    const r = await pool.acquire(0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toContain('step-0');
    expect(pool.getAll()).toHaveLength(1);
    expect(pool.getAll()[0].stepIndex).toBe(0);
    expect(pool.getAll()[0].branch).toBe('main--worktree-step-0');
  });

  it('acquire is idempotent — second acquire of same step returns existing path without re-creating', async () => {
    const r1 = await pool.acquire(2);
    const callsAfterFirst = calls.length;
    const r2 = await pool.acquire(2);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) expect(r1.data).toBe(r2.data);
    expect(calls.length).toBe(callsAfterFirst); // no additional git calls
  });

  it('release removes the worktree and deletes the branch', async () => {
    await pool.acquire(1);
    const r = await pool.release(1);
    expect(r.ok).toBe(true);
    expect(pool.getAll()).toHaveLength(0);
    expect(calls.some((c) => c.args[0] === 'branch' && c.args[1] === '-D')).toBe(true);
  });

  it('release returns ok:true (no-op) when step was never acquired', async () => {
    const r = await pool.release(42);
    expect(r.ok).toBe(true);
  });

  it('getPath / getBranch return undefined for unknown step indices', () => {
    expect(pool.getPath(99)).toBeUndefined();
    expect(pool.getBranch(99)).toBeUndefined();
  });

  it('getPath returns the acquired path; getBranch returns the derived branch name', async () => {
    await pool.acquire(7);
    expect(pool.getPath(7)).toContain('step-7');
    expect(pool.getBranch(7)).toBe('main--worktree-step-7');
  });

  it('getState returns a deep-copy snapshot (mutation does not affect the pool)', async () => {
    await pool.acquire(0);
    const snap = pool.getState();
    snap.worktrees.push({ path: '/x', branch: 'fake', stepIndex: 99 });
    expect(pool.getAll()).toHaveLength(1);
  });

  it('fromState restores a pool with the same worktree set', async () => {
    await pool.acquire(0);
    await pool.acquire(1);
    const snap = pool.getState();
    const restored = WorktreePool.fromState(exec, snap);
    expect(restored.getAll()).toHaveLength(2);
    expect(restored.getPath(0)).toContain('step-0');
    expect(restored.getPath(1)).toContain('step-1');
  });

  it('cleanup releases all tracked worktrees', async () => {
    await pool.acquire(0);
    await pool.acquire(1);
    await pool.cleanup();
    expect(pool.getAll()).toHaveLength(0);
  });

  it('worktree branch naming uses "--worktree-step-N" with the baseBranch prefix', async () => {
    const slashPool = new WorktreePool(exec, '/repo', 'feature/x');
    await slashPool.acquire(3);
    expect(slashPool.getBranch(3)).toBe('feature/x--worktree-step-3');
  });
});
