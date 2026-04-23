/**
 * Wave collision detection (agent-flywheel-plugin-iy4).
 *
 * Covers:
 * - captureWaveStartSha: happy path + git-rev-parse failure surfaces FlywheelError
 * - diffWorkerAgainstWaveStart: parses `git diff --name-only` output
 * - matchesGlob / isIgnoredCollisionPath: minimal glob dialect
 * - aggregateCollisions: pure-function detection with mocked git outputs
 * - detectWaveCollisions: end-to-end orchestration with mocked exec
 * - forceSerialRerun: runs colliding units sequentially, in stable order
 * - collision-ignore seeding + load: idempotent file write, custom patterns honored
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  captureWaveStartSha,
  diffWorkerAgainstWaveStart,
  matchesGlob,
  isIgnoredCollisionPath,
  aggregateCollisions,
  detectWaveCollisions,
  forceSerialRerun,
  collidingUnitIds,
  loadCollisionIgnore,
  seedCollisionIgnore,
  DEFAULT_COLLISION_IGNORE,
  COLLISION_IGNORE_PATH,
  WAVE_COLLISION_HINT,
} from "../coordination.js";

import { createMockExec, type ExecCall } from "./helpers/mocks.js";
import { FlywheelError } from "../errors.js";

// ─── captureWaveStartSha ────────────────────────────────────────

describe("captureWaveStartSha", () => {
  it("returns the trimmed SHA from `git rev-parse HEAD`", async () => {
    const calls: ExecCall[] = [
      { cmd: "git", args: ["rev-parse", "HEAD"], result: { code: 0, stdout: "abc1234deadbeef\n", stderr: "" } },
    ];
    const exec = createMockExec(calls);
    const sha = await captureWaveStartSha(exec, "/repo");
    expect(sha).toBe("abc1234deadbeef");
  });

  it("throws FlywheelError(cli_failure) when git rev-parse exits non-zero", async () => {
    const calls: ExecCall[] = [
      { cmd: "git", args: ["rev-parse", "HEAD"], result: { code: 128, stdout: "", stderr: "fatal: not a git repository" } },
    ];
    const exec = createMockExec(calls);
    await expect(captureWaveStartSha(exec, "/repo")).rejects.toBeInstanceOf(FlywheelError);
  });

  it("throws FlywheelError(parse_failure) when output is not a SHA", async () => {
    const calls: ExecCall[] = [
      { cmd: "git", args: ["rev-parse", "HEAD"], result: { code: 0, stdout: "not-a-sha\n", stderr: "" } },
    ];
    const exec = createMockExec(calls);
    await expect(captureWaveStartSha(exec, "/repo")).rejects.toMatchObject({ code: "parse_failure" });
  });
});

// ─── diffWorkerAgainstWaveStart ─────────────────────────────────

describe("diffWorkerAgainstWaveStart", () => {
  it("parses one-path-per-line stdout into a string array", async () => {
    const calls: ExecCall[] = [
      {
        cmd: "git",
        args: ["diff", "--name-only", "abc123..HEAD"],
        result: { code: 0, stdout: "src/a.ts\nsrc/b.ts\n\n", stderr: "" },
      },
    ];
    const exec = createMockExec(calls);
    const out = await diffWorkerAgainstWaveStart(exec, "/wt", "abc123");
    expect(out).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns [] when the worker made no changes", async () => {
    const calls: ExecCall[] = [
      { cmd: "git", args: ["diff", "--name-only", "abc123..HEAD"], result: { code: 0, stdout: "", stderr: "" } },
    ];
    const exec = createMockExec(calls);
    expect(await diffWorkerAgainstWaveStart(exec, "/wt", "abc123")).toEqual([]);
  });

  it("throws FlywheelError(cli_failure) on git diff non-zero", async () => {
    const calls: ExecCall[] = [
      { cmd: "git", args: ["diff", "--name-only", "abc123..HEAD"], result: { code: 1, stdout: "", stderr: "boom" } },
    ];
    const exec = createMockExec(calls);
    await expect(diffWorkerAgainstWaveStart(exec, "/wt", "abc123")).rejects.toMatchObject({ code: "cli_failure" });
  });
});

// ─── matchesGlob / isIgnoredCollisionPath ───────────────────────

describe("matchesGlob", () => {
  it("matches literal paths", () => {
    expect(matchesGlob("package-lock.json", "package-lock.json")).toBe(true);
    expect(matchesGlob("package-lock.json", "src/package-lock.json")).toBe(true); // basename fallback
    expect(matchesGlob("package-lock.json", "package.json")).toBe(false);
  });

  it("supports * (one segment) and ** (many segments)", () => {
    expect(matchesGlob("__snapshots__/**", "__snapshots__/foo.snap")).toBe(true);
    expect(matchesGlob("__snapshots__/**", "__snapshots__/nested/foo.snap")).toBe(true);
    expect(matchesGlob("src/*.ts", "src/foo.ts")).toBe(true);
    expect(matchesGlob("src/*.ts", "src/sub/foo.ts")).toBe(false);
  });

  it("supports basename matching for patterns without slashes", () => {
    expect(matchesGlob("*.generated.*", "src/feature.generated.ts")).toBe(true);
    expect(matchesGlob("*.generated.*", "feature.generated.ts")).toBe(true);
    expect(matchesGlob("*.generated.*", "src/feature.ts")).toBe(false);
  });

  it("supports ? for a single non-slash char", () => {
    expect(matchesGlob("a?.ts", "ab.ts")).toBe(true);
    expect(matchesGlob("a?.ts", "abc.ts")).toBe(false);
  });
});

describe("isIgnoredCollisionPath", () => {
  it("returns true when any pattern matches", () => {
    const patterns = ["package-lock.json", "__snapshots__/**", "*.generated.*"];
    expect(isIgnoredCollisionPath("package-lock.json", patterns)).toBe(true);
    expect(isIgnoredCollisionPath("src/__snapshots__/x.snap", patterns)).toBe(false); // ** is not basename
    expect(isIgnoredCollisionPath("__snapshots__/x.snap", patterns)).toBe(true);
    expect(isIgnoredCollisionPath("src/foo.generated.ts", patterns)).toBe(true);
  });

  it("returns false when no patterns match", () => {
    expect(isIgnoredCollisionPath("src/foo.ts", DEFAULT_COLLISION_IGNORE)).toBe(false);
  });
});

// ─── aggregateCollisions (pure) ─────────────────────────────────

describe("aggregateCollisions", () => {
  it("flags a path touched by 2+ units", () => {
    const report = aggregateCollisions("sha", [
      { unitId: "bead-A", touched: ["src/shared.ts", "src/a.ts"] },
      { unitId: "bead-B", touched: ["src/shared.ts", "src/b.ts"] },
    ], []);
    expect(report.hasCollision).toBe(true);
    expect(report.collisions).toEqual([
      { path: "src/shared.ts", unitIds: ["bead-A", "bead-B"] },
    ]);
  });

  it("returns no collisions when all touched sets are disjoint", () => {
    const report = aggregateCollisions("sha", [
      { unitId: "bead-A", touched: ["src/a.ts"] },
      { unitId: "bead-B", touched: ["src/b.ts"] },
    ], []);
    expect(report.hasCollision).toBe(false);
    expect(report.collisions).toEqual([]);
  });

  it("strips ignored paths from both per-unit sets and the collision scan", () => {
    const report = aggregateCollisions("sha", [
      { unitId: "bead-A", touched: ["package-lock.json", "src/a.ts"] },
      { unitId: "bead-B", touched: ["package-lock.json", "src/b.ts"] },
    ], DEFAULT_COLLISION_IGNORE);
    expect(report.hasCollision).toBe(false);
    expect(report.touchedByUnit["bead-A"]).toEqual(["src/a.ts"]);
    expect(report.touchedByUnit["bead-B"]).toEqual(["src/b.ts"]);
  });

  it("aggregates 3+ units into one collision entry", () => {
    const report = aggregateCollisions("sha", [
      { unitId: "C", touched: ["src/x.ts"] },
      { unitId: "A", touched: ["src/x.ts"] },
      { unitId: "B", touched: ["src/x.ts"] },
    ], []);
    expect(report.collisions).toHaveLength(1);
    expect(report.collisions[0].unitIds).toEqual(["A", "B", "C"]);
  });

  it("preserves the wave-start SHA on the report", () => {
    const report = aggregateCollisions("deadbeef", [], []);
    expect(report.waveStartSha).toBe("deadbeef");
  });
});

// ─── detectWaveCollisions (end-to-end with mocked exec) ─────────

describe("detectWaveCollisions", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "iy4-collisions-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("aggregates per-worker diffs into a collision report", async () => {
    const calls: ExecCall[] = [
      {
        cmd: "git",
        args: ["diff", "--name-only", "shaWAVE..HEAD"],
        result: { code: 0, stdout: "src/shared.ts\nsrc/a.ts\n", stderr: "" },
      },
    ];
    // The mock matches by cmd+args, ignoring cwd, so both workers hit the
    // same canned response. We override per-worker by chaining mocks instead.
    let callIdx = 0;
    const responses = [
      { code: 0, stdout: "src/shared.ts\nsrc/a.ts\n", stderr: "" },
      { code: 0, stdout: "src/shared.ts\nsrc/b.ts\n", stderr: "" },
    ];
    const exec = async () => responses[callIdx++] ?? { code: 1, stdout: "", stderr: "exhausted" };

    const report = await detectWaveCollisions(
      exec as never,
      tmpRoot,
      "shaWAVE",
      [
        { unitId: "bead-A", worktreeCwd: join(tmpRoot, "wt-a") },
        { unitId: "bead-B", worktreeCwd: join(tmpRoot, "wt-b") },
      ],
    );
    expect(report.hasCollision).toBe(true);
    expect(report.collisions).toEqual([
      { path: "src/shared.ts", unitIds: ["bead-A", "bead-B"] },
    ]);
    // Sanity: the static `calls` array is unused here; we keep it documented above.
    expect(calls.length).toBe(1);
  });

  it("falls back to DEFAULT_COLLISION_IGNORE when no ignore file exists", async () => {
    let i = 0;
    const responses = [
      { code: 0, stdout: "package-lock.json\nsrc/a.ts\n", stderr: "" },
      { code: 0, stdout: "package-lock.json\nsrc/b.ts\n", stderr: "" },
    ];
    const exec = async () => responses[i++] ?? { code: 1, stdout: "", stderr: "" };
    const report = await detectWaveCollisions(
      exec as never,
      tmpRoot,
      "wave1",
      [
        { unitId: "A", worktreeCwd: "/wt-a" },
        { unitId: "B", worktreeCwd: "/wt-b" },
      ],
    );
    expect(report.hasCollision).toBe(false);
  });

  it("honors a custom .pi-flywheel/collision-ignore file", async () => {
    mkdirSync(join(tmpRoot, ".pi-flywheel"), { recursive: true });
    writeFileSync(
      join(tmpRoot, COLLISION_IGNORE_PATH),
      "# custom\nsrc/shared.ts\n",
      "utf-8",
    );
    let i = 0;
    const responses = [
      { code: 0, stdout: "src/shared.ts\nsrc/a.ts\n", stderr: "" },
      { code: 0, stdout: "src/shared.ts\nsrc/b.ts\n", stderr: "" },
    ];
    const exec = async () => responses[i++] ?? { code: 1, stdout: "", stderr: "" };
    const report = await detectWaveCollisions(
      exec as never,
      tmpRoot,
      "wave1",
      [
        { unitId: "A", worktreeCwd: "/wt-a" },
        { unitId: "B", worktreeCwd: "/wt-b" },
      ],
    );
    expect(report.hasCollision).toBe(false);
    expect(report.touchedByUnit["A"]).toEqual(["src/a.ts"]);
  });
});

// ─── seedCollisionIgnore + loadCollisionIgnore ──────────────────

describe("seedCollisionIgnore / loadCollisionIgnore", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "iy4-seed-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("seeds the file with the default patterns when missing", () => {
    const out = seedCollisionIgnore(tmpRoot);
    expect(out.created).toBe(true);
    expect(existsSync(out.path)).toBe(true);
    const body = readFileSync(out.path, "utf-8");
    for (const pat of DEFAULT_COLLISION_IGNORE) {
      expect(body).toContain(pat);
    }
  });

  it("is idempotent — never overwrites an existing file", () => {
    mkdirSync(join(tmpRoot, ".pi-flywheel"), { recursive: true });
    const path = join(tmpRoot, COLLISION_IGNORE_PATH);
    writeFileSync(path, "user-edited\n", "utf-8");
    const out = seedCollisionIgnore(tmpRoot);
    expect(out.created).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe("user-edited\n");
  });

  it("loadCollisionIgnore strips comments and blank lines", () => {
    mkdirSync(join(tmpRoot, ".pi-flywheel"), { recursive: true });
    writeFileSync(
      join(tmpRoot, COLLISION_IGNORE_PATH),
      "# comment\n\nfoo.ts\n  bar.ts  \n# trailing comment\n",
      "utf-8",
    );
    expect(loadCollisionIgnore(tmpRoot)).toEqual(["foo.ts", "bar.ts"]);
  });

  it("loadCollisionIgnore returns DEFAULT when file is absent", () => {
    expect(loadCollisionIgnore(tmpRoot)).toEqual([...DEFAULT_COLLISION_IGNORE]);
  });
});

// ─── forceSerialRerun ───────────────────────────────────────────

describe("forceSerialRerun", () => {
  it("calls runOne for each colliding unit in stable sorted order", async () => {
    const report = aggregateCollisions("sha", [
      { unitId: "bead-Z", touched: ["src/x.ts"] },
      { unitId: "bead-A", touched: ["src/x.ts"] },
      { unitId: "bead-M", touched: ["src/x.ts"] },
    ], []);
    const order: string[] = [];
    const out = await forceSerialRerun(report, async (id) => {
      order.push(id);
      return `ran:${id}`;
    });
    expect(order).toEqual(["bead-A", "bead-M", "bead-Z"]);
    expect(out).toEqual({ "bead-A": "ran:bead-A", "bead-M": "ran:bead-M", "bead-Z": "ran:bead-Z" });
  });

  it("runs sequentially — never overlaps", async () => {
    const report = aggregateCollisions("sha", [
      { unitId: "A", touched: ["x"] },
      { unitId: "B", touched: ["x"] },
    ], []);
    let active = 0;
    let maxActive = 0;
    await forceSerialRerun(report, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(maxActive).toBe(1);
  });

  it("returns an empty record when there are no collisions", async () => {
    const report = aggregateCollisions("sha", [
      { unitId: "A", touched: ["a"] },
      { unitId: "B", touched: ["b"] },
    ], []);
    let runs = 0;
    const out = await forceSerialRerun(report, async () => { runs++; return null; });
    expect(runs).toBe(0);
    expect(out).toEqual({});
  });
});

// ─── collidingUnitIds + hint constant ───────────────────────────

describe("collidingUnitIds", () => {
  it("returns the union of unitIds across all collision entries, sorted", () => {
    const report = aggregateCollisions("sha", [
      { unitId: "A", touched: ["x", "y"] },
      { unitId: "B", touched: ["x"] },
      { unitId: "C", touched: ["y"] },
    ], []);
    expect(collidingUnitIds(report)).toEqual(["A", "B", "C"]);
  });
});

describe("WAVE_COLLISION_HINT", () => {
  it("mentions colliding beads and serial re-run for hint-field operators", () => {
    expect(WAVE_COLLISION_HINT).toMatch(/collid/i);
    expect(WAVE_COLLISION_HINT).toMatch(/serial/i);
  });
});
