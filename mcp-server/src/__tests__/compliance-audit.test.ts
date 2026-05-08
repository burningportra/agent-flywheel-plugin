import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runComplianceAudit } from '../tools/compliance-audit.js';
import type { ToolContext } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const stubCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  exec: vi.fn(),
  cwd: '/tmp',
  state: {} as any,
  saveState: vi.fn(),
  clearState: vi.fn(),
  ...overrides,
} as any);

describe('runComplianceAudit', () => {
  beforeEach(() => {
    delete process.env.FW_COMPLIANCE_OVERRIDE;
  });

  it('returns ok with empty arrays when beadIds is empty', async () => {
    const result = await runComplianceAudit(stubCtx(), { cwd: '/tmp', beadIds: [] });
    expect(result.isError).toBeUndefined();
    const data = (result.structuredContent as any).data;
    expect(data.status).toBe('ok');
    expect(data.passed).toEqual([]);
    expect(data.failed).toEqual([]);
  });

  it('returns invalid_input when beadIds is not an array', async () => {
    const result = await runComplianceAudit(stubCtx(), { cwd: '/tmp', beadIds: 'nope' } as any);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      tool: 'flywheel_compliance_audit',
      status: 'error',
      data: { error: { code: 'invalid_input' } },
    });
  });

  it('returns skipped when FW_COMPLIANCE_OVERRIDE env is set', async () => {
    process.env.FW_COMPLIANCE_OVERRIDE = 'agent-flywheel-001,agent-flywheel-002';
    const result = await runComplianceAudit(stubCtx(), {
      cwd: '/tmp',
      beadIds: ['agent-flywheel-001', 'agent-flywheel-002'],
    });
    const data = (result.structuredContent as any).data;
    expect(data.status).toBe('skipped');
  });

  it('returns skipped when skipEnv argument is set', async () => {
    const result = await runComplianceAudit(stubCtx(), {
      cwd: '/tmp',
      beadIds: ['agent-flywheel-001'],
      skipEnv: 'agent-flywheel-001',
    });
    const data = (result.structuredContent as any).data;
    expect(data.status).toBe('skipped');
  });
});

function setupFakePassDir(cwd: string, fixtureName: string): string {
  const passUtc = '2026-05-08T19-14-22Z';
  const passDir = join(cwd, 'beads_compliance_audit', 'passes', passUtc);
  mkdirSync(passDir, { recursive: true });
  const fixturePath = join(__dirname, 'fixtures', fixtureName);
  writeFileSync(join(passDir, 'result.json'), readFileSync(fixturePath, 'utf8'));
  return passDir;
}

describe('runComplianceAudit - skill spawn + parse', () => {
  let tmp: string;

  beforeEach(() => {
    delete process.env.FW_COMPLIANCE_OVERRIDE;
    tmp = mkdtempSync(join(tmpdir(), 'fw-comp-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('spawns the skill and parses all-pass result', async () => {
    setupFakePassDir(tmp, 'compliance-result-pass.json');
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const result = await runComplianceAudit(stubCtx({ exec }), { cwd: tmp, beadIds: ['agent-flywheel-001'] });

    const data = (result.structuredContent as any).data;
    expect(data.status).toBe('ok');
    expect(data.passed).toEqual([
      {
        beadId: 'agent-flywheel-001',
        score: 850,
        reportPath: join(tmp, 'beads_compliance_audit', 'passes', '2026-05-08T19-14-22Z', 'beads/agent-flywheel-001/scorecard.md'),
      },
    ]);
    expect(data.failed).toEqual([]);
    expect(data.passUtc).toBe('2026-05-08T19:14:22Z');
    expect(exec).toHaveBeenCalledWith(
      'claude',
      [
        '--skill',
        'beads-compliance-and-completion-verification',
        '--',
        '--mode',
        'flywheel-gate',
        '--beads',
        'agent-flywheel-001',
        '--threshold',
        '700',
        '--parallelism',
        '5',
      ],
      { cwd: tmp, timeout: 15 * 60 * 1000, signal: undefined },
    );
  });

  it('parses mixed result and partitions passed/failed', async () => {
    setupFakePassDir(tmp, 'compliance-result-mixed.json');
    const ctx = stubCtx({
      exec: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
    });
    const result = await runComplianceAudit(ctx, {
      cwd: tmp,
      beadIds: ['agent-flywheel-001', 'agent-flywheel-002'],
    });

    const data = (result.structuredContent as any).data;
    expect(data.status).toBe('ok');
    expect(data.passed).toHaveLength(1);
    expect(data.failed).toEqual([
      {
        beadId: 'agent-flywheel-002',
        score: 420,
        reportPath: join(tmp, 'beads_compliance_audit', 'passes', '2026-05-08T19-14-22Z', 'beads/agent-flywheel-002/scorecard.md'),
        reasons: [
          'impl_completeness:120/300',
          'test_depth:60/150',
          'anti_theater:30/150',
        ],
      },
    ]);
  });

  it('returns status=error when the skill subprocess fails', async () => {
    const ctx = stubCtx({
      exec: vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'skill not found' }),
    });
    const result = await runComplianceAudit(ctx, { cwd: tmp, beadIds: ['agent-flywheel-001'] });

    const data = (result.structuredContent as any).data;
    expect(data.status).toBe('error');
    expect(data.errors.spawn).toContain('exit 1');
    expect(data.errors.spawn).toContain('skill not found');
  });

  it('returns status=error when the passes directory is missing', async () => {
    const ctx = stubCtx({
      exec: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
    });
    const result = await runComplianceAudit(ctx, { cwd: tmp, beadIds: ['agent-flywheel-001'] });

    const data = (result.structuredContent as any).data;
    expect(data.status).toBe('error');
    expect(data.errors.parse).toContain('passes directory missing');
  });

  it('returns status=error when result.json is missing', async () => {
    mkdirSync(join(tmp, 'beads_compliance_audit', 'passes', '2026-05-08T19-14-22Z'), { recursive: true });
    const ctx = stubCtx({
      exec: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
    });
    const result = await runComplianceAudit(ctx, { cwd: tmp, beadIds: ['agent-flywheel-001'] });

    const data = (result.structuredContent as any).data;
    expect(data.status).toBe('error');
    expect(data.errors.parse).toContain('result.json not found');
  });

  it('returns status=error when result.json is invalid JSON', async () => {
    const passDir = join(tmp, 'beads_compliance_audit', 'passes', '2026-05-08T19-14-22Z');
    mkdirSync(passDir, { recursive: true });
    writeFileSync(join(passDir, 'result.json'), '{not json');
    const ctx = stubCtx({
      exec: vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
    });
    const result = await runComplianceAudit(ctx, { cwd: tmp, beadIds: ['agent-flywheel-001'] });

    const data = (result.structuredContent as any).data;
    expect(data.status).toBe('error');
    expect(data.errors.parse).toBeTruthy();
  });
});
