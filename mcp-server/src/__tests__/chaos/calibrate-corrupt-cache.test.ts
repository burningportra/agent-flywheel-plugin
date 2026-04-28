/**
 * Chaos test: pre-existing .pi-flywheel/calibration.json is malformed JSON.
 *
 * Invariants:
 *   - Tool does not throw
 *   - The corrupt file is overwritten with valid JSON
 *   - Report is structurally valid
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCalibrate } from '../../tools/calibrate.js';
import { makeTmpCwd, cleanupTmpCwd, makeExecFn, type ExecStub } from './_helpers.js';

// Must be recent so the sinceDays filter includes this bead
const CREATED_TS = new Date(Date.now() - 5 * 86_400_000).toISOString();

function seedCorruptCache(cwd: string): string {
  const dir = join(cwd, '.pi-flywheel');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'calibration.json');
  writeFileSync(filePath, '{ this is not valid json !!!', 'utf8');
  return filePath;
}

const brStub: ExecStub = {
  match: (cmd, args) => cmd === 'br' && args[0] === 'list' && args[1] === '--json',
  respond: {
    result: {
      code: 0,
      stdout: JSON.stringify([
        {
          id: 'bead-cc-0',
          title: 'Cache test bead',
          status: 'closed',
          template: 'add-api-endpoint',
          created_ts: CREATED_TS,
          closed_ts: new Date(new Date(CREATED_TS).getTime() + 60 * 60_000).toISOString(),
        },
      ]),
      stderr: '',
    },
  },
};

const gitNoMatchStub: ExecStub = {
  match: (cmd, args) => cmd === 'git' && args[0] === 'log',
  respond: { result: { code: 0, stdout: '', stderr: '' } },
};

describe('chaos/calibrate-corrupt-cache', () => {
  it('corrupt calibration.json → tool does not throw', async () => {
    const cwd = makeTmpCwd();
    try {
      seedCorruptCache(cwd);
      const exec = makeExecFn([brStub, gitNoMatchStub]);
      const signal = new AbortController().signal;

      await expect(runCalibrate({ cwd, sinceDays: 90 }, exec, signal)).resolves.toBeDefined();
    } finally {
      cleanupTmpCwd(cwd);
    }
  });

  it('corrupt calibration.json is overwritten with valid JSON', async () => {
    const cwd = makeTmpCwd();
    try {
      const cachePath = seedCorruptCache(cwd);
      const exec = makeExecFn([brStub, gitNoMatchStub]);
      const signal = new AbortController().signal;

      await runCalibrate({ cwd, sinceDays: 90 }, exec, signal);

      const written = readFileSync(cachePath, 'utf8');
      expect(() => JSON.parse(written)).not.toThrow();
    } finally {
      cleanupTmpCwd(cwd);
    }
  });

  it('report returned by tool is structurally valid after corrupt cache', async () => {
    const cwd = makeTmpCwd();
    try {
      seedCorruptCache(cwd);
      const exec = makeExecFn([brStub, gitNoMatchStub]);
      const signal = new AbortController().signal;

      const report = await runCalibrate({ cwd, sinceDays: 90 }, exec, signal);

      expect(typeof report.cwd).toBe('string');
      expect(typeof report.sinceDays).toBe('number');
      expect(typeof report.generatedAt).toBe('string');
      expect(Array.isArray(report.rows)).toBe(true);
      expect(typeof report.totalBeadsConsidered).toBe('number');
      expect(typeof report.droppedBeads).toBe('number');
      expect(typeof report.untemplated.count).toBe('number');
    } finally {
      cleanupTmpCwd(cwd);
    }
  });

  it('completely missing .pi-flywheel dir → creates it and writes report', async () => {
    const cwd = makeTmpCwd();
    try {
      // No .pi-flywheel dir — it shouldn't exist from makeTmpCwd
      const exec = makeExecFn([brStub, gitNoMatchStub]);
      const signal = new AbortController().signal;

      const report = await runCalibrate({ cwd, sinceDays: 90 }, exec, signal);

      const written = readFileSync(join(cwd, '.pi-flywheel', 'calibration.json'), 'utf8');
      const parsed = JSON.parse(written);
      expect(parsed.cwd).toBe(report.cwd);
    } finally {
      cleanupTmpCwd(cwd);
    }
  });
});
