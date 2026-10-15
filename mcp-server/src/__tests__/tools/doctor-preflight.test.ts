import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInitialState } from '../../types.js';
import type { DoctorReport, ToolContext } from '../../types.js';
import { runDoctorChecks } from '../../tools/doctor.js';
import { runDoctor } from '../../tools/doctor-tool.js';

vi.mock('../../tools/doctor.js', () => ({
  runDoctorChecks: vi.fn(),
}));

describe('flywheel_doctor preflight fields', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'doctor-preflight-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('returns the critical banner in structured data and text without hiding other warnings', async () => {
    const report: DoctorReport = {
      version: 1,
      cwd,
      overall: 'yellow',
      criticalFails: 0,
      partial: false,
      checks: [
        {
          name: 'bv_binary',
          severity: 'yellow',
          message: 'bv is unavailable',
          hint: 'install bv',
        },
        {
          name: 'checkpoint_validity',
          severity: 'yellow',
          message: 'checkpoint is stale',
          hint: 'inspect the checkpoint',
        },
      ],
      elapsedMs: 4,
      timestamp: '2026-10-15T00:00:00.000Z',
    };
    vi.mocked(runDoctorChecks).mockResolvedValue(report);

    const ctx: ToolContext = {
      exec: async (cmd) => cmd === 'cass'
        ? { code: 0, stdout: '{"hits":[]}', stderr: '' }
        : { code: 0, stdout: '{"issues":[]}', stderr: '' },
      cwd,
      state: createInitialState(),
      saveState: () => {},
      clearState: () => {},
    };

    const result = await runDoctor(ctx, { cwd });
    const data = (result.structuredContent as {
      data: { preflightBanner: string | null };
    }).data;
    const firstContent = result.content[0];
    expect(firstContent?.type).toBe('text');
    if (firstContent?.type !== 'text') {
      throw new Error('flywheel_doctor did not return text content');
    }

    expect(data.preflightBanner).toContain('bv_binary');
    expect(data.preflightBanner).not.toContain('checkpoint_validity');
    expect(firstContent.text).toContain(data.preflightBanner);
    expect(firstContent.text).toContain(
      '[WARN] checkpoint_validity: checkpoint is stale',
    );
  });
});
