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
import { basename, join } from 'node:path';

import { TOOLS, createCallToolHandler } from '../../server.js';
import { DoctorReportSchema, createInitialState } from '../../types.js';
import { runDoctor, renderDoctorReportText } from '../../tools/doctor-tool.js';
import { renderPreflightBanner } from '../../preflight.js';
import { computeStateHash } from '../../checkpoint.js';
import type { DoctorReport, ToolContext } from '../../types.js';

// Mock writeCheckpoint to assert the doctor tool never mutates checkpoint state.
vi.mock('../../checkpoint.js', async () => {
  const actual = await vi.importActual<typeof import('../../checkpoint.js')>(
    '../../checkpoint.js',
  );
  return {
    ...actual,
    writeCheckpoint: vi.fn(async () => true),
  };
});

function makeTmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-register-'));
  mkdirSync(join(dir, 'mcp-server', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'mcp-server', 'dist', 'server.js'), '// built\n');
  return dir;
}

function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function writeValidCheckpoint(cwd: string): void {
  const state = createInitialState();
  mkdirSync(join(cwd, '.pi-flywheel'), { recursive: true });
  writeFileSync(
    join(cwd, '.pi-flywheel', 'checkpoint.json'),
    JSON.stringify({
      schemaVersion: 1,
      writtenAt: new Date().toISOString(),
      flywheelVersion: 'test',
      state,
      stateHash: computeStateHash(state),
    }),
  );
}

describe('I4 — flywheel_doctor tool registration', () => {
  it('appears in TOOLS introspection list with required cwd schema', () => {
    const tool = TOOLS.find((t) => t.name === 'flywheel_doctor');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        cwd: { type: 'string' },
      },
      required: ['cwd'],
    });
    expect(typeof tool!.description).toBe('string');
    expect(tool!.description.length).toBeGreaterThan(20);
  });

  it('runDoctor handler returns a valid DoctorReport envelope', async () => {
    const cwd = makeTmpCwd();
    try {
      const exec = vi.fn(async (cmd: string) => {
        if (cmd === 'br') {
          return { code: 0, stdout: '{"issues":[]}', stderr: '' };
        }
        if (cmd === 'cass') {
          return { code: 0, stdout: '{"hits":[]}', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: 'unexpected command' };
      });
      const ctx: ToolContext = {
        exec,
        cwd,
        state: createInitialState(),
        saveState: () => {},
        clearState: () => {},
        signal: undefined,
      };
      const result = await runDoctor(ctx, { cwd });

      expect(result.isError).toBeFalsy();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]!.type).toBe('text');

      const sc = result.structuredContent as {
        tool: string;
        version: number;
        status: string;
        phase: string;
        data: {
          kind: string;
          report: DoctorReport;
          preflightBanner: string | null;
          firstRun: boolean;
        };
      };
      expect(sc.tool).toBe('flywheel_doctor');
      expect(sc.version).toBe(1);
      expect(sc.status).toBe('ok');
      expect(sc.phase).toBe('doctor');
      expect(sc.data.kind).toBe('doctor_report');

      // The structured report must validate against DoctorReportSchema.
      const parsed = DoctorReportSchema.safeParse(sc.data.report);
      expect(parsed.success).toBe(true);
      expect(sc.data.report.ntm).toMatchObject({
        NTM_AVAILABLE: expect.any(Boolean),
        NTM_PROJECT: basename(cwd),
        reason: expect.any(String),
      });

      expect(sc.data.preflightBanner).toBe(
        renderPreflightBanner(sc.data.report),
      );
      expect(sc.data.firstRun).toBe(true);
      expect(exec).toHaveBeenCalledWith(
        'br',
        ['list', '--all', '--limit', '1', '--json'],
        { cwd, timeout: 5000, signal: undefined },
      );
      expect(exec).toHaveBeenCalledWith(
        'cass',
        [
          'search',
          '',
          '--workspace',
          cwd,
          '--limit',
          '1',
          '--fields',
          'minimal',
          '--json',
        ],
        { cwd, timeout: 5000, signal: undefined },
      );

      // Text render should include the overall glyph header.
      expect(result.content[0]!.text).toMatch(/flywheel doctor — overall:/);
      if (sc.data.preflightBanner !== null) {
        expect(result.content[0]!.text).toContain(sc.data.preflightBanner);
      }
    } finally {
      cleanup(cwd);
    }
  });

  it('returns firstRun:false after a checkpoint exists', async () => {
    const cwd = makeTmpCwd();
    try {
      writeValidCheckpoint(cwd);
      const ctx: ToolContext = {
        exec: async () => ({ code: 1, stdout: '', stderr: 'not mocked' }),
        cwd,
        state: createInitialState(),
        saveState: () => {},
        clearState: () => {},
        signal: undefined,
      };

      const result = await runDoctor(ctx, { cwd });
      const sc = result.structuredContent as {
        data: { firstRun: boolean };
      };

      expect(sc.data.firstRun).toBe(false);
    } finally {
      cleanup(cwd);
    }
  });

  it('returns firstRun:false when CASS has project history', async () => {
    const cwd = makeTmpCwd();
    try {
      const ctx: ToolContext = {
        exec: async (cmd) => cmd === 'cass'
          ? {
              code: 0,
              stdout: '{"hits":[{"source_path":"session.jsonl"}]}',
              stderr: '',
            }
          : { code: 0, stdout: '{"issues":[]}', stderr: '' },
        cwd,
        state: createInitialState(),
        saveState: () => {},
        clearState: () => {},
        signal: undefined,
      };

      const result = await runDoctor(ctx, { cwd });
      const sc = result.structuredContent as {
        data: { firstRun: boolean };
      };

      expect(sc.data.firstRun).toBe(false);
    } finally {
      cleanup(cwd);
    }
  });

  it('pre-aborted signal produces partial:true report with doctor_partial_report semantics', async () => {
    const cwd = makeTmpCwd();
    try {
      const ac = new AbortController();
      ac.abort();
      const ctx: ToolContext = {
        exec: async () => ({ code: 0, stdout: '', stderr: '' }),
        cwd,
        state: createInitialState(),
        saveState: () => {},
        clearState: () => {},
        signal: ac.signal,
      };
      const result = await runDoctor(ctx, { cwd });
      const sc = result.structuredContent as {
        data: { report: DoctorReport };
      };
      expect(sc.data.report.partial).toBe(true);
      expect(sc.data.report.checks).toEqual([]);
      expect(sc.data.report.overall).toBe('red');
      expect(sc.data.report.elapsedMs).toBe(0);
      expect(sc.data.report.ntm).toEqual({
        NTM_AVAILABLE: false,
        NTM_PROJECT: basename(cwd),
        reason: 'incomplete',
      });
    } finally {
      cleanup(cwd);
    }
  });

  it('never calls writeCheckpoint — tool is read-only', async () => {
    const checkpointModule = await import('../../checkpoint.js');
    const writeSpy = vi.mocked(checkpointModule.writeCheckpoint);
    writeSpy.mockClear();

    const cwd = makeTmpCwd();
    try {
      const ctx: ToolContext = {
        exec: async () => ({ code: 1, stdout: '', stderr: 'not mocked' }),
        cwd,
        state: createInitialState(),
        saveState: () => {},
        clearState: () => {},
      };
      await runDoctor(ctx, { cwd });
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      cleanup(cwd);
    }
  });

  it('dispatches through createCallToolHandler using the registered runner', async () => {
    const cwd = makeTmpCwd();
    try {
      // Use a spy runner so we can assert the dispatch plumbing without
      // re-running the full doctor sweep here.
      const report: DoctorReport = {
        version: 1,
        cwd,
        overall: 'green',
        criticalFails: 0,
        partial: false,
        checks: [{ name: 'noop', severity: 'green', message: 'stub' }],
        elapsedMs: 1,
        timestamp: new Date().toISOString(),
      };
      const structured = {
        tool: 'flywheel_doctor' as const,
        version: 1 as const,
        status: 'ok' as const,
        phase: 'doctor' as const,
        data: { kind: 'doctor_report' as const, report },
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
      } as never);

      expect(stubRunDoctor).toHaveBeenCalledTimes(1);
      expect(result.structuredContent).toBe(structured);
    } finally {
      cleanup(cwd);
    }
  });

  it('renderDoctorReportText produces one line per check with severity glyphs', () => {
    const report: DoctorReport = {
      version: 1,
      cwd: '/tmp/x',
      overall: 'yellow',
      criticalFails: 1,
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
    const yellowReport: DoctorReport = {
      version: 1,
      cwd: '/tmp/x',
      overall: 'yellow',
      criticalFails: 0,
      partial: false,
      checks: [{ name: 'bv_binary', severity: 'yellow', message: 'bv not installed' }],
      elapsedMs: 1,
      timestamp: '2026-04-23T00:00:00.000Z',
    };
    expect(renderDoctorReportText(yellowReport)).toContain('FW_LOG_LEVEL=debug');

    const redReport: DoctorReport = { ...yellowReport, overall: 'red' };
    expect(renderDoctorReportText(redReport)).toContain('FW_LOG_LEVEL=debug');
  });

  it('renderDoctorReportText omits FW_LOG_LEVEL tip on green overall', () => {
    const greenReport: DoctorReport = {
      version: 1,
      cwd: '/tmp/x',
      overall: 'green',
      criticalFails: 0,
      partial: false,
      checks: [{ name: 'br_binary', severity: 'green', message: 'br 0.1.0' }],
      elapsedMs: 1,
      timestamp: '2026-04-23T00:00:00.000Z',
    };
    expect(renderDoctorReportText(greenReport)).not.toContain('FW_LOG_LEVEL');
  });
});
