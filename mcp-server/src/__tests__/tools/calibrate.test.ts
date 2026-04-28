import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCalibrate } from '../../tools/calibrate.js';
import { EFFORT_TO_MINUTES } from '../../types.js';
import { makeExecFn, type ExecStub } from '../chaos/_helpers.js';

// Relative to actual current time so sinceDays filter works correctly
const NOW_MS = Date.now();

// Beads created 5 days ago (well within default 90-day window)
const CREATED_5D = new Date(NOW_MS - 5 * 86_400_000).toISOString();
// Beads created 100 days ago (outside 90-day window)
const CREATED_100D = new Date(NOW_MS - 100 * 86_400_000).toISOString();
// closed_ts 1 hour after created_ts = 60 minutes
const closedTs = (createdTs: string, offsetMs: number) =>
  new Date(new Date(createdTs).getTime() + offsetMs).toISOString();

function makeTemplatedBead(id: string, template: string, createdTs: string, offsetMs: number) {
  return {
    id,
    title: `Bead ${id}`,
    status: 'closed',
    template,
    created_ts: createdTs,
    closed_ts: closedTs(createdTs, offsetMs),
  };
}

function makeUntemplatedBead(id: string, createdTs: string, offsetMs: number) {
  return {
    id,
    title: `Untemplated ${id}`,
    status: 'closed',
    created_ts: createdTs,
    closed_ts: closedTs(createdTs, offsetMs),
  };
}

// 10 templated beads using add-api-endpoint (estimatedEffort: "M" = 90min)
// each takes 60 minutes
const TEMPLATED_BEADS = Array.from({ length: 10 }, (_, i) =>
  makeTemplatedBead(`t-bead-${i}`, 'add-api-endpoint', CREATED_5D, 60 * 60_000),
);

// 3 untemplated beads
const UNTEMPLATED_BEADS = Array.from({ length: 3 }, (_, i) =>
  makeUntemplatedBead(`u-bead-${i}`, CREATED_5D, 45 * 60_000),
);

// 2 clock-skewed beads (closed_ts < created_ts)
const SKEWED_BEADS = [
  {
    id: 'skew-0',
    title: 'Skewed 0',
    status: 'closed',
    template: 'add-api-endpoint',
    created_ts: CREATED_5D,
    closed_ts: new Date(new Date(CREATED_5D).getTime() - 3600_000).toISOString(),
  },
  {
    id: 'skew-1',
    title: 'Skewed 1',
    status: 'closed',
    template: 'add-api-endpoint',
    created_ts: CREATED_5D,
    closed_ts: new Date(new Date(CREATED_5D).getTime() - 1800_000).toISOString(),
  },
];

// 1 malformed bead (missing closed_ts)
const MALFORMED_BEAD = {
  id: 'malform-0',
  title: 'Malformed',
  status: 'closed',
  template: 'add-api-endpoint',
  created_ts: CREATED_5D,
};

// 1 old bead (outside sinceDays window)
const OLD_BEAD = makeTemplatedBead('old-0', 'add-api-endpoint', CREATED_100D, 60 * 60_000);

const ALL_BEADS = [
  ...TEMPLATED_BEADS,
  ...UNTEMPLATED_BEADS,
  ...SKEWED_BEADS,
  MALFORMED_BEAD,
  OLD_BEAD,
];

function makeBrStub(beads: object[]): ExecStub {
  return {
    match: (cmd, args) => cmd === 'br' && args[0] === 'list' && args[1] === '--json',
    respond: { result: { code: 0, stdout: JSON.stringify(beads), stderr: '' } },
  };
}

// git log returns empty for all beads (so proxy_started = true)
const gitNoMatchStub: ExecStub = {
  match: (cmd, args) => cmd === 'git' && args[0] === 'log',
  respond: { result: { code: 0, stdout: '', stderr: '' } },
};

// git log returns a valid ts for templated beads (proxy_started = false)
function makeGitMatchStub(beadId: string, ts: string): ExecStub {
  return {
    match: (cmd, args) =>
      cmd === 'git' && args[0] === 'log' && args.some((a) => a.includes(beadId)),
    respond: { result: { code: 0, stdout: ts, stderr: '' } },
  };
}

function makeCwd(): string {
  return mkdtempSync(join(tmpdir(), 'calibrate-test-'));
}

describe('tools/calibrate — runCalibrate', () => {
  it('10 templated + 3 untemplated + 2 skewed + 1 malformed → correct counts', async () => {
    const cwd = makeCwd();
    const exec = makeExecFn([makeBrStub(ALL_BEADS), gitNoMatchStub]);
    const signal = new AbortController().signal;

    const report = await runCalibrate({ cwd, sinceDays: 90 }, exec, signal);

    // OLD_BEAD is outside window → not counted
    // In-window: 10 templated + 3 untemplated + 2 skewed + 1 malformed = 16
    expect(report.totalBeadsConsidered).toBe(16);
    // skewed (2) + malformed (1) = 3 dropped
    expect(report.droppedBeads).toBe(3);
    // untemplated count
    expect(report.untemplated.count).toBe(3);
  });

  it('sinceDays filter excludes older beads', async () => {
    const cwd = makeCwd();
    const beads = [
      makeTemplatedBead('recent', 'add-api-endpoint', CREATED_5D, 60 * 60_000),
      makeTemplatedBead('old', 'add-api-endpoint', CREATED_100D, 60 * 60_000),
    ];
    const exec = makeExecFn([makeBrStub(beads), gitNoMatchStub]);
    const signal = new AbortController().signal;

    const report = await runCalibrate({ cwd, sinceDays: 30 }, exec, signal);

    expect(report.totalBeadsConsidered).toBe(1);
    expect(report.sinceDays).toBe(30);
  });

  it('clock-skewed beads appear in droppedBeads, not in rows', async () => {
    const cwd = makeCwd();
    const beads = [...SKEWED_BEADS, makeTemplatedBead('valid', 'add-api-endpoint', CREATED_5D, 60 * 60_000)];
    const exec = makeExecFn([makeBrStub(beads), gitNoMatchStub]);
    const signal = new AbortController().signal;

    const report = await runCalibrate({ cwd, sinceDays: 90 }, exec, signal);

    expect(report.droppedBeads).toBe(2);
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.totalBeadsConsidered).toBe(3);
  });

  it('untemplated beads bucket under __untemplated__, not in rows', async () => {
    const cwd = makeCwd();
    const exec = makeExecFn([makeBrStub(UNTEMPLATED_BEADS), gitNoMatchStub]);
    const signal = new AbortController().signal;

    const report = await runCalibrate({ cwd, sinceDays: 90 }, exec, signal);

    expect(report.untemplated.count).toBe(3);
    expect(report.rows).toHaveLength(0);
  });

  it('ratio = meanMinutes / EFFORT_TO_MINUTES[effort]', async () => {
    const cwd = makeCwd();
    // 5 beads each taking exactly 90 minutes → mean = 90, effort M = 90 → ratio = 1.0
    const beads = Array.from({ length: 5 }, (_, i) =>
      makeTemplatedBead(`r-${i}`, 'add-api-endpoint', CREATED_5D, 90 * 60_000),
    );
    const exec = makeExecFn([makeBrStub(beads), gitNoMatchStub]);
    const signal = new AbortController().signal;

    const report = await runCalibrate({ cwd, sinceDays: 90 }, exec, signal);

    expect(report.rows.length).toBe(1);
    const row = report.rows[0]!;
    expect(row.estimatedEffort).toBe('M');
    expect(row.estimatedMinutes).toBe(EFFORT_TO_MINUTES['M']);
    expect(row.ratio).toBeCloseTo(1.0, 5);
  });

  it('aggregates Template metadata extracted from br descriptions with br timestamp fields', async () => {
    const cwd = makeCwd();
    const beads = [
      {
        id: 'desc-template-0',
        title: 'Add endpoint from description metadata',
        status: 'closed',
        description: 'Template: add-api-endpoint\n\nImplement the endpoint.\n\n### Files:\n- src/api/users.ts',
        created_at: CREATED_5D,
        closed_at: closedTs(CREATED_5D, 90 * 60_000),
      },
    ];
    const exec = makeExecFn([makeBrStub(beads), gitNoMatchStub]);
    const signal = new AbortController().signal;

    const report = await runCalibrate({ cwd, sinceDays: 90 }, exec, signal);

    expect(report.untemplated.count).toBe(0);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      templateId: 'add-api-endpoint',
      estimatedEffort: 'M',
      sampleCount: 1,
    });
  });

  it('proxy_started = false when git returns a timestamp', async () => {
    const cwd = makeCwd();
    const bead = makeTemplatedBead('git-bead-0', 'add-api-endpoint', CREATED_5D, 60 * 60_000);
    // git returns the same created_ts — duration still positive
    const gitStub = makeGitMatchStub('git-bead-0', CREATED_5D);
    const beads = [bead];
    const exec = makeExecFn([makeBrStub(beads), gitStub, gitNoMatchStub]);
    const signal = new AbortController().signal;

    const report = await runCalibrate({ cwd, sinceDays: 90 }, exec, signal);

    expect(report.rows.length).toBe(1);
    // proxyStartedCount should be 0 since git matched
    expect(report.rows[0]!.proxyStartedCount).toBe(0);
  });

  it('proxy_started = true when git returns nothing', async () => {
    const cwd = makeCwd();
    const beads = Array.from({ length: 3 }, (_, i) =>
      makeTemplatedBead(`proxy-${i}`, 'add-api-endpoint', CREATED_5D, 60 * 60_000),
    );
    const exec = makeExecFn([makeBrStub(beads), gitNoMatchStub]);
    const signal = new AbortController().signal;

    const report = await runCalibrate({ cwd, sinceDays: 90 }, exec, signal);

    expect(report.rows.length).toBe(1);
    expect(report.rows[0]!.proxyStartedCount).toBe(3);
  });

  it('br list non-zero exit → throws FlywheelError with cli_failure code', async () => {
    const cwd = makeCwd();
    const failStub: ExecStub = {
      match: (cmd, args) => cmd === 'br' && args[0] === 'list',
      respond: { result: { code: 1, stdout: '', stderr: 'br: command error' } },
    };
    const exec = makeExecFn([failStub]);
    const signal = new AbortController().signal;

    await expect(runCalibrate({ cwd, sinceDays: 90 }, exec, signal)).rejects.toMatchObject({
      code: 'cli_failure',
    });
  });

  it('report generatedAt is a valid ISO string', async () => {
    const cwd = makeCwd();
    const exec = makeExecFn([makeBrStub([]), gitNoMatchStub]);
    const signal = new AbortController().signal;

    const report = await runCalibrate({ cwd, sinceDays: 90 }, exec, signal);

    expect(() => new Date(report.generatedAt)).not.toThrow();
    expect(isNaN(new Date(report.generatedAt).getTime())).toBe(false);
  });
});
