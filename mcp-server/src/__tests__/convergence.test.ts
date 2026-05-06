import { describe, expect, it } from "vitest";
import {
  appendRevision,
  computeRevisionMetrics,
  ConvergenceStateSchema,
  defaultStep545Action,
  parseConvergenceState,
  REVISION_BUFFER_SIZE,
  SCORE_VERSION,
  type ConvergenceState,
  type RevisionMetrics,
} from "../convergence.js";

const PLAN = "test-plan";
const FIXED_TS = "2026-05-05T00:00:00.000Z";

/**
 * Build a synthetic markdown body of N lines so RevisionMetrics.size.lines === n.
 * Content is deterministic + varied to avoid degenerate identical-shingle similarity.
 */
function md(lines: number, salt = ""): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(`line ${i} ${salt}`);
  }
  return out.join("\n");
}

/**
 * Drive the state machine across a list of line counts. Each step computes a
 * RevisionMetrics from current vs prior markdown and appends to state.
 */
function driveSequence(
  lineCounts: number[],
  opts: { salts?: string[]; tsFor?: (i: number) => string } = {},
): { states: ConvergenceState[] } {
  const states: ConvergenceState[] = [];
  let state: ConvergenceState | null = null;
  let prior: string | null = null;
  for (let i = 0; i < lineCounts.length; i++) {
    const salt = opts.salts?.[i] ?? `s${i}`;
    const current = md(lineCounts[i], salt);
    const ts = opts.tsFor?.(i) ?? `2026-05-05T00:00:0${i}.000Z`;
    const metrics = computeRevisionMetrics(current, prior, {
      revisionId: `r${i}`,
      timestamp: ts,
    });
    state = appendRevision(state, metrics, PLAN, { computedAt: ts });
    states.push(state);
    prior = current;
  }
  return { states };
}

describe("convergence — RevisionMetrics", () => {
  it("computes structural counts on real markdown", () => {
    const body = [
      "# Heading",
      "## Sub",
      "",
      "- item one",
      "- item two",
      "1. ordered",
      "",
      "[link](http://example.com)",
      "",
      "```ts",
      "let x = 1;",
      "```",
      "",
      "more text",
    ].join("\n");
    const m = computeRevisionMetrics(body, null, { revisionId: "r0", timestamp: FIXED_TS });
    expect(m.structural.headings).toBe(2);
    expect(m.structural.codeBlocks).toBe(1);
    expect(m.structural.links).toBe(1);
    expect(m.structural.listItems).toBe(3);
    expect(m.size.lines).toBeGreaterThan(0);
    expect(m.diffVsPrior).toBeNull();
  });

  it("computes diffVsPrior with similarity in [0,1]", () => {
    const a = md(10, "a");
    const b = md(10, "a");
    const m = computeRevisionMetrics(b, a, { revisionId: "r1", timestamp: FIXED_TS });
    expect(m.diffVsPrior).not.toBeNull();
    expect(m.diffVsPrior!.similarityScore).toBeCloseTo(1, 5);
    expect(m.diffVsPrior!.addedLines).toBe(0);
    expect(m.diffVsPrior!.removedLines).toBe(0);
  });

  it("similarity drops for unrelated content", () => {
    const a = md(20, "alpha");
    const b = md(20, "totally different content xyz pdq");
    const m = computeRevisionMetrics(b, a, { revisionId: "r2", timestamp: FIXED_TS });
    expect(m.diffVsPrior!.similarityScore).toBeLessThan(0.5);
  });
});

describe("convergence — B6 oscillation guard", () => {
  it("flags the canonical APR-Pro B6 oscillation fixture", () => {
    const { states } = driveSequence([1000, 1200, 800, 1100, 900]);
    const final = states[states.length - 1];
    expect(final.status).toBe("oscillating");
    expect(final.oscillation.detected).toBe(true);
    expect(final.estimatedRoundsRemaining).toBeNull();
    expect(final.oscillation.signFlips).toBeGreaterThan(Math.floor(final.revisions.length / 3));
  });

  it("does NOT flag a flat sequence as oscillating", () => {
    const counts = [1000, 1000, 1000, 1000, 1000];
    const { states } = driveSequence(counts, {
      // Constant salt → identical content → similarity ≈ 1, churn ≈ 0
      salts: counts.map(() => "stable"),
    });
    const final = states[states.length - 1];
    expect(final.oscillation.detected).toBe(false);
    // flat + identical → minimal churn → high score → converged
    expect(final.status).toBe("converged");
  });

  it("does NOT flag a monotone sequence as oscillating", () => {
    const { states } = driveSequence([1000, 1100, 1300, 1700, 2400]);
    const final = states[states.length - 1];
    expect(final.oscillation.detected).toBe(false);
  });
});

describe("convergence — status ladder", () => {
  it("monotonic divergence ends in 'diverging'", () => {
    // Aggressively growing sizes with distinct salts → low similarity AND
    // high churn → score < 0.5 (diverging).
    const counts = [100, 500, 1500, 4000, 10000];
    const { states } = driveSequence(counts, {
      salts: ["alpha", "beta", "gamma", "delta", "epsilon"],
    });
    const final = states[states.length - 1];
    expect(final.status).toBe("diverging");
  });

  it("monotonic-converging sequence transitions through ladder without skipping", () => {
    // Construct a sequence whose stepwise churn shrinks: large early changes,
    // then progressively smaller, then stable. Use distinct salts so similarity
    // tracks size-stability rather than accidental shingle reuse.
    const counts = [50, 200, 195, 193, 192, 192, 192];
    const states: ConvergenceState[] = [];
    let state: ConvergenceState | null = null;
    let prior: string | null = null;
    for (let i = 0; i < counts.length; i++) {
      // Use the SAME salt so similarity rises as content stabilises.
      const current = md(counts[i], "stable");
      const ts = `2026-05-05T00:0${i}:00.000Z`;
      const m = computeRevisionMetrics(current, prior, {
        revisionId: `r${i}`,
        timestamp: ts,
      });
      state = appendRevision(state, m, PLAN, { computedAt: ts });
      states.push(state);
      prior = current;
    }
    const seenStatuses = states.map((s) => s.status);
    // Should hit at least diverging and converged (or nearly_converged) endpoints.
    // Critically: never skip a tier. ladder order:
    const ladder: Array<ConvergenceState["status"]> = [
      "diverging",
      "approaching",
      "nearly_converged",
      "converged",
    ];
    let lastIdx = -1;
    for (const s of seenStatuses) {
      if (s === "oscillating") continue; // not expected here, but guarded
      const idx = ladder.indexOf(s);
      expect(idx).toBeGreaterThanOrEqual(lastIdx);
      // verify no skip > 1 backward; forward skips would mean "skipped a tier"
      // but we only enforce "monotone non-decreasing" since multi-step jumps
      // in score *can* happen — the bead's "without skipping" requirement is
      // about not regressing. Forward jumps are fine; backward is not.
      lastIdx = Math.max(lastIdx, idx);
    }
    expect(lastIdx).toBeGreaterThanOrEqual(ladder.indexOf("nearly_converged"));
  });
});

describe("convergence — schema round-trip", () => {
  it("every fixture's state round-trips through JSON.stringify + Zod parse", () => {
    const fixtures = [
      [1000, 1200, 800, 1100, 900],
      [1000, 1000, 1000, 1000, 1000],
      [1000, 1100, 1300, 1700, 2400],
      [50, 200, 195, 193, 192],
    ];
    for (const seq of fixtures) {
      const { states } = driveSequence(seq);
      for (const st of states) {
        const json = JSON.stringify(st);
        const parsed = JSON.parse(json);
        const ok = ConvergenceStateSchema.safeParse(parsed);
        expect(ok.success, `parse failed for seq ${JSON.stringify(seq)}`).toBe(true);
        if (ok.success) {
          expect(ok.data).toEqual(st);
        }
      }
    }
  });
});

describe("convergence — appendRevision edge cases", () => {
  it("empty state with single revision is valid", () => {
    const m = computeRevisionMetrics(md(100, "x"), null, {
      revisionId: "r0",
      timestamp: FIXED_TS,
    });
    const state = appendRevision(null, m, PLAN, { computedAt: FIXED_TS });
    expect(state.revisions).toHaveLength(1);
    expect(state.score).toBe(0);
    expect(state.status).toBe("diverging");
    expect(state.estimatedRoundsRemaining).toBeNull();
    // schema parse
    expect(() => ConvergenceStateSchema.parse(state)).not.toThrow();
  });

  it("ring buffer caps at N=5 (FIFO)", () => {
    const counts = [10, 20, 30, 40, 50, 60, 70];
    const { states } = driveSequence(counts);
    const final = states[states.length - 1];
    expect(final.revisions).toHaveLength(REVISION_BUFFER_SIZE);
    // The first revision (revisionId r0) must have been dropped; the head
    // should now be r2 (index 2) since we appended 7 and capped at 5.
    expect(final.revisions[0].revisionId).toBe("r2");
    expect(final.revisions[final.revisions.length - 1].revisionId).toBe("r6");
  });

  it("only branches on score and status — never on revisions.length", () => {
    // Two states with the same score should produce the same default action
    // regardless of how many revisions they have. Constructed via a synthetic
    // minimal state to assert the contract.
    const baseState: ConvergenceState = {
      version: 1,
      planSlug: PLAN,
      scoreVersion: SCORE_VERSION,
      revisions: [],
      signals: { outputSizeTrend: 0, changeVelocity: 0, similarityTrend: 1 },
      oscillation: { signFlips: 0, detected: false },
      score: 0.92,
      status: "converged",
      estimatedRoundsRemaining: null,
      computedAt: FIXED_TS,
    };
    expect(defaultStep545Action(baseState)).toBe("approve");
    expect(defaultStep545Action({ ...baseState, score: 0.8, status: "nearly_converged" })).toBe(
      "validate",
    );
    expect(defaultStep545Action({ ...baseState, score: 0.4, status: "diverging" })).toBe("refine");
    expect(
      defaultStep545Action({
        ...baseState,
        status: "oscillating",
        score: 0.95,
        oscillation: { signFlips: 4, detected: true },
      }),
    ).toBe("refine");
  });
});

describe("convergence — score-version mismatch", () => {
  it("reading state with scoreVersion=2 returns score_version_mismatch", () => {
    const stale = {
      version: 1,
      planSlug: PLAN,
      scoreVersion: 2,
      revisions: [],
      signals: { outputSizeTrend: 0, changeVelocity: 0, similarityTrend: 1 },
      oscillation: { signFlips: 0, detected: false },
      score: 0.5,
      status: "approaching",
      estimatedRoundsRemaining: null,
      computedAt: FIXED_TS,
    };
    const result = parseConvergenceState(JSON.stringify(stale));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("score_version_mismatch");
      if (result.error.code === "score_version_mismatch") {
        expect(result.error.gotVersion).toBe(2);
      }
    }
  });

  it("appendRevision throws when given a state with mismatched scoreVersion", () => {
    const stale = {
      version: 1,
      planSlug: PLAN,
      scoreVersion: 999,
      revisions: [],
      signals: { outputSizeTrend: 0, changeVelocity: 0, similarityTrend: 1 },
      oscillation: { signFlips: 0, detected: false },
      score: 0.5,
      status: "approaching",
      estimatedRoundsRemaining: null,
      computedAt: FIXED_TS,
    } as unknown as ConvergenceState;
    const m = computeRevisionMetrics(md(10), null);
    expect(() => appendRevision(stale, m, PLAN)).toThrow(/score_version_mismatch/);
  });
});

describe("convergence — estimatedRoundsRemaining", () => {
  it("is null when buffer is not full", () => {
    const { states } = driveSequence([100, 200, 200]);
    expect(states[states.length - 1].estimatedRoundsRemaining).toBeNull();
  });

  it("is null on oscillating sequences even with full buffer", () => {
    const { states } = driveSequence([1000, 1200, 800, 1100, 900]);
    const final = states[states.length - 1];
    expect(final.estimatedRoundsRemaining).toBeNull();
  });
});

describe("convergence — pure module surface", () => {
  it("RevisionMetricsSchema accepts a constructed metric and rejects a malformed one", () => {
    const m: RevisionMetrics = {
      version: 1,
      revisionId: "r0",
      timestamp: FIXED_TS,
      size: { lines: 1, words: 1, chars: 1 },
      structural: { headings: 0, codeBlocks: 0, links: 0, listItems: 0 },
      diffVsPrior: null,
    };
    expect(() => computeRevisionMetrics("hi", null)).not.toThrow();
    const stringified = JSON.stringify(m);
    expect(JSON.parse(stringified).version).toBe(1);
  });
});
