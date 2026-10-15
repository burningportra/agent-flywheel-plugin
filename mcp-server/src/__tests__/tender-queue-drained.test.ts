import { describe, expect, it } from "vitest";
import {
  runTenderDaemonOnce,
  type TenderDaemonState,
  type TenderDaemonPollSnapshot,
} from "../tender.js";

/**
 * E6: the tender daemon now owns the empty-wave counter that _inflight_prompt.md
 * used to describe in ~3.2K chars of prose. When a snapshot's `beadCounts`
 * are all zero, `runTenderDaemonOnce` emits a `queue_drained` event carrying
 * a 1-indexed empty-tick count; any non-zero bead count resets the counter.
 * Snapshots without `beadCounts` leave the counter untouched (older callers
 * stay backward-compatible).
 */

const SESSION = "fw-queue-drained-test";

function makeState(overrides: Partial<TenderDaemonState> = {}): TenderDaemonState {
  return {
    session: SESSION,
    lastPollTs: 1_700_000_000_000,
    knownMessageIds: [],
    paneStates: {},
    robotState: null,
    ...overrides,
  };
}

function makeSnapshot(
  overrides: Partial<TenderDaemonPollSnapshot> = {},
): TenderDaemonPollSnapshot {
  return {
    session: SESSION,
    pollTs: 1_700_000_030_000,
    messages: [],
    paneStates: {},
    robotState: null,
    ...overrides,
  };
}

describe("tender daemon queue_drained event", () => {
  it("emits queue_drained with emptyTickCount=1 on first all-zero bead counts", () => {
    const { events, nextState } = runTenderDaemonOnce(
      makeState(),
      makeSnapshot({ beadCounts: { open: 0, ready: 0, inProgress: 0 } }),
    );

    const drained = events.find((e) => e.kind === "queue_drained");
    expect(drained).toBeDefined();
    if (drained?.kind !== "queue_drained") throw new Error("unreachable");
    expect(drained.emptyTickCount).toBe(1);
    expect(drained.beadCounts).toEqual({ open: 0, ready: 0, inProgress: 0 });
    expect(nextState.emptyTickCount).toBe(1);
  });

  it("increments the tick count on each consecutive empty tick", () => {
    let state = makeState({ emptyTickCount: 0 });
    for (const expected of [1, 2, 3, 4, 5]) {
      const result = runTenderDaemonOnce(
        state,
        makeSnapshot({ beadCounts: { open: 0, ready: 0, inProgress: 0 } }),
      );
      const drained = result.events.find((e) => e.kind === "queue_drained");
      expect(drained?.kind).toBe("queue_drained");
      if (drained?.kind !== "queue_drained") throw new Error("unreachable");
      expect(drained.emptyTickCount).toBe(expected);
      expect(result.nextState.emptyTickCount).toBe(expected);
      state = result.nextState;
    }
  });

  it("resets the counter the moment any bead reappears (open > 0)", () => {
    const stateAfterDrain = makeState({ emptyTickCount: 3 });
    const { events, nextState } = runTenderDaemonOnce(
      stateAfterDrain,
      makeSnapshot({ beadCounts: { open: 2, ready: 0, inProgress: 0 } }),
    );
    expect(events.find((e) => e.kind === "queue_drained")).toBeUndefined();
    expect(nextState.emptyTickCount).toBe(0);
  });

  it("resets on ready > 0 and on inProgress > 0 (every field is a reset gate)", () => {
    for (const beadCounts of [
      { open: 0, ready: 1, inProgress: 0 },
      { open: 0, ready: 0, inProgress: 1 },
    ]) {
      const { events, nextState } = runTenderDaemonOnce(
        makeState({ emptyTickCount: 4 }),
        makeSnapshot({ beadCounts }),
      );
      expect(events.find((e) => e.kind === "queue_drained")).toBeUndefined();
      expect(nextState.emptyTickCount).toBe(0);
    }
  });

  it("does not touch the counter when snapshot omits beadCounts (backward-compat)", () => {
    const { events, nextState } = runTenderDaemonOnce(
      makeState({ emptyTickCount: 2 }),
      makeSnapshot(),
    );
    expect(events.find((e) => e.kind === "queue_drained")).toBeUndefined();
    expect(nextState.emptyTickCount).toBe(2);
  });
});
