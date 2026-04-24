/**
 * Chaos test: doctor running on a system with missing CLI dependencies.
 *
 * Invariants under test:
 *   - cm absent (CASS — optional) → yellow row, no throw, other checks still complete.
 *   - bv absent (optional) → yellow row.
 *   - br absent (required) → red row.
 *   - All three absence cases produce a Zod-valid DoctorReport.
 *   - Overall severity escalates correctly (yellow vs red).
 */
import { describe, it, expect } from 'vitest';
import { runDoctorChecks } from '../../tools/doctor.js';
import { DoctorReportSchema } from '../../types.js';
import { makeTmpCwd, cleanupTmpCwd, makeExecFn, allGreenStubs, mergeStubs, } from './_helpers.js';
// ─── Helpers ─────────────────────────────────────────────────
function enoentFor(binary) {
    return {
        match: (cmd, args) => cmd === binary && args[0] === '--version',
        respond: { throws: Object.assign(new Error(`spawn ${binary} ENOENT`), { code: 'ENOENT' }) },
    };
}
// ─── Tests ───────────────────────────────────────────────────
describe('chaos/missing-gemini (missing CLI deps)', () => {
    it('cm absent → yellow row, no throw, other checks still complete', async () => {
        const cwd = makeTmpCwd();
        try {
            const stubs = mergeStubs(allGreenStubs(), [enoentFor('cm')]);
            const exec = makeExecFn(stubs);
            const report = await runDoctorChecks(cwd, undefined, { exec });
            expect(() => DoctorReportSchema.parse(report)).not.toThrow();
            expect(report.partial).toBe(false);
            const cmRow = report.checks.find((c) => c.name === 'cm_binary');
            expect(cmRow).toBeDefined();
            // cm is optional (CASS) — should be yellow, not red.
            expect(cmRow.severity).toBe('yellow');
            // Other checks that we stubbed green should still succeed.
            const brRow = report.checks.find((c) => c.name === 'br_binary');
            expect(brRow).toBeDefined();
            expect(brRow.severity).toBe('green');
            // Overall must be at most yellow (no red).
            expect(report.overall).not.toBe('red');
            expect(['green', 'yellow']).toContain(report.overall);
        }
        finally {
            cleanupTmpCwd(cwd);
        }
    });
    it('bv absent → yellow row (optional dep)', async () => {
        const cwd = makeTmpCwd();
        try {
            const stubs = mergeStubs(allGreenStubs(), [enoentFor('bv')]);
            const exec = makeExecFn(stubs);
            const report = await runDoctorChecks(cwd, undefined, { exec });
            expect(() => DoctorReportSchema.parse(report)).not.toThrow();
            const bvRow = report.checks.find((c) => c.name === 'bv_binary');
            expect(bvRow).toBeDefined();
            expect(bvRow.severity).toBe('yellow');
            // Overall must be at most yellow.
            expect(['green', 'yellow']).toContain(report.overall);
        }
        finally {
            cleanupTmpCwd(cwd);
        }
    });
    it('br absent → red row (required dep)', async () => {
        const cwd = makeTmpCwd();
        try {
            const stubs = mergeStubs(allGreenStubs(), [enoentFor('br')]);
            const exec = makeExecFn(stubs);
            const report = await runDoctorChecks(cwd, undefined, { exec });
            expect(() => DoctorReportSchema.parse(report)).not.toThrow();
            const brRow = report.checks.find((c) => c.name === 'br_binary');
            expect(brRow).toBeDefined();
            expect(brRow.severity).toBe('red');
            // Overall must escalate to red.
            expect(report.overall).toBe('red');
        }
        finally {
            cleanupTmpCwd(cwd);
        }
    });
    it('no missing deps → all rows green, overall green', async () => {
        const cwd = makeTmpCwd();
        try {
            const exec = makeExecFn(allGreenStubs());
            const report = await runDoctorChecks(cwd, undefined, {
                exec,
                codexConfigPath: null,
            });
            expect(() => DoctorReportSchema.parse(report)).not.toThrow();
            expect(report.overall).toBe('green');
            for (const check of report.checks) {
                expect(check.severity).toBe('green');
            }
        }
        finally {
            cleanupTmpCwd(cwd);
        }
    });
});
//# sourceMappingURL=missing-gemini.test.js.map