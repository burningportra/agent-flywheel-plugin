import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SwarmTender, DEFAULT_TENDER_CONFIG, loadTenderConfig } from '../tender.js';
import type { SwarmTenderOptions, AgentStatus, SwarmCompletionSummary } from '../tender.js';
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

// ─── loadTenderConfig ───────────────────────────────────────────

describe('loadTenderConfig', () => {
  let tmpDir: string;
  const envKeys = [
    'FLYWHEEL_TENDER_POLLINTERVAL',
    'FLYWHEEL_TENDER_STUCKTHRESHOLD',
    'FLYWHEEL_TENDER_IDLETHRESHOLD',
    'FLYWHEEL_TENDER_CADENCEINTERVALMS',
    'FLYWHEEL_TENDER_CROSSREVIEWINTERVALMS',
    'FLYWHEEL_TENDER_COMMITCADENCEMS',
    'FLYWHEEL_TENDER_NUDGEDELAYMS',
    'FLYWHEEL_TENDER_MAXNUDGES',
    'FLYWHEEL_TENDER_KILLWAITMS',
    'FLYWHEEL_TENDER_MAXNUDGESPERPOLL',
    'FLYWHEEL_TENDER_BOGUS',
  ];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-cfg-'));
    for (const k of envKeys) delete process.env[k];
  });

  afterEach(() => {
    for (const k of envKeys) delete process.env[k];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when no file or env is present', () => {
    const cfg = loadTenderConfig(tmpDir);
    expect(cfg).toEqual(DEFAULT_TENDER_CONFIG);
    // maxNudgesPerPoll default is 3
    expect(cfg.maxNudgesPerPoll).toBe(3);
  });

  it('applies JSON file overrides', () => {
    const cfgDir = path.join(tmpDir, '.pi-flywheel');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, 'tender.config.json'),
      JSON.stringify({ pollInterval: 1234, maxNudgesPerPoll: 7 })
    );

    const cfg = loadTenderConfig(tmpDir);
    expect(cfg.pollInterval).toBe(1234);
    expect(cfg.maxNudgesPerPoll).toBe(7);
    // untouched keys keep their defaults
    expect(cfg.stuckThreshold).toBe(DEFAULT_TENDER_CONFIG.stuckThreshold);
  });

  it('applies env var overrides', () => {
    process.env.FLYWHEEL_TENDER_POLLINTERVAL = '5555';
    process.env.FLYWHEEL_TENDER_MAXNUDGESPERPOLL = '9';

    const cfg = loadTenderConfig(tmpDir);
    expect(cfg.pollInterval).toBe(5555);
    expect(cfg.maxNudgesPerPoll).toBe(9);
  });

  it('env var wins over file on conflict', () => {
    const cfgDir = path.join(tmpDir, '.pi-flywheel');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, 'tender.config.json'),
      JSON.stringify({ pollInterval: 1111, maxNudges: 4 })
    );
    process.env.FLYWHEEL_TENDER_POLLINTERVAL = '9999';

    const cfg = loadTenderConfig(tmpDir);
    expect(cfg.pollInterval).toBe(9999); // env wins
    expect(cfg.maxNudges).toBe(4);       // file-only key preserved
  });

  it('ignores unknown JSON keys and non-numeric values', () => {
    const cfgDir = path.join(tmpDir, '.pi-flywheel');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, 'tender.config.json'),
      JSON.stringify({
        notARealKey: 42,
        pollInterval: 'not-a-number',
        maxNudgesPerPoll: 11,
      })
    );

    const cfg = loadTenderConfig(tmpDir);
    // Unknown key doesn't leak onto the config object
    expect((cfg as any).notARealKey).toBeUndefined();
    // Non-numeric value is ignored, default preserved
    expect(cfg.pollInterval).toBe(DEFAULT_TENDER_CONFIG.pollInterval);
    // Valid entry alongside bad ones is still applied
    expect(cfg.maxNudgesPerPoll).toBe(11);
  });

  it('ignores unknown FLYWHEEL_TENDER_* env vars', () => {
    process.env.FLYWHEEL_TENDER_BOGUS = '123';
    const cfg = loadTenderConfig(tmpDir);
    expect((cfg as any).BOGUS).toBeUndefined();
    expect((cfg as any).bogus).toBeUndefined();
    expect(cfg).toEqual(DEFAULT_TENDER_CONFIG);
  });
});

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
