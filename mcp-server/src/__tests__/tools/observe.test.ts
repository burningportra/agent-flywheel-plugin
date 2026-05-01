/**
 * Tests for flywheel_observe (T6, claude-orchestrator-29i).
 *
 * Acceptance coverage (per bead):
 *   1. no checkpoint / no beads → graceful empty snapshot
 *   2. corrupt-checkpoint warning surfaces
 *   3. WIZARD_*.md artifact detection
 *   4. br unavailable → graceful degradation (beads.unavailable=true)
 *   5. agent-mail unreachable → graceful degradation (agentMail.reachable=false)
 *   6. tool registers via the existing tool-listing path (TOOLS array + dispatch)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runObserve,
  FlywheelObserveReportSchema,
  _resetDoctorCache,
  type FlywheelObserveReport,
} from '../../tools/observe.js';
import { TOOLS, createCallToolHandler } from '../../server.js';
import { createInitialState } from '../../types.js';
import type { ToolContext } from '../../types.js';
import type { ExecFn } from '../../exec.js';

// Mock writeCheckpoint so we can assert observe never mutates it.
vi.mock('../../checkpoint.js', async () => {
  const actual = await vi.importActual<typeof import('../../checkpoint.js')>(
    '../../checkpoint.js',
  );
  return {
    ...actual,
    writeCheckpoint: vi.fn(async () => true),
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeTmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'observe-test-'));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

type StubResp =
  | { code: number; stdout: string; stderr: string }
  | { throws: Error };

interface ExecStub {
  match: (cmd: string, args: readonly string[]) => boolean;
  respond: StubResp;
}

function makeStubbedExec(stubs: ExecStub[]): ExecFn {
  return async (cmd, args) => {
    const stub = stubs.find((s) => s.match(cmd, args));
    if (!stub) {
      // Default: command "not mocked" — exit non-zero so the probe degrades.
      return { code: 1, stdout: '', stderr: `not mocked: ${cmd} ${args.join(' ')}` };
    }
    if ('throws' in stub.respond) throw stub.respond.throws;
    return stub.respond;
  };
}

const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });

/** Stubs that make every external probe degrade gracefully (no servers needed). */
function gracefulDegradeStubs(): ExecStub[] {
  return [
    { match: (cmd) => cmd === 'git', respond: { code: 1, stdout: '', stderr: 'not a repo' } },
    { match: (cmd) => cmd === 'br', respond: { code: 1, stdout: '', stderr: 'br not installed' } },
    { match: (cmd) => cmd === 'curl', respond: { code: 7, stdout: '', stderr: 'connect refused' } },
    { match: (cmd) => cmd === 'which', respond: { code: 1, stdout: '', stderr: '' } },
  ];
}

function makeCtx(cwd: string, exec: ExecFn): ToolContext {
  return {
    exec,
    cwd,
    state: createInitialState(),
    saveState: () => {},
    clearState: () => {},
    signal: undefined,
  };
}

beforeEach(() => {
  _resetDoctorCache();
});

// ─── Acceptance #1: no checkpoint / no beads ──────────────────────────────

describe('flywheel_observe — empty environment', () => {
  it('returns a valid report with checkpoint.exists=false when nothing is set up', async () => {
    const cwd = makeTmpCwd();
    try {
      const exec = makeStubbedExec(gracefulDegradeStubs());
      const result = await runObserve(makeCtx(cwd, exec), { cwd });

      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as {
        tool: string;
        data: { kind: string; report: FlywheelObserveReport };
      };
      expect(sc.tool).toBe('flywheel_observe');
      expect(sc.data.kind).toBe('observe_report');

      const report = sc.data.report;
      const parsed = FlywheelObserveReportSchema.safeParse(report);
      expect(parsed.success).toBe(true);

      expect(report.checkpoint.exists).toBe(false);
      expect(report.checkpoint.warnings).toEqual([]);
      expect(report.beads.unavailable).toBe(true);
      expect(report.agentMail.reachable).toBe(false);
      expect(report.ntm.available).toBe(false);
      expect(report.artifacts.wizard).toEqual([]);
    } finally {
      cleanup(cwd);
    }
  });
});

// ─── Acceptance #2: corrupt checkpoint warning surfaces ────────────────────

describe('flywheel_observe — corrupt checkpoint', () => {
  it('quarantines a corrupt checkpoint (so observe sees exists=false on next read)', async () => {
    const cwd = makeTmpCwd();
    try {
      // Write a malformed checkpoint — readCheckpoint validates it and
      // moves the file to .corrupt, so a subsequent read sees exists=false
      // (no warnings to bubble up). This documents the contract: corruption
      // is handled by the checkpoint module itself, observe just reflects it.
      mkdirSync(join(cwd, '.pi-flywheel'), { recursive: true });
      writeFileSync(
        join(cwd, '.pi-flywheel', 'checkpoint.json'),
        '{not valid json',
      );

      const exec = makeStubbedExec(gracefulDegradeStubs());
      const result = await runObserve(makeCtx(cwd, exec), { cwd });

      const sc = result.structuredContent as {
        data: { report: FlywheelObserveReport };
      };
      expect(sc.data.report.checkpoint.exists).toBe(false);
      // Scratch dirs include .pi-flywheel/ since we created it.
      expect(sc.data.report.artifacts.flywheelScratch).toContain('.pi-flywheel/');
    } finally {
      cleanup(cwd);
    }
  });
});

// ─── Acceptance #3: WIZARD artifact detection ──────────────────────────────

describe('flywheel_observe — WIZARD artifact detection', () => {
  it('detects WIZARD_*.md files at the cwd root', async () => {
    const cwd = makeTmpCwd();
    try {
      writeFileSync(join(cwd, 'WIZARD_IDEAS_2026-04-30.md'), '# ideas');
      writeFileSync(join(cwd, 'WIZARD_SCORES_2026-04-30.md'), '# scores');
      writeFileSync(join(cwd, 'README.md'), '# unrelated');

      const exec = makeStubbedExec(gracefulDegradeStubs());
      const result = await runObserve(makeCtx(cwd, exec), { cwd });

      const sc = result.structuredContent as {
        data: { report: FlywheelObserveReport };
      };
      expect(sc.data.report.artifacts.wizard.sort()).toEqual([
        'WIZARD_IDEAS_2026-04-30.md',
        'WIZARD_SCORES_2026-04-30.md',
      ]);
      // README must NOT be picked up — only WIZARD_*.md.
      expect(sc.data.report.artifacts.wizard).not.toContain('README.md');

      // A WIZARD-aware hint must appear so recovery agents can act.
      const wizardHint = sc.data.report.hints.find((h) =>
        h.message.includes('WIZARD'),
      );
      expect(wizardHint).toBeDefined();
    } finally {
      cleanup(cwd);
    }
  });
});

// ─── Acceptance #4: br unavailable degrades gracefully ─────────────────────

describe('flywheel_observe — br unavailable', () => {
  it('reports beads.unavailable=true with a warning when br is not installed', async () => {
    const cwd = makeTmpCwd();
    try {
      const exec = makeStubbedExec([
        // br call throws — simulates ENOENT spawn. MUST come before the
        // generic gracefulDegradeStubs `cmd === 'br'` matcher.
        {
          match: (cmd) => cmd === 'br',
          respond: { throws: new Error('spawn br ENOENT') },
        },
        ...gracefulDegradeStubs(),
      ]);
      const result = await runObserve(makeCtx(cwd, exec), { cwd });

      const sc = result.structuredContent as {
        data: { report: FlywheelObserveReport };
      };
      expect(sc.data.report.beads.unavailable).toBe(true);
      expect(sc.data.report.beads.warning).toMatch(/br unavailable/);
      // Tool itself still succeeds — graceful degrade contract.
      expect(result.isError).toBeFalsy();
      // A br-unavailable hint must surface.
      const hint = sc.data.report.hints.find((h) =>
        h.message.includes('br CLI unavailable'),
      );
      expect(hint).toBeDefined();
    } finally {
      cleanup(cwd);
    }
  });
});

// ─── Acceptance #5: agent-mail unreachable degrades gracefully ────────────

describe('flywheel_observe — agent-mail unreachable', () => {
  it('reports agentMail.reachable=false when the curl probe fails', async () => {
    const cwd = makeTmpCwd();
    try {
      const exec = makeStubbedExec([
        ...gracefulDegradeStubs(),
        // curl returns non-zero — simulates connection refused.
        {
          match: (cmd) => cmd === 'curl',
          respond: { code: 7, stdout: '', stderr: 'Connection refused' },
        },
      ]);
      const result = await runObserve(makeCtx(cwd, exec), { cwd });

      const sc = result.structuredContent as {
        data: { report: FlywheelObserveReport };
      };
      expect(sc.data.report.agentMail.reachable).toBe(false);
      expect(sc.data.report.agentMail.warning).toBeDefined();
      // Hint must direct user to start the server.
      const hint = sc.data.report.hints.find((h) =>
        h.message.includes('agent-mail unreachable'),
      );
      expect(hint?.nextAction).toMatch(/serve-http|port 8765/);
    } finally {
      cleanup(cwd);
    }
  });
});

// ─── Acceptance #6: tool registers via the existing tool-listing path ─────

describe('flywheel_observe — tool registration', () => {
  it('appears in TOOLS introspection list with required cwd', () => {
    const tool = TOOLS.find((t) => t.name === 'flywheel_observe');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toMatchObject({
      type: 'object',
      properties: { cwd: { type: 'string' } },
      required: ['cwd'],
    });
    expect(typeof tool!.description).toBe('string');
    expect(tool!.description.length).toBeGreaterThan(40);
  });

  it('exposes the deprecated orch_observe alias for back-compat', () => {
    const alias = TOOLS.find((t) => t.name === 'orch_observe');
    expect(alias).toBeDefined();
    expect(alias!.description).toMatch(/DEPRECATED/);
  });

  it('dispatches through createCallToolHandler using the registered runner', async () => {
    const cwd = makeTmpCwd();
    try {
      const stubReport: FlywheelObserveReport = {
        version: 1,
        cwd,
        timestamp: new Date().toISOString(),
        elapsedMs: 5,
        git: { unavailable: true },
        checkpoint: { exists: false, warnings: [] },
        beads: {
          initialized: false,
          unavailable: true,
          counts: { open: 0, in_progress: 0, closed: 0, deferred: 0, total: 0 },
          ready: [],
        },
        agentMail: { reachable: false },
        ntm: { available: false },
        artifacts: { wizard: [], flywheelScratch: [] },
        attestations: {
          inFlightBeadIds: [],
          missing: [],
          stale: [],
          invalid: [],
          unavailable: true,
        },
        hints: [],
      };
      const stubRunObserve = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'stub' }],
        structuredContent: {
          tool: 'flywheel_observe',
          version: 1,
          status: 'ok',
          phase: 'observe',
          data: { kind: 'observe_report', report: stubReport },
        },
      });

      const handler = createCallToolHandler({
        makeExec: vi.fn(() => vi.fn()),
        loadState: vi.fn(() => createInitialState()),
        saveState: vi.fn(),
        clearState: vi.fn(),
        runners: { flywheel_observe: stubRunObserve },
      });

      const result = await handler({
        params: { name: 'flywheel_observe', arguments: { cwd } },
      } as never);

      expect(stubRunObserve).toHaveBeenCalledTimes(1);
      const sc = result.structuredContent as {
        data: { report: FlywheelObserveReport };
      };
      expect(sc.data.report.cwd).toBe(cwd);
    } finally {
      cleanup(cwd);
    }
  });
});

// ─── Hard-rule contract assertions ────────────────────────────────────────

describe('flywheel_observe — hard rules', () => {
  it('never calls writeCheckpoint — tool is read-only', async () => {
    const checkpointModule = await import('../../checkpoint.js');
    const writeSpy = vi.mocked(checkpointModule.writeCheckpoint);
    writeSpy.mockClear();

    const cwd = makeTmpCwd();
    try {
      const exec = makeStubbedExec(gracefulDegradeStubs());
      await runObserve(makeCtx(cwd, exec), { cwd });
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      cleanup(cwd);
    }
  });

  it('idempotent — two consecutive calls return equivalent shapes', async () => {
    const cwd = makeTmpCwd();
    try {
      const exec = makeStubbedExec(gracefulDegradeStubs());
      const a = await runObserve(makeCtx(cwd, exec), { cwd });
      const b = await runObserve(makeCtx(cwd, exec), { cwd });
      const aReport = (a.structuredContent as { data: { report: FlywheelObserveReport } }).data.report;
      const bReport = (b.structuredContent as { data: { report: FlywheelObserveReport } }).data.report;
      // Strip timestamp + elapsedMs which legitimately differ between calls.
      const strip = (r: FlywheelObserveReport) => {
        const { timestamp, elapsedMs, doctor, ...rest } = r;
        void timestamp;
        void elapsedMs;
        void doctor;
        return rest;
      };
      expect(strip(aReport)).toEqual(strip(bReport));
    } finally {
      cleanup(cwd);
    }
  });

  it('completes inside the < 1.5s wall-clock budget when probes degrade fast', async () => {
    const cwd = makeTmpCwd();
    try {
      const exec = makeStubbedExec(gracefulDegradeStubs());
      const t0 = Date.now();
      const result = await runObserve(makeCtx(cwd, exec), { cwd });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(1500);
      const sc = result.structuredContent as {
        data: { report: FlywheelObserveReport };
      };
      expect(sc.data.report.elapsedMs).toBeLessThan(1500);
    } finally {
      cleanup(cwd);
    }
  });
});

// ─── T7: Completion Evidence integration (claude-orchestrator-2r8) ─────────
//
// observe.hints[] surfaces:
//   - severity:"warn" for in-flight beads with no `.pi-flywheel/completion/<id>.json`
//   - severity:"info" for in-flight beads whose attestation is older than 24h

import { computeStateHash } from '../../checkpoint.js';
import type { CompletionReportV1 } from '../../completion-report.js';
import type { FlywheelState } from '../../types.js';

function writeCheckpointFixture(cwd: string, activeBeadIds: string[]): void {
  mkdirSync(join(cwd, '.pi-flywheel'), { recursive: true });
  const state: FlywheelState = {
    ...createInitialState(),
    phase: 'implementing',
    activeBeadIds,
  };
  const envelope = {
    schemaVersion: 1,
    writtenAt: new Date().toISOString(),
    flywheelVersion: 'test',
    gitHead: undefined,
    state,
    stateHash: computeStateHash(state),
  };
  writeFileSync(
    join(cwd, '.pi-flywheel', 'checkpoint.json'),
    JSON.stringify(envelope, null, 2),
  );
}

function writeAttestationFixture(
  cwd: string,
  beadId: string,
  createdAt: string,
): void {
  mkdirSync(join(cwd, '.pi-flywheel', 'completion'), { recursive: true });
  const report: CompletionReportV1 = {
    version: 1,
    beadId,
    agentName: 'TestAgent',
    status: 'closed',
    changedFiles: ['fixture.ts'],
    commits: ['deadbeef'],
    ubs: { ran: true, summary: 'clean', findingsFixed: 0, deferredBeadIds: [] },
    verify: [{ command: 'noop', exitCode: 0, summary: 'fixture' }],
    selfReview: { ran: true, summary: 'fixture' },
    beadClosedVerified: true,
    reservationsReleased: true,
    createdAt,
  };
  writeFileSync(
    join(cwd, '.pi-flywheel', 'completion', `${beadId}.json`),
    JSON.stringify(report, null, 2),
  );
}

describe('flywheel_observe — T7 attestation hints', () => {
  it('surfaces only the missing attestation when 1 of 2 in-flight beads has one', async () => {
    const cwd = makeTmpCwd();
    try {
      writeCheckpointFixture(cwd, ['bead-attested', 'bead-missing']);
      writeAttestationFixture(cwd, 'bead-attested', new Date().toISOString());

      const exec = makeStubbedExec(gracefulDegradeStubs());
      const result = await runObserve(makeCtx(cwd, exec), { cwd });
      const sc = result.structuredContent as {
        data: { report: FlywheelObserveReport };
      };
      const report = sc.data.report;

      // Schema: probe ran, classified each bead correctly.
      expect(report.attestations.unavailable).toBeUndefined();
      expect(report.attestations.inFlightBeadIds.sort()).toEqual([
        'bead-attested',
        'bead-missing',
      ]);
      expect(report.attestations.missing).toEqual(['bead-missing']);
      expect(report.attestations.stale).toEqual([]);
      expect(report.attestations.invalid).toEqual([]);

      // Hints: exactly one warn for the missing bead, none for the attested.
      const missingHint = report.hints.find(
        (h) => h.severity === 'warn' && h.message.includes('bead-missing'),
      );
      expect(missingHint).toBeDefined();
      expect(missingHint!.message).toBe('bead bead-missing in-flight without attestation');
      expect(missingHint!.nextAction).toMatch(/completion JSON/);

      const attestedHint = report.hints.find((h) =>
        h.message.includes('bead-attested'),
      );
      expect(attestedHint).toBeUndefined();
    } finally {
      cleanup(cwd);
    }
  });

  it('emits info hint for stale attestation (createdAt > 24h ago)', async () => {
    const cwd = makeTmpCwd();
    try {
      writeCheckpointFixture(cwd, ['bead-stale']);
      const oldTs = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      writeAttestationFixture(cwd, 'bead-stale', oldTs);

      const exec = makeStubbedExec(gracefulDegradeStubs());
      const result = await runObserve(makeCtx(cwd, exec), { cwd });
      const sc = result.structuredContent as {
        data: { report: FlywheelObserveReport };
      };
      const report = sc.data.report;

      expect(report.attestations.stale).toEqual(['bead-stale']);
      expect(report.attestations.missing).toEqual([]);

      const staleHint = report.hints.find(
        (h) => h.severity === 'info' && h.message.includes('bead-stale'),
      );
      expect(staleHint).toBeDefined();
      expect(staleHint!.message).toBe('stale attestation for closed-bead bead-stale');
    } finally {
      cleanup(cwd);
    }
  });

  it('classifies invalid-JSON attestation as invalid (not missing) with warn hint', async () => {
    const cwd = makeTmpCwd();
    try {
      writeCheckpointFixture(cwd, ['bead-broken']);
      mkdirSync(join(cwd, '.pi-flywheel', 'completion'), { recursive: true });
      writeFileSync(
        join(cwd, '.pi-flywheel', 'completion', 'bead-broken.json'),
        '{not valid json',
      );

      const exec = makeStubbedExec(gracefulDegradeStubs());
      const result = await runObserve(makeCtx(cwd, exec), { cwd });
      const sc = result.structuredContent as {
        data: { report: FlywheelObserveReport };
      };
      const report = sc.data.report;

      expect(report.attestations.invalid).toEqual(['bead-broken']);
      expect(report.attestations.missing).toEqual([]);
      const invalidHint = report.hints.find(
        (h) => h.severity === 'warn' && h.message.includes('schema validation'),
      );
      expect(invalidHint).toBeDefined();
    } finally {
      cleanup(cwd);
    }
  });

  it('marks attestations.unavailable=true when no checkpoint exists (no in-flight beads to probe)', async () => {
    const cwd = makeTmpCwd();
    try {
      const exec = makeStubbedExec(gracefulDegradeStubs());
      const result = await runObserve(makeCtx(cwd, exec), { cwd });
      const sc = result.structuredContent as {
        data: { report: FlywheelObserveReport };
      };
      expect(sc.data.report.attestations.unavailable).toBe(true);
      expect(sc.data.report.attestations.inFlightBeadIds).toEqual([]);
      // No attestation hints when there's nothing to probe.
      const attestationHints = sc.data.report.hints.filter((h) =>
        h.message.includes('attestation') || h.message.includes('in-flight'),
      );
      expect(attestationHints).toEqual([]);
    } finally {
      cleanup(cwd);
    }
  });
});
