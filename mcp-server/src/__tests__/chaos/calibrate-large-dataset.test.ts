/**
 * Chaos test: 5000 synthetic beads.
 *
 * Invariants:
 *   - Completes in <8s
 *   - Report is structurally valid
 *   - No NaN or Infinity in numeric fields
 */

import { describe, it, expect } from 'vitest';
import { runCalibrate } from '../../tools/calibrate.js';
import { makeTmpCwd, cleanupTmpCwd, makeExecFn, type ExecStub } from './_helpers.js';

// Use a base 30 days ago so all beads fall within sinceDays: 90
const CREATED_TS_BASE = Date.now() - 30 * 86_400_000;

function makeBeads(count: number) {
  return Array.from({ length: count }, (_, i) => {
    // spread over 30 days worth of minutes; each bead 1 min apart (stays in-window)
    const createdMs = CREATED_TS_BASE + (i % (30 * 24 * 60)) * 60_000;
    const closedMs = createdMs + (30 + (i % 120)) * 60_000; // 30–149 min duration
    return {
      id: `large-${i}`,
      title: `Large bead ${i}`,
      status: 'closed',
      template: i % 5 === 0 ? 'refactor-module' : 'add-api-endpoint',
      created_ts: new Date(createdMs).toISOString(),
      closed_ts: new Date(closedMs).toISOString(),
    };
  });
}

const BEAD_COUNT = 5000;
const BEADS = makeBeads(BEAD_COUNT);

const brStub: ExecStub = {
  match: (cmd, args) => cmd === 'br' && args[0] === 'list' && args[1] === '--json',
  respond: { result: { code: 0, stdout: JSON.stringify(BEADS), stderr: '' } },
};

// Git fanout cap is 200 — after that, proxy_started = true without git calls
const gitNoMatchStub: ExecStub = {
  match: (cmd, args) => cmd === 'git' && args[0] === 'log',
  respond: { result: { code: 0, stdout: '', stderr: '' } },
};

describe('chaos/calibrate-large-dataset', () => {
  it('5000 beads complete in <8s', async () => {
    const cwd = makeTmpCwd();
    try {
      const exec = makeExecFn([brStub, gitNoMatchStub]);
      const signal = new AbortController().signal;

      const start = performance.now();
      const report = await runCalibrate({ cwd, sinceDays: 365 }, exec, signal);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(8000);
      expect(report).toBeDefined();
    } finally {
      cleanupTmpCwd(cwd);
    }
  }, 10_000);

  it('report is structurally valid for large dataset', async () => {
    const cwd = makeTmpCwd();
    try {
      const exec = makeExecFn([brStub, gitNoMatchStub]);
      const signal = new AbortController().signal;

      const report = await runCalibrate({ cwd, sinceDays: 365 }, exec, signal);

      expect(typeof report.totalBeadsConsidered).toBe('number');
      expect(typeof report.droppedBeads).toBe('number');
      expect(Array.isArray(report.rows)).toBe(true);
      expect(report.rows.length).toBeGreaterThan(0);
    } finally {
      cleanupTmpCwd(cwd);
    }
  }, 10_000);

  it('no NaN or Infinity in numeric fields for large dataset', async () => {
    const cwd = makeTmpCwd();
    try {
      const exec = makeExecFn([brStub, gitNoMatchStub]);
      const signal = new AbortController().signal;

      const report = await runCalibrate({ cwd, sinceDays: 365 }, exec, signal);

      expect(Number.isNaN(report.totalBeadsConsidered)).toBe(false);
      expect(Number.isNaN(report.droppedBeads)).toBe(false);

      for (const row of report.rows) {
        expect(Number.isNaN(row.meanMinutes)).toBe(false);
        expect(Number.isNaN(row.medianMinutes)).toBe(false);
        expect(Number.isNaN(row.p95Minutes)).toBe(false);
        expect(Number.isNaN(row.ratio)).toBe(false);
        expect(Number.isFinite(row.meanMinutes)).toBe(true);
        expect(Number.isFinite(row.ratio)).toBe(true);
      }
    } finally {
      cleanupTmpCwd(cwd);
    }
  }, 10_000);

  it('git fanout cap: only 200 git calls issued for 5000 beads', async () => {
    const cwd = makeTmpCwd();
    try {
      let gitCallCount = 0;
      const countingGitStub: ExecStub = {
        match: (cmd, args) => cmd === 'git' && args[0] === 'log',
        respond: { result: { code: 0, stdout: '', stderr: '' } },
      };

      const exec = makeExecFn([brStub, countingGitStub]);
      // Wrap to count git log calls
      const countingExec: typeof exec = async (cmd, args, opts) => {
        if (cmd === 'git' && args[0] === 'log') gitCallCount++;
        return exec(cmd, args, opts);
      };

      const signal = new AbortController().signal;
      await runCalibrate({ cwd, sinceDays: 365 }, countingExec, signal);

      // GIT_FANOUT_CAP = 200
      expect(gitCallCount).toBeLessThanOrEqual(200);
    } finally {
      cleanupTmpCwd(cwd);
    }
  }, 10_000);
});
