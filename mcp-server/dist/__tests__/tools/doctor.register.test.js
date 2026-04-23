/**
 * I4 — flywheel_doctor MCP tool registration.
 *
 * Tests:
 *   1. Tool appears in TOOLS introspection list with required cwd.
 *   2. Handler returns a DoctorReportSchema-validated envelope.
 *   3. Pre-aborted signal yields partial:true report (doctor_partial_report semantics).
 *   4. Read-only: no calls to checkpoint.writeCheckpoint occur.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOLS, createCallToolHandler } from '../../server.js';
import { DoctorReportSchema, createInitialState } from '../../types.js';
import { runDoctor, renderDoctorReportText } from '../../tools/doctor-tool.js';
// Mock writeCheckpoint to assert the doctor tool never mutates checkpoint state.
vi.mock('../../checkpoint.js', async () => {
    const actual = await vi.importActual('../../checkpoint.js');
    return {
        ...actual,
        writeCheckpoint: vi.fn(async () => true),
    };
});
function makeTmpCwd() {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-register-'));
    mkdirSync(join(dir, 'mcp-server', 'dist'), { recursive: true });
    writeFileSync(join(dir, 'mcp-server', 'dist', 'server.js'), '// built\n');
    return dir;
}
function cleanup(dir) {
    try {
        rmSync(dir, { recursive: true, force: true });
    }
    catch {
        /* ignore */
    }
}
describe('I4 — flywheel_doctor tool registration', () => {
    it('appears in TOOLS introspection list with required cwd schema', () => {
        const tool = TOOLS.find((t) => t.name === 'flywheel_doctor');
        expect(tool).toBeDefined();
        expect(tool.inputSchema).toMatchObject({
            type: 'object',
            properties: {
                cwd: { type: 'string' },
            },
            required: ['cwd'],
        });
        expect(typeof tool.description).toBe('string');
        expect(tool.description.length).toBeGreaterThan(20);
    });
    it('runDoctor handler returns a valid DoctorReport envelope', async () => {
        const cwd = makeTmpCwd();
        try {
            const ctx = {
                exec: async () => ({ code: 1, stdout: '', stderr: 'not mocked' }),
                cwd,
                state: createInitialState(),
                saveState: () => { },
                clearState: () => { },
                signal: undefined,
            };
            const result = await runDoctor(ctx, { cwd });
            expect(result.isError).toBeFalsy();
            expect(Array.isArray(result.content)).toBe(true);
            expect(result.content[0].type).toBe('text');
            const sc = result.structuredContent;
            expect(sc.tool).toBe('flywheel_doctor');
            expect(sc.version).toBe(1);
            expect(sc.status).toBe('ok');
            expect(sc.phase).toBe('doctor');
            expect(sc.data.kind).toBe('doctor_report');
            // The structured report must validate against DoctorReportSchema.
            const parsed = DoctorReportSchema.safeParse(sc.data.report);
            expect(parsed.success).toBe(true);
            // Text render should include the overall glyph header.
            expect(result.content[0].text).toMatch(/flywheel doctor — overall:/);
        }
        finally {
            cleanup(cwd);
        }
    });
    it('pre-aborted signal produces partial:true report with doctor_partial_report semantics', async () => {
        const cwd = makeTmpCwd();
        try {
            const ac = new AbortController();
            ac.abort();
            const ctx = {
                exec: async () => ({ code: 0, stdout: '', stderr: '' }),
                cwd,
                state: createInitialState(),
                saveState: () => { },
                clearState: () => { },
                signal: ac.signal,
            };
            const result = await runDoctor(ctx, { cwd });
            const sc = result.structuredContent;
            expect(sc.data.report.partial).toBe(true);
            expect(sc.data.report.checks).toEqual([]);
            expect(sc.data.report.overall).toBe('red');
            expect(sc.data.report.elapsedMs).toBe(0);
        }
        finally {
            cleanup(cwd);
        }
    });
    it('never calls writeCheckpoint — tool is read-only', async () => {
        const checkpointModule = await import('../../checkpoint.js');
        const writeSpy = vi.mocked(checkpointModule.writeCheckpoint);
        writeSpy.mockClear();
        const cwd = makeTmpCwd();
        try {
            const ctx = {
                exec: async () => ({ code: 1, stdout: '', stderr: 'not mocked' }),
                cwd,
                state: createInitialState(),
                saveState: () => { },
                clearState: () => { },
            };
            await runDoctor(ctx, { cwd });
            expect(writeSpy).not.toHaveBeenCalled();
        }
        finally {
            cleanup(cwd);
        }
    });
    it('dispatches through createCallToolHandler using the registered runner', async () => {
        const cwd = makeTmpCwd();
        try {
            // Use a spy runner so we can assert the dispatch plumbing without
            // re-running the full doctor sweep here.
            const report = {
                version: 1,
                cwd,
                overall: 'green',
                partial: false,
                checks: [{ name: 'noop', severity: 'green', message: 'stub' }],
                elapsedMs: 1,
                timestamp: new Date().toISOString(),
            };
            const structured = {
                tool: 'flywheel_doctor',
                version: 1,
                status: 'ok',
                phase: 'doctor',
                data: { kind: 'doctor_report', report },
            };
            const stubRunDoctor = vi.fn().mockResolvedValue({
                content: [{ type: 'text', text: renderDoctorReportText(report) }],
                structuredContent: structured,
            });
            const handler = createCallToolHandler({
                makeExec: vi.fn(() => vi.fn()),
                loadState: vi.fn(() => createInitialState()),
                saveState: vi.fn(),
                clearState: vi.fn(),
                runners: { flywheel_doctor: stubRunDoctor },
            });
            const result = await handler({
                params: { name: 'flywheel_doctor', arguments: { cwd } },
            });
            expect(stubRunDoctor).toHaveBeenCalledTimes(1);
            expect(result.structuredContent).toBe(structured);
        }
        finally {
            cleanup(cwd);
        }
    });
    it('renderDoctorReportText produces one line per check with severity glyphs', () => {
        const report = {
            version: 1,
            cwd: '/tmp/x',
            overall: 'yellow',
            partial: false,
            checks: [
                { name: 'br_binary', severity: 'green', message: 'br 0.1.0' },
                { name: 'bv_binary', severity: 'yellow', message: 'bv not installed', hint: 'cli_not_available' },
                { name: 'agent_mail_liveness', severity: 'red', message: 'unreachable' },
            ],
            elapsedMs: 42,
            timestamp: '2026-04-21T00:00:00.000Z',
        };
        const text = renderDoctorReportText(report);
        expect(text).toMatch(/^flywheel doctor — overall: \[WARN\]/);
        expect(text).toContain('[OK] br_binary: br 0.1.0');
        expect(text).toContain('[WARN] bv_binary: bv not installed [hint: cli_not_available]');
        expect(text).toContain('[FAIL] agent_mail_liveness: unreachable');
    });
    it('renderDoctorReportText appends FW_LOG_LEVEL tip on non-green overall', () => {
        const yellowReport = {
            version: 1,
            cwd: '/tmp/x',
            overall: 'yellow',
            partial: false,
            checks: [{ name: 'bv_binary', severity: 'yellow', message: 'bv not installed' }],
            elapsedMs: 1,
            timestamp: '2026-04-23T00:00:00.000Z',
        };
        expect(renderDoctorReportText(yellowReport)).toContain('FW_LOG_LEVEL=debug');
        const redReport = { ...yellowReport, overall: 'red' };
        expect(renderDoctorReportText(redReport)).toContain('FW_LOG_LEVEL=debug');
    });
    it('renderDoctorReportText omits FW_LOG_LEVEL tip on green overall', () => {
        const greenReport = {
            version: 1,
            cwd: '/tmp/x',
            overall: 'green',
            partial: false,
            checks: [{ name: 'br_binary', severity: 'green', message: 'br 0.1.0' }],
            elapsedMs: 1,
            timestamp: '2026-04-23T00:00:00.000Z',
        };
        expect(renderDoctorReportText(greenReport)).not.toContain('FW_LOG_LEVEL');
    });
});
//# sourceMappingURL=doctor.register.test.js.map