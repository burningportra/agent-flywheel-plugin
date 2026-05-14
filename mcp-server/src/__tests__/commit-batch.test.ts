import { describe, it, expect, vi, beforeEach } from "vitest";
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

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// commit-batch.ts must be imported AFTER the vi.mock calls so the mocked
// child_process binds before the module's `promisify(execFile)` runs.
const {
  countCommitsSinceLastBatchReview,
  shouldTriggerBatchReview,
  recordBatchReview,
  synthesizeBeadsFromFindings,
  rollbackSynthesizedBeads,
} = await import("../commit-batch.js");

beforeEach(() => {
  execFileMock.mockClear();
  execHandler = () => {
    throw new Error("execFile mock invoked without a handler");
  };
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

  it("falls back to total HEAD count when sha is undefined", async () => {
    execHandler = (cmd, args) => {
      expect(cmd).toBe("git");
      expect(args).toEqual(["rev-list", "--count", "HEAD"]);
      return "42\n";
    };
    const n = await countCommitsSinceLastBatchReview("/repo", undefined);
    expect(n).toBe(42);
  });

  it("falls back to total HEAD count when sha is empty string", async () => {
    execHandler = (_cmd, args) => {
      expect(args).toEqual(["rev-list", "--count", "HEAD"]);
      return "0\n";
    };
    const n = await countCommitsSinceLastBatchReview("/repo", "");
    expect(n).toBe(0);
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
  it("returns false when counter is below threshold", () => {
    const s = baseState({ commitBatchCounter: 7, commitBatchThreshold: 8 });
    expect(shouldTriggerBatchReview(s)).toBe(false);
  });

  it("returns true when counter equals threshold", () => {
    const s = baseState({ commitBatchCounter: 8, commitBatchThreshold: 8 });
    expect(shouldTriggerBatchReview(s)).toBe(true);
  });

  it("returns true when counter exceeds threshold", () => {
    const s = baseState({ commitBatchCounter: 9, commitBatchThreshold: 8 });
    expect(shouldTriggerBatchReview(s)).toBe(true);
  });

  it("returns false when threshold is 0 (feature disabled)", () => {
    const s = baseState({ commitBatchCounter: 8, commitBatchThreshold: 0 });
    expect(shouldTriggerBatchReview(s)).toBe(false);
  });

  it("returns false when threshold is undefined (feature unset)", () => {
    const s = baseState({ commitBatchCounter: 8 });
    expect(shouldTriggerBatchReview(s)).toBe(false);
  });

  it("returns false when threshold is negative", () => {
    const s = baseState({ commitBatchCounter: 8, commitBatchThreshold: -3 });
    expect(shouldTriggerBatchReview(s)).toBe(false);
  });

  it("returns false when threshold is non-integer", () => {
    const s = baseState({ commitBatchCounter: 8, commitBatchThreshold: 8.5 });
    expect(shouldTriggerBatchReview(s)).toBe(false);
  });
});

// ─── recordBatchReview ───────────────────────────────────────────────────

describe("recordBatchReview", () => {
  const verdict = (status: BatchReviewVerdict["status"]): BatchReviewVerdict => ({
    status,
    findings: [],
    sha_range: "old..new",
  });

  it("resets counter and advances baseline on pass", () => {
    const before = baseState({
      commitBatchCounter: 8,
      lastBatchReviewSha: "old",
    });
    const after = recordBatchReview(before, "new", verdict("pass"));
    expect(after.commitBatchCounter).toBe(0);
    expect(after.lastBatchReviewSha).toBe("new");
    expect(after.batchReviewSynthesizedBeads).toBeUndefined();
  });

  it("does NOT mutate the input state (immutable contract)", () => {
    const before = baseState({
      commitBatchCounter: 8,
      lastBatchReviewSha: "old",
    });
    const snapshot = { ...before };
    recordBatchReview(before, "new", verdict("pass"));
    expect(before.commitBatchCounter).toBe(snapshot.commitBatchCounter);
    expect(before.lastBatchReviewSha).toBe(snapshot.lastBatchReviewSha);
  });

  it("initializes synthesized-beads slot on blocking verdict", () => {
    const before = baseState({
      commitBatchCounter: 8,
      lastBatchReviewSha: "old",
    });
    const after = recordBatchReview(before, "new", verdict("blocking"));
    expect(after.batchReviewSynthesizedBeads?.["old..new"]).toEqual([]);
  });

  it("preserves existing synthesized-beads entries on blocking verdict", () => {
    const before = baseState({
      commitBatchCounter: 8,
      lastBatchReviewSha: "old",
      batchReviewSynthesizedBeads: {
        "older..old": ["wonderful-bhaskara-3e2f85-a1"],
      },
    });
    const after = recordBatchReview(before, "new", verdict("blocking"));
    expect(after.batchReviewSynthesizedBeads).toEqual({
      "older..old": ["wonderful-bhaskara-3e2f85-a1"],
      "old..new": [],
    });
  });

  it("does not initialize synthesized-beads slot on needs_attention verdict", () => {
    const before = baseState({ commitBatchCounter: 8 });
    const after = recordBatchReview(before, "new", verdict("needs_attention"));
    expect(after.batchReviewSynthesizedBeads).toBeUndefined();
  });
});

// ─── synthesizeBeadsFromFindings ─────────────────────────────────────────

describe("synthesizeBeadsFromFindings", () => {
  it("creates one bead per finding (all severities, no filter)", async () => {
    const ids = [
      "wonderful-bhaskara-3e2f85-aaa",
      "wonderful-bhaskara-3e2f85-bbb",
      "wonderful-bhaskara-3e2f85-ccc",
      "wonderful-bhaskara-3e2f85-ddd",
    ];
    let i = 0;
    execHandler = (cmd, args) => {
      expect(cmd).toBe("br");
      expect(args[0]).toBe("create");
      expect(args).toContain("--silent");
      return `${ids[i++]}\n`;
    };

    const findings: Finding[] = [
      finding({ severity: "low", suggested_bead_title: "Low fix" }),
      finding({ severity: "medium", suggested_bead_title: "Med fix" }),
      finding({ severity: "high", suggested_bead_title: "High fix" }),
      finding({ severity: "critical", suggested_bead_title: "Crit fix" }),
    ];
    const state = baseState();
    const created = await synthesizeBeadsFromFindings(
      "/repo",
      state,
      findings,
      "old..new",
    );

    expect(created).toEqual(ids);
    expect(state.batchReviewSynthesizedBeads).toBeDefined();
    expect(state.batchReviewSynthesizedBeads!["old..new"]).toEqual(ids);
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  it("passes auto-batch-review label and severity through to bead body", async () => {
    execHandler = (_cmd, args) => {
      expect(args).toContain("--labels");
      expect(args).toContain("auto-batch-review");
      const titleIdx = args.indexOf("--title");
      expect(args[titleIdx + 1]).toBe("Fix bug");
      const descIdx = args.indexOf("--description");
      const body = args[descIdx + 1];
      expect(body).toContain("Severity: high");
      expect(body).toContain("old..new");
      expect(body).toContain("src/x.ts");
      return "wonderful-bhaskara-3e2f85-zzz\n";
    };
    const state = baseState();
    await synthesizeBeadsFromFindings(
      "/repo",
      state,
      [
        finding({
          severity: "high",
          suggested_bead_title: "Fix bug",
          summary: "the bug",
          affected_files: ["src/x.ts"],
          evidence_excerpt: "boom",
        }),
      ],
      "old..new",
    );
  });

  it("leaves a valid partial-rollback record on mid-batch br create failure", async () => {
    const ids = [
      "wonderful-bhaskara-3e2f85-aaa",
      "wonderful-bhaskara-3e2f85-bbb",
      "wonderful-bhaskara-3e2f85-ccc",
    ];
    let i = 0;
    execHandler = () => {
      if (i < 3) {
        return `${ids[i++]}\n`;
      }
      return new Error("br create exploded");
    };

    const findings: Finding[] = [
      finding({ suggested_bead_title: "A" }),
      finding({ suggested_bead_title: "B" }),
      finding({ suggested_bead_title: "C" }),
      finding({ suggested_bead_title: "D" }),
    ];
    const state = baseState();
    await expect(
      synthesizeBeadsFromFindings("/repo", state, findings, "old..new"),
    ).rejects.toThrow(/br create failed for finding 4\/4/);

    // partial-rollback contract — caller can roll back the 3 successful IDs
    expect(state.batchReviewSynthesizedBeads!["old..new"]).toEqual(ids);
  });

  it("validates each finding via FindingSchema before shelling out", async () => {
    // Caller passes a finding missing `severity` (Zod required field).
    const state = baseState();
    const malformed = [
      finding({ severity: undefined as unknown as Finding["severity"] }),
    ];
    await expect(
      synthesizeBeadsFromFindings("/repo", state, malformed, "old..new"),
    ).rejects.toThrow();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

// ─── rollbackSynthesizedBeads ────────────────────────────────────────────

describe("rollbackSynthesizedBeads", () => {
  it("deletes every bead when br delete succeeds", async () => {
    const ids = ["w-1", "w-2", "w-3"];
    execHandler = (cmd, args) => {
      expect(cmd).toBe("br");
      expect(args[0]).toBe("delete");
      expect(args).toContain("--reason");
      return "";
    };
    const result = await rollbackSynthesizedBeads("/repo", ids);
    expect(result.deleted).toEqual(ids);
    expect(result.closed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("falls back to br update --status closed when delete fails", async () => {
    const ids = ["w-1", "w-2"];
    execHandler = (_cmd, args) => {
      if (args[0] === "delete") return new Error("dependents block delete");
      if (args[0] === "update") {
        expect(args).toContain("--status");
        expect(args).toContain("closed");
        return "";
      }
      throw new Error("unexpected br invocation");
    };
    const result = await rollbackSynthesizedBeads("/repo", ids);
    expect(result.deleted).toEqual([]);
    expect(result.closed).toEqual(ids);
    expect(result.failed).toEqual([]);
    // 2 deletes attempted + 2 fallback updates = 4 calls
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  it("records failures when both delete AND close fall through, never throws", async () => {
    const ids = ["w-1", "w-2"];
    execHandler = (_cmd, args) => {
      if (args[0] === "delete") return new Error("delete boom");
      if (args[0] === "update") return new Error("update boom");
      throw new Error("unexpected br invocation");
    };
    const result = await rollbackSynthesizedBeads("/repo", ids);
    expect(result.deleted).toEqual([]);
    expect(result.closed).toEqual([]);
    expect(result.failed).toEqual(ids);
  });

  it("continues cleanup across mixed outcomes", async () => {
    // bead 1: delete OK; bead 2: delete fails, close OK; bead 3: both fail.
    const seq: string[] = [];
    execHandler = (_cmd, args) => {
      const action = args[0];
      const id = args[1];
      seq.push(`${action}:${id}`);
      if (id === "w-1" && action === "delete") return "";
      if (id === "w-2" && action === "delete") return new Error("dep");
      if (id === "w-2" && action === "update") return "";
      if (id === "w-3" && action === "delete") return new Error("dep");
      if (id === "w-3" && action === "update") return new Error("locked");
      throw new Error("unexpected");
    };
    const result = await rollbackSynthesizedBeads("/repo", ["w-1", "w-2", "w-3"]);
    expect(result.deleted).toEqual(["w-1"]);
    expect(result.closed).toEqual(["w-2"]);
    expect(result.failed).toEqual(["w-3"]);
    expect(seq).toEqual([
      "delete:w-1",
      "delete:w-2",
      "update:w-2",
      "delete:w-3",
      "update:w-3",
    ]);
  });

  it("returns empty arrays for an empty input (no calls made)", async () => {
    const result = await rollbackSynthesizedBeads("/repo", []);
    expect(result).toEqual({ deleted: [], closed: [], failed: [] });
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
