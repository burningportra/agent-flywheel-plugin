/**
 * I5 — Hotspot matrix injection into flywheel_approve_beads.
 *
 * Coverage:
 *   - 3 beads sharing a file via `### Files:` section → 4-option menu +
 *     matrix visible in structuredContent.
 *   - Empty / single-bead case → legacy 3-option menu + empty matrix rows.
 *   - Regression for Gate 1 finding: Bead.description must be mapped to
 *     HotspotInputBead.body at the adapter boundary. If this test passes,
 *     the `description → body` surprise is correctly handled.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockExec, makeState } from '../helpers/mocks.js';
// ─── Helpers ──────────────────────────────────────────────────────────────
function makeBead(overrides = {}) {
    return {
        id: 'bead-1',
        title: 'Add tests',
        description: '### Files:\n- src/placeholder.ts',
        status: 'open',
        priority: 2,
        type: 'task',
        labels: [],
        ...overrides,
    };
}
function makeExecCalls(beads, readyBeads) {
    return [
        {
            cmd: 'br',
            args: ['list', '--json'],
            result: { code: 0, stdout: JSON.stringify(beads), stderr: '' },
        },
        {
            cmd: 'br',
            args: ['ready', '--json'],
            result: { code: 0, stdout: JSON.stringify(readyBeads ?? beads), stderr: '' },
        },
        ...beads.map((b) => ({
            cmd: 'br',
            args: ['update', b.id, '--status', 'in_progress'],
            result: { code: 0, stdout: '', stderr: '' },
        })),
    ];
}
function makeCtx(beads, stateOverrides = {}) {
    const exec = createMockExec(makeExecCalls(beads));
    const state = makeState({
        selectedGoal: 'Ship hotspot menu',
        phase: 'awaiting_bead_approval',
        ...stateOverrides,
    });
    return {
        ctx: {
            exec,
            cwd: '/fake/cwd',
            state,
            saveState: (s) => {
                Object.assign(state, s);
            },
            clearState: () => { },
        },
        state,
    };
}
async function importApprove() {
    const mod = await import('../../tools/approve.js');
    return mod;
}
// ─── Tests ────────────────────────────────────────────────────────────────
describe('I5 — approve_beads hotspot injection', () => {
    beforeEach(async () => {
        vi.resetModules();
        const { _resetForTest } = await import('../../mutex.js');
        _resetForTest();
    });
    it('3 beads sharing server.ts via ### Files: section → 4-option menu + matrix', async () => {
        const { runApprove } = await importApprove();
        const beads = [
            makeBead({ id: 'b1', title: 'Write tool A', description: '### Files:\n- mcp-server/src/server.ts\n- mcp-server/src/tools/a.ts' }),
            makeBead({ id: 'b2', title: 'Write tool B', description: '### Files:\n- mcp-server/src/server.ts\n- mcp-server/src/tools/b.ts' }),
            makeBead({ id: 'b3', title: 'Write tool C', description: '### Files:\n- mcp-server/src/server.ts\n- mcp-server/src/tools/c.ts' }),
        ];
        const { ctx } = makeCtx(beads);
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        const sc = result.structuredContent;
        expect(sc.data.matrix).toBeDefined();
        const matrix = sc.data.matrix;
        // Server.ts must appear with high severity (3 beads, files-section provenance).
        const serverRow = matrix.rows.find((r) => r.file.endsWith('server.ts'));
        expect(serverRow).toBeDefined();
        expect(serverRow.contentionCount).toBe(3);
        expect(serverRow.severity).toBe('high');
        expect(serverRow.provenance).toBe('files-section');
        // Recommendation flips to coordinator-serial.
        expect(matrix.recommendation).toBe('coordinator-serial');
        expect(matrix.maxContention).toBeGreaterThanOrEqual(3);
        // 4-option menu appears: coordinator-serial, swarm, polish, reject.
        expect(sc.nextStep?.type).toBe('present_choices');
        const optionIds = (sc.nextStep?.options ?? []).map((o) => o.id);
        expect(optionIds).toEqual([
            'approve-beads-coordinator-serial',
            'approve-beads-swarm',
            'approve-beads-polish',
            'approve-beads-reject',
        ]);
        // Content includes the hotspot summary text.
        expect(result.content[0].text).toMatch(/Shared-write contention detected/);
        expect(result.content[0].text).toContain('server.ts');
        expect(result.content[0].text).toMatch(/Recommendation: coordinator-serial/);
    });
    it('single bead → legacy nextStep + matrix present with low/empty rows', async () => {
        const { runApprove } = await importApprove();
        const beads = [makeBead({ description: '### Files:\n- src/only.ts' })];
        const { ctx } = makeCtx(beads);
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        const sc = result.structuredContent;
        expect(sc.data.matrix).toBeDefined();
        const matrix = sc.data.matrix;
        expect(matrix.recommendation).toBe('swarm');
        expect(matrix.maxContention).toBeLessThanOrEqual(1);
        // Sequential launch → legacy call_tool nextStep (not present_choices).
        expect(sc.data.launchMode).toBe('sequential');
        expect(sc.nextStep?.type).toBe('call_tool');
    });
    it('two beads sharing a file via prose only → 4-option menu (med severity)', async () => {
        const { runApprove } = await importApprove();
        const beads = [
            makeBead({ id: 'b1', title: 'Refactor utils', description: 'Rewrite helpers in src/util.ts for clarity.' }),
            makeBead({ id: 'b2', title: 'Extend utils', description: 'Add new helpers to src/util.ts for retries.' }),
        ];
        const { ctx } = makeCtx(beads);
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        const sc = result.structuredContent;
        expect(sc.data.matrix).toBeDefined();
        const row = sc.data.matrix.rows.find((r) => r.file === 'src/util.ts');
        expect(row).toBeDefined();
        expect(row.contentionCount).toBe(2);
        expect(row.severity).toBe('med');
        expect(row.provenance).toBe('prose');
        expect(sc.nextStep?.type).toBe('present_choices');
    });
    it('GATE 1 REGRESSION: bead.description is mapped to HotspotInputBead.body', async () => {
        // This is the specific regression test for the Gate 1 field-mismatch
        // surprise. Without the adapter mapping description → body in
        // `beadsToHotspotInput`, the matrix would silently have empty rows and
        // contention would never be detected.
        const { runApprove, beadsToHotspotInput } = await importApprove();
        // Direct unit check on the adapter.
        const bead = {
            id: 'x1',
            title: 'Explode',
            description: '### Files:\n- src/x.ts',
            status: 'open',
            priority: 2,
        };
        const mapped = beadsToHotspotInput([bead]);
        expect(mapped).toEqual([{ id: 'x1', title: 'Explode', body: '### Files:\n- src/x.ts' }]);
        expect(mapped[0].body).toBe(bead.description);
        // End-to-end: when two beads share a file only in description, the matrix
        // MUST surface it. If this assertion flips to 0 rows, someone removed the
        // adapter and reintroduced the Gate 1 bug.
        const beads = [
            { ...bead, id: 'x1' },
            { ...bead, id: 'x2' },
        ];
        const { ctx } = makeCtx(beads);
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        const sc = result.structuredContent;
        const row = sc.data.matrix.rows.find((r) => r.file === 'src/x.ts');
        expect(row, 'matrix must see src/x.ts — description->body adapter required').toBeDefined();
        expect(row.contentionCount).toBe(2);
    });
    it('matrix is idempotent across repeat approve_beads calls (determinism via I3)', async () => {
        const { runApprove } = await importApprove();
        const beads = [
            makeBead({ id: 'b1', description: '### Files:\n- src/shared.ts' }),
            makeBead({ id: 'b2', description: '### Files:\n- src/shared.ts' }),
            makeBead({ id: 'b3', description: '### Files:\n- src/shared.ts' }),
        ];
        const firstCall = makeCtx(beads);
        const r1 = await runApprove(firstCall.ctx, { cwd: '/fake/cwd', action: 'polish' });
        const secondCall = makeCtx(beads);
        const r2 = await runApprove(secondCall.ctx, { cwd: '/fake/cwd', action: 'polish' });
        const m1 = r1.structuredContent.data.matrix;
        const m2 = r2.structuredContent.data.matrix;
        expect(m1).toEqual(m2);
    });
    it('shouldOfferCoordinatorSerial toggles on maxContention >= 2', async () => {
        const { shouldOfferCoordinatorSerial } = await importApprove();
        const base = {
            version: 1,
            rows: [],
            summaryOnly: false,
        };
        expect(shouldOfferCoordinatorSerial({ ...base, maxContention: 0, recommendation: 'swarm' })).toBe(false);
        expect(shouldOfferCoordinatorSerial({ ...base, maxContention: 1, recommendation: 'swarm' })).toBe(false);
        expect(shouldOfferCoordinatorSerial({ ...base, maxContention: 2, recommendation: 'swarm' })).toBe(true);
        expect(shouldOfferCoordinatorSerial({ ...base, maxContention: 0, recommendation: 'coordinator-serial' })).toBe(true);
    });
    it('formatHotspotSummary renders the top 3 hot files with severity and recommendation', async () => {
        const { formatHotspotSummary } = await importApprove();
        const matrix = {
            version: 1,
            rows: [
                { file: 'a.ts', beadIds: ['b1', 'b2', 'b3', 'b4'], contentionCount: 4, severity: 'high', provenance: 'files-section' },
                { file: 'b.ts', beadIds: ['b1', 'b2'], contentionCount: 2, severity: 'med', provenance: 'prose' },
                { file: 'c.ts', beadIds: ['b3', 'b4'], contentionCount: 2, severity: 'med', provenance: 'prose' },
                { file: 'd.ts', beadIds: ['b5'], contentionCount: 1, severity: 'low', provenance: 'prose' },
            ],
            maxContention: 4,
            recommendation: 'coordinator-serial',
            summaryOnly: false,
        };
        const text = formatHotspotSummary(matrix);
        expect(text).toMatch(/Shared-write contention detected:/);
        expect(text).toContain('a.ts (4 beads: b1, b2, b3, b4) — high');
        expect(text).toContain('b.ts');
        expect(text).toContain('c.ts');
        // d.ts is below top 3 and must be excluded.
        expect(text).not.toContain('d.ts');
        expect(text).toMatch(/Recommendation: coordinator-serial\.$/);
    });
    it('empty bead list case is never reached — approve short-circuits before matrix compute', async () => {
        // Sanity check: when beads.length === 0, approve returns `beads_missing`
        // before the matrix is computed. The matrix is only produced for non-empty
        // open-bead lists (see approve.ts:~240). This guards the precondition
        // assumed by I5 and the Gate 1 regression test above.
        const { runApprove } = await importApprove();
        const execCalls = [
            { cmd: 'br', args: ['list', '--json'], result: { code: 0, stdout: JSON.stringify([]), stderr: '' } },
        ];
        const ctx = {
            exec: createMockExec(execCalls),
            cwd: '/fake/cwd',
            state: makeState({ selectedGoal: 'g', phase: 'awaiting_bead_approval' }),
            saveState: () => { },
            clearState: () => { },
        };
        const result = await runApprove(ctx, { cwd: '/fake/cwd', action: 'start' });
        const sc = result.structuredContent;
        expect(sc.data.kind).toBe('beads_missing');
        // No matrix in beads_missing payload — we skipped compute to avoid noise.
        expect(sc.data.matrix).toBeUndefined();
    });
});
//# sourceMappingURL=approve.hotspot.test.js.map