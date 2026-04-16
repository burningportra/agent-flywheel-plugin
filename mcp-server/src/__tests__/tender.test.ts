import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwarmTender, emitTelemetry, TELEMETRY_DIR, TELEMETRY_FILE } from '../tender.js';
import type {
  SwarmTenderOptions,
  AgentStatus,
  SwarmCompletionSummary,
  TenderTelemetryEvent,
} from '../tender.js';
import type { ExecFn } from '../exec.js';

// ─── Mocks ──────────────────────────────────────────────────────

// Mock agent-mail so nudgeStuckAgent and releaseStaleReservations don't hit the network
vi.mock('../agent-mail.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  forceReleaseFileReservation: vi.fn().mockResolvedValue(undefined),
  checkFileReservations: vi.fn().mockResolvedValue([]),
  fetchInbox: vi.fn().mockResolvedValue([]),
  whoisAgent: vi.fn().mockResolvedValue({}),
}));

// Mock logger so test output stays clean
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ─── Helpers ────────────────────────────────────────────────────

/** exec that always reports a clean empty worktree (no git changes). */
const noChangesExec: ExecFn = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });

/** exec that simulates a worktree with changed files. */
function changedFilesExec(files: string[]): ExecFn {
  return vi.fn().mockResolvedValue({
    code: 0,
    stdout: files.map((f) => `M  ${f}`).join('\n'),
    stderr: '',
  });
}

function makeTender(
  worktrees: { path: string; stepIndex: number }[],
  options: SwarmTenderOptions = {},
  exec: ExecFn = noChangesExec
): SwarmTender {
  return new SwarmTender(exec, '/fake/cwd', worktrees, options);
}

// ─── Constructor & basic state ───────────────────────────────────

describe('SwarmTender — constructor', () => {
  it('initialises agents with nudgesSent=0 and lastNudgedAt=0', () => {
    const tender = makeTender([{ path: '/wt/0', stepIndex: 0 }]);
    const [agent] = tender.getStatus();
    expect(agent.nudgesSent).toBe(0);
    expect(agent.lastNudgedAt).toBe(0);
  });

  it('getSummary returns "no agents" when worktrees is empty', () => {
    const tender = makeTender([]);
    expect(tender.getSummary()).toBe('no agents');
  });
});

// ─── Escalation state machine ────────────────────────────────────

describe('SwarmTender — auto-escalation (flywheelAgentName set)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('nudges a stuck agent on the first poll after stuckThreshold', async () => {
    const onStuck = vi.fn();
    const onKill = vi.fn();
    // Use a very large pollInterval so only the initial poll fires (start() calls poll once immediately)
    // and a large killWaitMs so the agent won't be killed during this test
    const tender = makeTender(
      [{ path: '/wt/0', stepIndex: 0 }],
      {
        config: {
          stuckThreshold: 1_000,
          idleThreshold: 500,
          pollInterval: 999_999,
          cadenceIntervalMs: 999_999,
          nudgeDelayMs: 0,
          maxNudges: 2,
          killWaitMs: 999_999,
        },
        flywheelAgentName: 'Coordinator',
        onStuck,
        onKill,
      }
    );

    // Advance time past stuckThreshold before starting, so agent registers as stuck on first poll
    vi.advanceTimersByTime(2_000);

    // start() calls poll() immediately; advance by 0 to let the async poll settle
    tender.start();
    await vi.advanceTimersByTimeAsync(0);
    tender.stop();

    const [agent] = tender.getStatus();
    expect(agent).toBeDefined();
    expect(agent.nudgesSent).toBe(1);
    expect(agent.lastNudgedAt).toBeGreaterThan(0);
    expect(onKill).not.toHaveBeenCalled();
  });

  it('kills agent after maxNudges + killWaitMs with no activity', async () => {
    const onKill = vi.fn();
    const onSwarmComplete = vi.fn();
    // pollInterval controls when polls fire after the first immediate one
    // stuckThreshold=0 so agent is immediately stuck on first poll
    // maxNudges=1: one nudge then kill after killWaitMs
    const POLL = 100;
    const tender = makeTender(
      [{ path: '/wt/0', stepIndex: 0 }],
      {
        config: {
          stuckThreshold: 0,   // immediately stuck
          idleThreshold: 0,
          pollInterval: POLL,
          cadenceIntervalMs: 999_999,
          nudgeDelayMs: 0,
          maxNudges: 1,
          killWaitMs: POLL,    // kill after one poll interval
        },
        flywheelAgentName: 'Coordinator',
        onKill,
        onSwarmComplete,
      }
    );

    // Advance 1ms so elapsed(1) > stuckThreshold(0) on first poll
    vi.advanceTimersByTime(1);
    tender.start();
    // Poll 1 (immediate): agent stuck → nudge sent (nudgesSent=1)
    await vi.advanceTimersByTimeAsync(0);

    // Advance past killWaitMs so the next interval poll triggers kill
    await vi.advanceTimersByTimeAsync(POLL + 1);
    tender.stop();

    expect(onKill).toHaveBeenCalledTimes(1);
    const killedAgent: AgentStatus = onKill.mock.calls[0][0];
    expect(killedAgent.stepIndex).toBe(0);

    // onSwarmComplete fires because it was the only agent
    expect(onSwarmComplete).toHaveBeenCalledTimes(1);
    const summary: SwarmCompletionSummary = onSwarmComplete.mock.calls[0][0];
    expect(summary.killedStuck).toBe(1);
    expect(summary.completedNormally).toBe(0);
    expect(summary.totalAgents).toBe(1);
    expect(summary.stuckAgentNames).toContain('/wt/0');
  });

  it('does NOT auto-escalate when flywheelAgentName is absent', async () => {
    const onKill = vi.fn();
    const tender = makeTender(
      [{ path: '/wt/0', stepIndex: 0 }],
      {
        config: {
          stuckThreshold: 0,
          idleThreshold: 0,
          pollInterval: 999_999,  // large — only initial poll fires
          cadenceIntervalMs: 999_999,
          nudgeDelayMs: 0,
          maxNudges: 1,
          killWaitMs: 0,
        },
        // flywheelAgentName intentionally omitted
        onKill,
      }
    );

    tender.start();
    await vi.advanceTimersByTimeAsync(0); // let the initial poll settle
    tender.stop();

    const [agent] = tender.getStatus();
    expect(agent).toBeDefined();
    expect(agent.nudgesSent).toBe(0);
    expect(onKill).not.toHaveBeenCalled();
  });
});

// ─── removeAgent + onSwarmComplete ───────────────────────────────

describe('SwarmTender — removeAgent and onSwarmComplete', () => {
  it('fires onSwarmComplete when the last agent is removed normally', () => {
    const onSwarmComplete = vi.fn();
    const tender = makeTender(
      [{ path: '/wt/0', stepIndex: 0 }, { path: '/wt/1', stepIndex: 1 }],
      { onSwarmComplete }
    );

    tender.removeAgent(0);
    expect(onSwarmComplete).not.toHaveBeenCalled(); // 1 agent still active

    tender.removeAgent(1);
    expect(onSwarmComplete).toHaveBeenCalledTimes(1);

    const summary: SwarmCompletionSummary = onSwarmComplete.mock.calls[0][0];
    expect(summary.totalAgents).toBe(2);
    expect(summary.completedNormally).toBe(2);
    expect(summary.killedStuck).toBe(0);
    expect(summary.stuckAgentNames).toHaveLength(0);
  });

  it('does not throw when onSwarmComplete is not set', () => {
    const tender = makeTender([{ path: '/wt/0', stepIndex: 0 }]);
    expect(() => tender.removeAgent(0)).not.toThrow();
  });

  it('stops the polling timer when last agent is removed', () => {
    const tender = makeTender([{ path: '/wt/0', stepIndex: 0 }]);
    tender.start();
    expect(tender['timer']).not.toBeNull();
    tender.removeAgent(0);
    expect(tender['timer']).toBeNull();
  });

  it('elapsedMs in summary is non-negative', () => {
    const onSwarmComplete = vi.fn();
    const tender = makeTender([{ path: '/wt/0', stepIndex: 0 }], { onSwarmComplete });
    tender.removeAgent(0);
    const summary: SwarmCompletionSummary = onSwarmComplete.mock.calls[0][0];
    expect(summary.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── getSummary ──────────────────────────────────────────────────

describe('SwarmTender — getSummary', () => {
  it('reflects active agent count', () => {
    const tender = makeTender([
      { path: '/wt/0', stepIndex: 0 },
      { path: '/wt/1', stepIndex: 1 },
    ]);
    expect(tender.getSummary()).toBe('2 active');
  });

  it('returns "no agents" after all removed', () => {
    const tender = makeTender([{ path: '/wt/0', stepIndex: 0 }]);
    tender.removeAgent(0);
    expect(tender.getSummary()).toBe('no agents');
  });
});

// ─── Telemetry: emitTelemetry ─────────────────────────────────────

describe('emitTelemetry', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tender-telemetry-'));
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('creates the .pi-flywheel dir and appends valid NDJSON', () => {
    const event: TenderTelemetryEvent = {
      kind: 'poll_summary',
      ts: new Date().toISOString(),
      activeAgents: 2,
      stuckAgents: 1,
      nudgesThisCycle: 0,
    };
    emitTelemetry(event, tmp);

    const logPath = join(tmp, TELEMETRY_DIR, TELEMETRY_FILE);
    expect(existsSync(logPath)).toBe(true);

    const contents = readFileSync(logPath, 'utf8');
    expect(contents.endsWith('\n')).toBe(true);
    const lines = contents.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toEqual(event);
  });

  it('appends multiple events as separate NDJSON lines', () => {
    const e1: TenderTelemetryEvent = {
      kind: 'nudge_sent',
      ts: new Date().toISOString(),
      agent: 'agent-a',
      reason: 'stuck',
      nudgeCount: 1,
      elapsedSinceActivityMs: 301_000,
    };
    const e2: TenderTelemetryEvent = {
      kind: 'conflict_detected',
      ts: new Date().toISOString(),
      file: 'src/foo.ts',
      worktrees: ['/wt/0', '/wt/1'],
    };
    emitTelemetry(e1, tmp);
    emitTelemetry(e2, tmp);

    const logPath = join(tmp, TELEMETRY_DIR, TELEMETRY_FILE);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(e1);
    expect(JSON.parse(lines[1])).toEqual(e2);
  });

  it('does not throw when cwd is unwritable (nonexistent parent under a file)', () => {
    // Create a regular file and try to use it as a cwd — mkdirSync(recursive) will throw
    // because a file exists where a directory is needed.
    const filePath = join(tmp, 'not-a-dir');
    // Write a file at that path
    require('node:fs').writeFileSync(filePath, 'blocker');

    const event: TenderTelemetryEvent = {
      kind: 'poll_summary',
      ts: new Date().toISOString(),
      activeAgents: 0,
      stuckAgents: 0,
      nudgesThisCycle: 0,
    };

    expect(() => emitTelemetry(event, filePath)).not.toThrow();
  });
});

// ─── Telemetry: SwarmTender integration ──────────────────────────

describe('SwarmTender — telemetry integration', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tender-swarm-telemetry-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('emits at least one nudge_sent and one poll_summary event to the log', async () => {
    const exec: ExecFn = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const tender = new SwarmTender(
      exec,
      tmp,
      [{ path: '/wt/0', stepIndex: 0 }],
      {
        config: {
          stuckThreshold: 1_000,
          idleThreshold: 500,
          pollInterval: 999_999,
          cadenceIntervalMs: 999_999,
          nudgeDelayMs: 0,
          maxNudges: 2,
          killWaitMs: 999_999,
        },
        flywheelAgentName: 'Coordinator',
      }
    );

    // Advance time past stuckThreshold before starting
    vi.advanceTimersByTime(2_000);
    tender.start();
    await vi.advanceTimersByTimeAsync(0);
    // Allow the nudgeStuckAgent promise chain to settle
    await vi.advanceTimersByTimeAsync(10);
    tender.stop();

    const logPath = join(tmp, TELEMETRY_DIR, TELEMETRY_FILE);
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    const events = lines.map((l) => JSON.parse(l) as TenderTelemetryEvent);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('poll_summary');
    expect(kinds).toContain('nudge_sent');
  });
});
