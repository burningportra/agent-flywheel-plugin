/**
 * Chaos test: br list returns empty array.
 *
 * Invariants:
 *   - rows: [], totalBeadsConsidered: 0, droppedBeads: 0
 *   - No NaN or divide-by-zero anywhere in the report
 */

import { describe, it, expect } from 'vitest';
import { runCalibrate } from '../../tools/calibrate.js';
import { makeTmpCwd, cleanupTmpCwd, makeExecFn, type ExecStub } from './_helpers.js';

const brEmptyStub: ExecStub = {
  match: (cmd, args) => cmd === 'br' && args[0] === 'list' && args[1] === '--json',
  respond: { result: { code: 0, stdout: '[]', stderr: '' } },
};

describe('chaos/calibrate-empty', () => {
  it('empty br list → rows: [], totalBeadsConsidered: 0, droppedBeads: 0', async () => {
    const cwd = makeTmpCwd();
    try {
      const exec = makeExecFn([brEmptyStub]);
      const signal = new AbortController().signal;

      const report = await runCalibrate({ cwd, sinceDays: 90 }, exec, signal);

      expect(report.rows).toEqual([]);
      expect(report.totalBeadsConsidered).toBe(0);
      expect(report.droppedBeads).toBe(0);
      expect(report.untemplated.count).toBe(0);
    } finally {
      cleanupTmpCwd(cwd);
    }
  });

  it('no NaN or Infinity in any numeric field', async () => {
    const cwd = makeTmpCwd();
    try {
      const exec = makeExecFn([brEmptyStub]);
      const signal = new AbortController().signal;

      const report = await runCalibrate({ cwd, sinceDays: 90 }, exec, signal);

      expect(Number.isNaN(report.totalBeadsConsidered)).toBe(false);
      expect(Number.isNaN(report.droppedBeads)).toBe(false);
      expect(Number.isFinite(report.totalBeadsConsidered)).toBe(true);
      expect(Number.isFinite(report.droppedBeads)).toBe(true);
    } finally {
      cleanupTmpCwd(cwd);
    }
  });

  it('empty list with sinceDays filter still returns valid report', async () => {
    const cwd = makeTmpCwd();
    try {
      const exec = makeExecFn([brEmptyStub]);
      const signal = new AbortController().signal;

      const report = await runCalibrate({ cwd, sinceDays: 7 }, exec, signal);

      expect(report.sinceDays).toBe(7);
      expect(report.rows).toEqual([]);
    } finally {
      cleanupTmpCwd(cwd);
    }
  });
});
