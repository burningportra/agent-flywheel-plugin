/**
 * Doctor `outcome_rubric_validity` round-trip (T16 / claude-orchestrator-23f).
 *
 * Builds a real on-disk checkpoint + rubric.md inside a tmpdir, runs the
 * production `runDoctorChecks` sweep, and asserts the row's severity,
 * message, and verbatim hint match the synthesized plan §"Doctor — Hint
 * strings" / §"Doctor — Message strings" tables.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runDoctorChecks } from '../tools/doctor.js';
import { CHECKPOINT_DIR, CHECKPOINT_FILE, } from '../checkpoint.js';
import { VERSION } from '../version.js';
const GREEN_HINT = 'No action needed; continue the flywheel.';
const YELLOW_HINT = 'Open the rubric gate and choose Re-edit or Regenerate before creating beads.';
const RED_HINT = 'Regenerate the rubric now; an empty criteria list cannot grade the cycle.';
function writeCheckpointWithState(dir, state) {
    const ckptDir = join(dir, CHECKPOINT_DIR);
    mkdirSync(ckptDir, { recursive: true });
    const stateHash = createHash('sha256')
        .update(JSON.stringify(state))
        .digest('hex');
    const envelope = {
        schemaVersion: 1,
        writtenAt: new Date().toISOString(),
        flywheelVersion: VERSION,
        state,
        stateHash,
    };
    writeFileSync(join(ckptDir, CHECKPOINT_FILE), JSON.stringify(envelope, null, 2), 'utf8');
}
function makeBaseState(overrides = {}) {
    return {
        phase: 'planning',
        selectedGoal: 'Outcome grading test',
        constraints: [],
        retryCount: 0,
        maxRetries: 3,
        maxReviewPasses: 2,
        iterationRound: 0,
        currentGateIndex: 0,
        polishRound: 0,
        polishChanges: [],
        polishConverged: false,
        ...overrides,
    };
}
const VALID_RUBRIC = `---
version: 1
source: auto
generatedAt: 2026-05-08T12:30:00Z
planSlug: outcome-grading-test
goal: Outcome grading test
criteria:
  - id: c1
    description: outcome-grading.ts module exports RubricSchemaV1 and parses round-trips
    weight: 0.3
  - id: c2
    description: flywheel_synthesize_rubric tool registered and writes rubric.md
    weight: 0.3
  - id: c3
    description: doctor outcome_rubric_validity check ships
    weight: 0.4
---

# Outcome Rubric — test
`;
describe('doctor.outcome_rubric_validity', () => {
    let dir;
    afterEach(() => {
        if (dir)
            rmSync(dir, { recursive: true, force: true });
    });
    function findRubricCheck(checks) {
        const row = checks.find((c) => c.name === 'outcome_rubric_validity');
        expect(row, 'outcome_rubric_validity row must be present in DoctorReport').toBeDefined();
        return row;
    }
    it('green when no checkpoint exists (no active rubric)', async () => {
        dir = mkdtempSync(join(tmpdir(), 'doctor-rubric-noplan-'));
        const report = await runDoctorChecks(dir);
        const row = findRubricCheck(report.checks);
        expect(row.severity).toBe('green');
        expect(row.message).toBe('no active rubric - outcome grading not applicable');
        expect(row.hint).toBe(GREEN_HINT);
    });
    it('green when rubric.md is valid', async () => {
        dir = mkdtempSync(join(tmpdir(), 'doctor-rubric-green-'));
        const rubricPath = '.pi-flywheel/plans/outcome-grading-test/rubric.md';
        const absolute = join(dir, rubricPath);
        mkdirSync(join(dir, '.pi-flywheel/plans/outcome-grading-test'), { recursive: true });
        writeFileSync(absolute, VALID_RUBRIC, 'utf8');
        writeCheckpointWithState(dir, makeBaseState({ outcomeRubricPath: rubricPath }));
        const report = await runDoctorChecks(dir);
        const row = findRubricCheck(report.checks);
        expect(row.severity).toBe('green');
        expect(row.message).toMatch(/^outcome rubric valid \(3 criteria, source auto\)$/);
        expect(row.hint).toBe(GREEN_HINT);
    });
    it('yellow when the rubric.md file is missing', async () => {
        dir = mkdtempSync(join(tmpdir(), 'doctor-rubric-missing-'));
        const rubricPath = '.pi-flywheel/plans/missing-slug/rubric.md';
        writeCheckpointWithState(dir, makeBaseState({ outcomeRubricPath: rubricPath }));
        const report = await runDoctorChecks(dir);
        const row = findRubricCheck(report.checks);
        expect(row.severity).toBe('yellow');
        expect(row.message).toBe(`outcome rubric path is set but the file is missing: ${rubricPath}`);
        expect(row.hint).toBe(YELLOW_HINT);
    });
    it('yellow when rubric.md frontmatter fails to parse', async () => {
        dir = mkdtempSync(join(tmpdir(), 'doctor-rubric-malformed-'));
        const rubricPath = '.pi-flywheel/plans/broken-slug/rubric.md';
        const absolute = join(dir, rubricPath);
        mkdirSync(join(dir, '.pi-flywheel/plans/broken-slug'), { recursive: true });
        // Missing closing `---` — parser throws rubric_synth_invalid.
        writeFileSync(absolute, '---\nversion: 1\nsource: auto\n', 'utf8');
        writeCheckpointWithState(dir, makeBaseState({ outcomeRubricPath: rubricPath }));
        const report = await runDoctorChecks(dir);
        const row = findRubricCheck(report.checks);
        expect(row.severity).toBe('yellow');
        expect(row.message).toMatch(/^outcome rubric invalid: /);
        expect(row.hint).toBe(YELLOW_HINT);
    });
    it('red when rubric.md has zero criteria', async () => {
        dir = mkdtempSync(join(tmpdir(), 'doctor-rubric-empty-'));
        const rubricPath = '.pi-flywheel/plans/empty-slug/rubric.md';
        const absolute = join(dir, rubricPath);
        mkdirSync(join(dir, '.pi-flywheel/plans/empty-slug'), { recursive: true });
        writeFileSync(absolute, `---\nversion: 1\nsource: auto\ngeneratedAt: 2026-05-08T12:30:00Z\nplanSlug: empty-slug\ngoal: Empty\ncriteria:\n---\n`, 'utf8');
        writeCheckpointWithState(dir, makeBaseState({ outcomeRubricPath: rubricPath }));
        const report = await runDoctorChecks(dir);
        const row = findRubricCheck(report.checks);
        expect(row.severity).toBe('red');
        expect(row.message).toBe('outcome rubric has zero criteria');
        expect(row.hint).toBe(RED_HINT);
    });
    it('looksLikeEmptyCriteria identifies the empty-criteria shape directly', async () => {
        const { looksLikeEmptyCriteria } = await import('../tools/doctor.js');
        expect(looksLikeEmptyCriteria(`---\nversion: 1\nsource: auto\ncriteria:\n---\n`)).toBe(true);
        expect(looksLikeEmptyCriteria(`---\nversion: 1\nsource: auto\ncriteria:\n  - id: c1\n    description: x\n---\n`)).toBe(false);
        expect(looksLikeEmptyCriteria(`---\nversion: 1\nsource: auto\ngoal: x\ncriteria:\nplanSlug: y\n---\n`)).toBe(true);
    });
});
//# sourceMappingURL=doctor-outcome-rubric-validity.test.js.map