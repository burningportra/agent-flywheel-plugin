import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { FlywheelState, Finding, BatchReviewVerdict } from "../types.js";

// ─── child_process.execFile mock ─────────────────────────────────────────
//
// commit-batch.ts uses `promisify(execFile)` from node:child_process. The
// REAL execFile has a `[util.promisify.custom]` symbol attached so the
// promisified version resolves with `{ stdout, stderr }`. Without that
// symbol, promisify falls back to its generic single-arg wrapper, which
// would yield just a stdout string and break the module under test.
//
// We replicate that contract here: the mock exposes both the callback-style
// signature (for any direct callers) AND the custom-promisify hook so
// `promisify(execFileMock)` behaves identically to `promisify(execFile)`.
//
// Test handlers match (cmd, args) → either a stdout string (success) or an
// Error (failure). The default handler throws to surface unhandled calls.

type ExecHandler = (
  cmd: string,
  args: readonly string[],
) => string | Error;

let execHandler: ExecHandler = () => {
  throw new Error("execFile mock invoked without a handler");
};

// Pure call-recording sink — does NOT invoke execHandler. The custom
// promisify hook below owns handler dispatch so it runs exactly once per
// call (matters for tests whose handlers carry counters/sequences).
const execFileMock = vi.fn(
  (
    _cmd: string,
    _args: readonly string[],
    _opts: unknown,
    _callback: (
      err: Error | null,
      stdout?: string,
      stderr?: string,
    ) => void,
  ) => {
    return { pid: 1, kill: vi.fn() };
  },
);

// Mirror the real execFile's util.promisify.custom contract: resolve with
// `{ stdout, stderr }` instead of the single-arg default. Records the call
// against `execFileMock` (via direct invocation with a no-op callback) so
// assertions on call count / args still work, then dispatches the handler
// exactly once and returns its result.
(execFileMock as unknown as { [k: symbol]: unknown })[promisify.custom] = (
  cmd: string,
  args: readonly string[],
  opts?: unknown,
): Promise<{ stdout: string; stderr: string }> => {
  execFileMock(cmd, args, opts, () => undefined);
  const result = execHandler(cmd, args);
  if (result instanceof Error) {
    return Promise.reject(result);
  }
  return Promise.resolve({ stdout: result, stderr: "" });
};

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("../memory.js", () => ({
  appendMemory: vi.fn(() => true),
}));

// commit-batch.ts must be imported AFTER the vi.mock calls so the mocked
// child_process binds before the module's `promisify(execFile)` runs.
const {
  countCommitsSinceLastBatchReview,
  shouldTriggerBatchReview,
  recordBatchReviewDispatch,
  applyBatchReviewVerdict,
  batchReviewVerdictPath,
} = await import("../commit-batch.js");
const { appendMemory } = await import("../memory.js");

let cwd: string;

beforeEach(() => {
  execFileMock.mockClear();
  vi.mocked(appendMemory).mockClear();
  execHandler = () => {
    throw new Error("execFile mock invoked without a handler");
  };
  cwd = mkdtempSync(join(tmpdir(), "commit-batch-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// ─── helpers ────────────────────────────────────────────────────────────

function baseState(overrides: Partial<FlywheelState> = {}): FlywheelState {
  return {
    phase: "implementing",
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

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: "medium",
    summary: "example issue",
    suggested_bead_title: "Fix example issue",
    affected_files: ["src/foo.ts"],
    evidence_excerpt: "line 42: bug",
    ...overrides,
  };
}

const RANGE = "aaa111..bbb222";

function writeVerdict(body: unknown, range = RANGE): void {
  const file = batchReviewVerdictPath(cwd, range);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
}

function verdict(overrides: Partial<BatchReviewVerdict> = {}): BatchReviewVerdict {
  return { status: "needs_attention", findings: [], sha_range: RANGE, ...overrides };
}

/** br stub: hands out <prefix>-1, <prefix>-2, … and records each create's args. */
function brCreates(opts: { failOn?: number; prefix?: string } = {}): { calls: string[][] } {
  const calls: string[][] = [];
  execHandler = (cmd, args) => {
    expect(cmd).toBe("br");
    expect(args[0]).toBe("create");
    calls.push([...args]);
    if (calls.length === opts.failOn) return new Error("database is locked");
    return `${opts.prefix ?? "bead"}-${calls.length}\n`;
  };
  return { calls };
}

function argAfter(args: string[], flag: string): string | undefined {
  return args[args.indexOf(flag) + 1];
}

// ─── countCommitsSinceLastBatchReview ───────────────────────────────────

describe("countCommitsSinceLastBatchReview", () => {
  it("parses git rev-list count with a baseline sha", async () => {
    execHandler = (cmd, args) => {
      expect(cmd).toBe("git");
      expect(args).toEqual(["rev-list", "--count", "abc123..HEAD"]);
      return "5\n";
    };
    const n = await countCommitsSinceLastBatchReview("/repo", "abc123");
    expect(n).toBe(5);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("throws when git returns non-integer output", async () => {
    execHandler = () => "not-a-number\n";
    await expect(
      countCommitsSinceLastBatchReview("/repo", "abc123"),
    ).rejects.toThrow(/non-integer count/);
  });

  it("throws when git command fails", async () => {
    execHandler = () => new Error("not a git repository");
    await expect(
      countCommitsSinceLastBatchReview("/repo", "abc123"),
    ).rejects.toThrow(/git rev-list failed/);
  });
});

// ─── shouldTriggerBatchReview ────────────────────────────────────────────

describe("shouldTriggerBatchReview", () => {
  it("returns false when live count is below threshold", () => {
    expect(shouldTriggerBatchReview(baseState({ commitBatchThreshold: 8 }), 7)).toBe(false);
  });

  it("returns true when live count equals threshold", () => {
    expect(shouldTriggerBatchReview(baseState({ commitBatchThreshold: 8 }), 8)).toBe(true);
  });

  it("returns true when live count exceeds threshold", () => {
    expect(shouldTriggerBatchReview(baseState({ commitBatchThreshold: 8 }), 20)).toBe(true);
  });

  it("returns false when threshold is 0 (feature disabled)", () => {
    expect(shouldTriggerBatchReview(baseState({ commitBatchThreshold: 0 }), 100)).toBe(false);
  });

  it("returns false when threshold is undefined (feature unset)", () => {
    expect(shouldTriggerBatchReview(baseState(), 100)).toBe(false);
  });

  it("returns false when threshold is negative", () => {
    expect(shouldTriggerBatchReview(baseState({ commitBatchThreshold: -1 }), 100)).toBe(false);
  });

  it("returns false when threshold is non-integer", () => {
    expect(shouldTriggerBatchReview(baseState({ commitBatchThreshold: 2.5 }), 100)).toBe(false);
  });
});

// ─── recordBatchReviewDispatch ───────────────────────────────────────────

describe("recordBatchReviewDispatch", () => {
  it("moves the baseline to the end of the range and marks the range pending once", () => {
    const state = baseState({ lastBatchReviewSha: "aaa111" });

    recordBatchReviewDispatch(state, RANGE);
    recordBatchReviewDispatch(state, RANGE);

    expect(state.lastBatchReviewSha).toBe("bbb222");
    expect(state.pendingBatchReviews).toEqual([RANGE]);
  });
});

// ─── applyBatchReviewVerdict ─────────────────────────────────────────────

describe("applyBatchReviewVerdict", () => {
  it("reports pending and files nothing until the reviewer writes the verdict", async () => {
    const state = baseState({ pendingBatchReviews: [RANGE] });

    const applied = await applyBatchReviewVerdict(cwd, state, RANGE);

    expect(applied).toEqual({ kind: "pending" });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(state.pendingBatchReviews).toEqual([RANGE]);
    expect(state.batchReviewSynthesizedBeads).toBeUndefined();
  });

  it("files every finding whatever the status, at a priority that follows its severity", async () => {
    const { calls } = brCreates();
    writeVerdict(verdict({
      status: "needs_attention",
      findings: [
        finding({ severity: "low", suggested_bead_title: "Low fix" }),
        finding({ severity: "critical", suggested_bead_title: "Critical fix" }),
        finding({ severity: "medium", suggested_bead_title: "Medium fix" }),
        finding({ severity: "high", suggested_bead_title: "High fix" }),
      ],
    }));
    const state = baseState({ pendingBatchReviews: [RANGE, "ccc333..ddd444"] });

    const applied = await applyBatchReviewVerdict(cwd, state, RANGE);

    expect(applied).toMatchObject({ kind: "filed", beadIds: ["bead-1", "bead-2", "bead-3", "bead-4"] });
    expect(calls.map((args) => [argAfter(args, "--title"), argAfter(args, "--priority")])).toEqual([
      ["Low fix", "3"],
      ["Critical fix", "0"],
      ["Medium fix", "2"],
      ["High fix", "1"],
    ]);
    expect(state.batchReviewSynthesizedBeads).toEqual({ [RANGE]: ["bead-1", "bead-2", "bead-3", "bead-4"] });
    expect(state.pendingBatchReviews).toEqual(["ccc333..ddd444"]);
  });

  it("labels each bead with the goal program and puts the finding in its description", async () => {
    const programLabel = "flywheel-goal:goal-a:ccba1a8c";
    const { calls } = brCreates();
    writeVerdict(verdict({
      status: "blocking",
      findings: [finding({ severity: "high", summary: "the bug", affected_files: ["src/x.ts"], evidence_excerpt: "boom" })],
    }));
    const state = baseState({ beadProgramScope: { kind: "tagged", label: programLabel } });

    await applyBatchReviewVerdict(cwd, state, RANGE);

    expect(argAfter(calls[0]!, "--labels")).toBe(`auto-batch-review,${programLabel}`);
    const body = argAfter(calls[0]!, "--description")!;
    expect(body).toContain("the bug");
    expect(body).toContain("Severity: high");
    expect(body).toContain(RANGE);
    expect(body).toContain("- src/x.ts");
    expect(body).toContain("boom");
  });

  it("settles a clean pass without filing anything", async () => {
    writeVerdict(verdict({ status: "pass" }));
    const state = baseState({ pendingBatchReviews: [RANGE] });

    const applied = await applyBatchReviewVerdict(cwd, state, RANGE);

    expect(applied).toMatchObject({ kind: "filed", beadIds: [] });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(state.pendingBatchReviews).toEqual([]);
  });

  it("resumes after a failed br create without filing any finding twice", async () => {
    writeVerdict(verdict({
      findings: [
        finding({ suggested_bead_title: "First" }),
        finding({ suggested_bead_title: "Second" }),
        finding({ suggested_bead_title: "Third" }),
      ],
    }));
    const state = baseState({ pendingBatchReviews: [RANGE] });

    brCreates({ failOn: 2 });
    await expect(applyBatchReviewVerdict(cwd, state, RANGE)).rejects.toThrow(/br create failed for finding 2\/3.*database is locked/);
    expect(state.batchReviewSynthesizedBeads).toEqual({ [RANGE]: ["bead-1"] });
    expect(state.pendingBatchReviews).toEqual([RANGE]);

    const retry = brCreates({ prefix: "retry" });
    const applied = await applyBatchReviewVerdict(cwd, state, RANGE);
    expect(retry.calls.map((args) => argAfter(args, "--title"))).toEqual(["Second", "Third"]);
    expect(applied).toMatchObject({ kind: "filed", beadIds: ["bead-1", "retry-1", "retry-2"] });
    expect(state.pendingBatchReviews).toEqual([]);

    const again = brCreates();
    await applyBatchReviewVerdict(cwd, state, RANGE);
    expect(again.calls).toEqual([]);
  });

  it("files one re-review bead and one CASS note for a verdict that isn't JSON, however often it's applied", async () => {
    const { calls } = brCreates();
    writeVerdict("Here are my findings: the cache leaks.");
    const state = baseState({ pendingBatchReviews: [RANGE] });

    const applied = await applyBatchReviewVerdict(cwd, state, RANGE);
    await applyBatchReviewVerdict(cwd, state, RANGE);

    expect(applied).toMatchObject({ kind: "malformed", beadIds: ["bead-1"], rawSnippet: "Here are my findings: the cache leaks." });
    expect(calls).toHaveLength(1);
    expect(argAfter(calls[0]!, "--title")).toBe(`Re-review commits ${RANGE} (batch-review verdict unreadable)`);
    expect(argAfter(calls[0]!, "--priority")).toBe("1");
    expect(argAfter(calls[0]!, "--description")).toContain(`git diff ${RANGE}`);
    expect(argAfter(calls[0]!, "--description")).toContain("the cache leaks");
    expect(vi.mocked(appendMemory)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appendMemory).mock.calls[0]![1]).toMatch(/malformed batch-review verdict \(sha range aaa111\.\.bbb222\): Verdict JSON parse failed/);
    expect(state.pendingBatchReviews).toEqual([]);
  });

  it("treats a schema violation or a verdict for another range as unreadable", async () => {
    brCreates();
    writeVerdict({ status: "blocking", findings: [{ summary: "no severity" }], sha_range: RANGE });
    const schemaState = baseState();
    const schema = await applyBatchReviewVerdict(cwd, schemaState, RANGE);
    expect(schema).toMatchObject({ kind: "malformed", reason: expect.stringContaining("BatchReviewVerdictSchema") });

    writeVerdict(verdict({ sha_range: "eee555..fff666" }));
    const mismatch = await applyBatchReviewVerdict(cwd, baseState(), RANGE);
    expect(mismatch).toMatchObject({ kind: "malformed", reason: expect.stringContaining("eee555..fff666") });
  });
});
