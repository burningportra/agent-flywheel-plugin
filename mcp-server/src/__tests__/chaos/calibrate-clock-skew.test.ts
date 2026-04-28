/**
 * Chaos test: all input rows have closed_ts < created_ts (clock-skewed).
 *
 * Invariants:
 *   - rows: []
 *   - droppedBeads === input.length
 *   - No throw
 */

import { describe, it, expect } from 'vitest';
import { runCalibrate } from '../../tools/calibrate.js';
import { makeTmpCwd, cleanupTmpCwd, makeExecFn, type ExecStub } from './_helpers.js';

// Must be recent so the sinceDays filter includes these beads
const CREATED_TS = new Date(Date.now() - 5 * 86_400_000).toISOString();

function makeSkewedBead(id: string) {
  return {
    id,
    title: `Skewed ${id}`,
    status: 'closed',
    template: 'add-api-endpoint',
    created_ts: CREATED_TS,
    // closed 1 hour BEFORE created — negative duration
    closed_ts: new Date(new Date(CREATED_TS).getTime() - 3600_000).toISOString(),
  };
}

const SKEWED_INPUT = Array.from({ length: 8 }, (_, i) => makeSkewedBead(`sk-${i}`));

function makeBrStub(beads: object[]): ExecStub {
  return {
    match: (cmd, args) => cmd === 'br' && args[0] === 'list' && args[1] === '--json',
    respond: { result: { code: 0, stdout: JSON.stringify(beads), stderr: '' } },
  };
}

const gitNoMatchStub: ExecStub = {
  match: (cmd, args) => cmd === 'git' && args[0] === 'log',
  respond: { result: { code: 0, stdout: '', stderr: '' } },
};

describe('chaos/calibrate-clock-skew', () => {
  it('all skewed beads → rows: [], droppedBeads === input length', async () => {
    const cwd = makeTmpCwd();
    try {
      const exec = makeExecFn([makeBrStub(SKEWED_INPUT), gitNoMatchStub]);
      const signal = new AbortController().signal;

      const report = await runCalibrate({ cwd, sinceDays: 90 }, exec, signal);

      expect(report.rows).toEqual([]);
      expect(report.droppedBeads).toBe(SKEWED_INPUT.length);
    } finally {
      cleanupTmpCwd(cwd);
    }
  });

  it('does not throw on all-skewed input', async () => {
    const cwd = makeTmpCwd();
    try {
      const exec = makeExecFn([makeBrStub(SKEWED_INPUT), gitNoMatchStub]);
      const signal = new AbortController().signal;

      await expect(runCalibrate({ cwd, sinceDays: 90 }, exec, signal)).resolves.not.toThrow();
    } finally {
      cleanupTmpCwd(cwd);
    }
  });

  it('totalBeadsConsidered equals number of in-window skewed beads', async () => {
    const cwd = makeTmpCwd();
    try {
      const exec = makeExecFn([makeBrStub(SKEWED_INPUT), gitNoMatchStub]);
      const signal = new AbortController().signal;

      const report = await runCalibrate({ cwd, sinceDays: 90 }, exec, signal);

      // All are in-window (created recently enough) — skewed are dropped, not filtered
      expect(report.totalBeadsConsidered).toBe(SKEWED_INPUT.length);
      expect(report.droppedBeads).toBe(SKEWED_INPUT.length);
    } finally {
      cleanupTmpCwd(cwd);
    }
  });

  it('single skewed bead + 1 valid bead → droppedBeads: 1, rows: 1', async () => {
    const cwd = makeTmpCwd();
    try {
      const validBead = {
        id: 'valid-0',
        title: 'Valid',
        status: 'closed',
        template: 'add-api-endpoint',
        created_ts: CREATED_TS,
        closed_ts: new Date(new Date(CREATED_TS).getTime() + 60 * 60_000).toISOString(),
      };
      const exec = makeExecFn([makeBrStub([makeSkewedBead('only-skew'), validBead]), gitNoMatchStub]);
      const signal = new AbortController().signal;

      const report = await runCalibrate({ cwd, sinceDays: 90 }, exec, signal);

      expect(report.droppedBeads).toBe(1);
      expect(report.rows).toHaveLength(1);
    } finally {
      cleanupTmpCwd(cwd);
    }
  });
});
