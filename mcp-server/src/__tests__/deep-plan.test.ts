import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDeepPlanAgents, writeProfileSnapshot, filterViableResults } from '../deep-plan.js';
import type { ExecFn } from '../exec.js';

/**
 * Capturing exec mock:
 *  - for `claude`: records args and writes a fake plan to stdout
 *  - for `git rev-parse HEAD`: returns a fake HEAD (or fails, per flag)
 *  - for profile collectors (find, git log, grep, head): returns empty/ok
 *  - unrecognized: returns code 1
 */
function makeExec(options: { failProfile?: boolean } = {}): {
  exec: ExecFn;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    if (options.failProfile) {
      // Make every profile-related command fail / throw.
      if (cmd === 'git' || cmd === 'find' || cmd === 'grep' || cmd === 'head') {
        throw new Error('profile failure');
      }
    }
    if (cmd === 'git' && args[0] === 'rev-parse') {
      return { code: 0, stdout: 'deadbeefcafebabe\n', stderr: '' };
    }
    if (cmd === 'git' && args[0] === 'log') {
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'find') {
      return { code: 0, stdout: './src/index.ts\n', stderr: '' };
    }
    if (cmd === 'grep') {
      return { code: 1, stdout: '', stderr: '' };
    }
    if (cmd === 'head') {
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'claude') {
      return { code: 0, stdout: 'fake plan body\n', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'not mocked' };
  };
  return { exec, calls };
}

/** Locate the output dir picked up by the latest runDeepPlanAgents invocation. */
function findLatestOutputDir(): string | null {
  const base = tmpdir();
  const entries = readdirSync(base)
    .filter(n => n.startsWith('claude-deep-plan-'))
    .map(n => join(base, n));
  if (entries.length === 0) return null;
  entries.sort((a, b) => {
    try {
      return (
        Number(b.split('-').pop()) - Number(a.split('-').pop())
      );
    } catch {
      return 0;
    }
  });
  return entries[0];
}

describe('runDeepPlanAgents profile snapshot', () => {
  const createdDirs: string[] = [];

  beforeEach(() => {
    // nothing
  });

  afterEach(() => {
    for (const d of createdDirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('writes profile-snapshot.json before planners run and preamble references its absolute path', async () => {
    const { exec } = makeExec();
    const agents = [
      { name: 'correctness', task: 'Focus on correctness.' },
      { name: 'robustness', task: 'Focus on robustness.' },
    ];

    const results = await runDeepPlanAgents(exec, '/fake/cwd', agents);
    expect(results.length).toBe(2);

    const outDir = findLatestOutputDir();
    expect(outDir).not.toBeNull();
    if (!outDir) return;
    createdDirs.push(outDir);

    const snapshotPath = join(outDir, 'profile-snapshot.json');
    expect(existsSync(snapshotPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    expect(parsed).toHaveProperty('name');
    expect(parsed).toHaveProperty('languages');

    for (const a of agents) {
      const taskPath = join(outDir, `${a.name}-task.md`);
      expect(existsSync(taskPath)).toBe(true);
      const content = readFileSync(taskPath, 'utf8');
      expect(content).toContain(`Shared repo profile available at: ${snapshotPath}`);
      expect(content).toContain('Read it once with the Read tool');
      expect(content).toContain(a.task);
    }
  });

  it('still spawns planners (no throw) when profile collectors all fail', async () => {
    const { exec, calls } = makeExec({ failProfile: true });
    const agents = [{ name: 'solo', task: 'Plan it.' }];

    // Must not throw.
    const results = await runDeepPlanAgents(exec, '/fake/cwd', agents);
    expect(results.length).toBe(1);
    expect(results[0].exitCode).toBe(0);

    const outDir = findLatestOutputDir();
    expect(outDir).not.toBeNull();
    if (!outDir) return;
    createdDirs.push(outDir);

    // Task file exists and contains the original task content.
    const taskPath = join(outDir, 'solo-task.md');
    expect(existsSync(taskPath)).toBe(true);
    const taskContent = readFileSync(taskPath, 'utf8');
    expect(taskContent).toContain('Plan it.');

    // Claude was still invoked.
    expect(calls.some(c => c.cmd === 'claude')).toBe(true);
  });

  it('writeProfileSnapshot returns null when the snapshot cannot be written', async () => {
    const { exec } = makeExec();
    // Pass an outputDir that is not writable (under a file path, not a dir).
    const bogusDir = join(tmpdir(), `deep-plan-bogus-${Date.now()}`, 'nested', 'does-not-exist');
    // writeFileSync will throw ENOENT; writeProfileSnapshot must catch and return null.
    const result = await writeProfileSnapshot(exec, '/fake/cwd', bogusDir);
    expect(result).toBeNull();
  });
});

describe('runDeepPlanAgents failure handling', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const d of createdDirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('timed-out agent is excluded and successful agent output is returned', async () => {
    // One agent succeeds, one throws (simulating timeout)
    let callCount = 0;
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'deadbeef\n', stderr: '' };
      if (cmd === 'git' && args[0] === 'log') return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'find') return { code: 0, stdout: './src/index.ts\n', stderr: '' };
      if (cmd === 'grep') return { code: 1, stdout: '', stderr: '' };
      if (cmd === 'head') return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'claude') {
        callCount += 1;
        if (callCount === 1) return { code: 0, stdout: 'successful plan output\n', stderr: '' };
        throw new Error('timeout');
      }
      return { code: 1, stdout: '', stderr: 'not mocked' };
    };

    const agents = [
      { name: 'correctness', task: 'Focus on correctness.' },
      { name: 'robustness', task: 'Focus on robustness.' },
    ];

    const results = await runDeepPlanAgents(exec, '/fake/cwd', agents);
    const outDir = findLatestOutputDir();
    if (outDir) createdDirs.push(outDir);

    // Only the successful agent should be in the results
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('correctness');
    expect(results[0].plan).toContain('successful plan output');
  });

  it('all-timeout returns empty array without throwing', async () => {
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'deadbeef\n', stderr: '' };
      if (cmd === 'git' && args[0] === 'log') return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'find') return { code: 0, stdout: './src/index.ts\n', stderr: '' };
      if (cmd === 'grep') return { code: 1, stdout: '', stderr: '' };
      if (cmd === 'head') return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'claude') throw new Error('timeout');
      return { code: 1, stdout: '', stderr: 'not mocked' };
    };

    const agents = [
      { name: 'agent-a', task: 'Plan A.' },
      { name: 'agent-b', task: 'Plan B.' },
    ];

    // Must not throw; returns empty array
    const results = await runDeepPlanAgents(exec, '/fake/cwd', agents);
    const outDir = findLatestOutputDir();
    if (outDir) createdDirs.push(outDir);

    expect(results).toEqual([]);
  });

  it('1-of-2 failure returns only the successful result', async () => {
    let claudeCallCount = 0;
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'deadbeef\n', stderr: '' };
      if (cmd === 'git' && args[0] === 'log') return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'find') return { code: 0, stdout: './src/index.ts\n', stderr: '' };
      if (cmd === 'grep') return { code: 1, stdout: '', stderr: '' };
      if (cmd === 'head') return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'claude') {
        claudeCallCount += 1;
        if (claudeCallCount === 1) return { code: 0, stdout: 'viable plan\n', stderr: '' };
        return { code: 1, stdout: '', stderr: 'agent failed' };
      }
      return { code: 1, stdout: '', stderr: 'not mocked' };
    };

    const agents = [
      { name: 'winner', task: 'Plan winner.' },
      { name: 'loser', task: 'Plan loser.' },
    ];

    const results = await runDeepPlanAgents(exec, '/fake/cwd', agents);
    const outDir = findLatestOutputDir();
    if (outDir) createdDirs.push(outDir);

    expect(results.length).toBe(1);
    expect(results[0].name).toBe('winner');
    expect(results[0].plan).toBe('viable plan');
  });
});
