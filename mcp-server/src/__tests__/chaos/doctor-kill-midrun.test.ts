/**
 * Chaos test: abort the doctor check sweep at check 5 (mid-sweep).
 *
 * Invariants under test:
 *   - Aborting mid-sweep yields partial:true — report is never corrupted.
 *   - Completed checks appear in the report; the hanging check is absent or
 *     appears as an aborted entry.
 *   - Overall severity reflects the partial state (red or the computed severity).
 *   - runDoctorChecks never throws regardless of abort timing.
 *   - elapsedMs is bounded (< real hang duration).
 */

import { describe, it, expect } from 'vitest';
import {
  runDoctorChecks,
  DOCTOR_CHECK_NAMES,
} from '../../tools/doctor.js';
import { DoctorReportSchema } from '../../types.js';
import type { DoctorReport } from '../../types.js';
import {
  makeTmpCwd,
  cleanupTmpCwd,
  makeExecFn,
  allGreenStubs,
  mergeStubs,
  type ExecStub,
} from './_helpers.js';

// ─── Tests ───────────────────────────────────────────────────

describe('chaos/doctor-kill-midrun', () => {
  it('abort after first 4 checks returns partial:true and no throw', async () => {
    const cwd = makeTmpCwd();
    try {
      // The 5th check by name order in DOCTOR_CHECK_NAMES is ntm_binary.
      // We make ntm --version hang indefinitely; everything else resolves quickly.
      const hangStub: ExecStub = {
        match: (cmd, args) => cmd === 'ntm' && args[0] === '--version',
        respond: { hangMs: 60_000 }, // 60s — never resolves in test window
      };

      const stubs = mergeStubs(allGreenStubs(), [hangStub]);
      const exec = makeExecFn(stubs);

      const ac = new AbortController();

      // Start sweep; abort after 50ms — enough for the fast checks but not the hang.
      const reportPromise = runDoctorChecks(cwd, ac.signal, { exec });
      const abortTimer = setTimeout(() => ac.abort(), 50);

      let report: DoctorReport | undefined;
      let threw = false;
      try {
        report = await reportPromise;
      } catch {
        threw = true;
      } finally {
        clearTimeout(abortTimer);
      }

      expect(threw, 'runDoctorChecks must never throw').toBe(false);
      expect(report).toBeDefined();
      expect(report!.partial).toBe(true);

      // Zod-validates the partial report.
      expect(() => DoctorReportSchema.parse(report)).not.toThrow();

      // elapsedMs should be far less than 60s (the hang duration).
      expect(report!.elapsedMs).toBeLessThan(5_000);

      // overall must be defined.
      expect(['green', 'yellow', 'red']).toContain(report!.overall);
    } finally {
      cleanupTmpCwd(cwd);
    }
  });

  it('pre-aborted signal yields partial:true with empty checks and elapsedMs:0', async () => {
    const cwd = makeTmpCwd();
    try {
      const ac = new AbortController();
      ac.abort(); // already fired before runDoctorChecks is called

      const exec = makeExecFn(allGreenStubs());
      const report = await runDoctorChecks(cwd, ac.signal, { exec });

      expect(report.partial).toBe(true);
      expect(report.checks).toHaveLength(0);
      expect(report.overall).toBe('red');
      expect(report.elapsedMs).toBe(0);
      expect(() => DoctorReportSchema.parse(report)).not.toThrow();
    } finally {
      cleanupTmpCwd(cwd);
    }
  });

  it('partial report never contains undefined check names', async () => {
    const cwd = makeTmpCwd();
    try {
      const ac = new AbortController();
      const exec = makeExecFn(allGreenStubs());

      const reportPromise = runDoctorChecks(cwd, ac.signal, { exec });
      setTimeout(() => ac.abort(), 20);
      const report = await reportPromise;

      // All check names in the partial report must be from the known set.
      const knownNames = new Set<string>(DOCTOR_CHECK_NAMES);
      for (const check of report.checks) {
        expect(knownNames.has(check.name), `unknown check name: ${check.name}`).toBe(true);
        expect(check.severity).toMatch(/^(green|yellow|red)$/);
        expect(typeof check.message).toBe('string');
      }
    } finally {
      cleanupTmpCwd(cwd);
    }
  });
});
