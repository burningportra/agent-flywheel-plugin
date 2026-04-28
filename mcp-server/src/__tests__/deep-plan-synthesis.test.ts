import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  splitBySections,
  synthesizePlans,
  shouldUseSectionWise,
  buildCalibrationPromptSection,
} from "../deep-plan-synthesis.js";
import type { DeepPlanResult } from "../deep-plan.js";
import type { CalibrationReport } from "../tools/calibrate.js";

function mkPlan(name: string, plan: string, model = "sonnet"): DeepPlanResult {
  return { name, model, plan, exitCode: 0, elapsed: 1 };
}

describe("splitBySections", () => {
  it("parses multi-section markdown", () => {
    const md = [
      "# Top",
      "intro prose",
      "## Alpha",
      "alpha body",
      "more alpha",
      "## Beta",
      "beta body",
    ].join("\n");
    const out = splitBySections(md);
    expect(Array.from(out.keys())).toEqual(["", "Alpha", "Beta"]);
    expect(out.get("")).toContain("# Top");
    expect(out.get("Alpha")).toContain("alpha body");
    expect(out.get("Alpha")).toContain("more alpha");
    expect(out.get("Beta")).toContain("beta body");
  });

  it("handles input with no headings", () => {
    const md = "just some\nplain text\nwith no headings";
    const out = splitBySections(md);
    expect(Array.from(out.keys())).toEqual([""]);
    expect(out.get("")).toBe(md);
  });

  it("handles empty input", () => {
    const out = splitBySections("");
    expect(out.size).toBe(0);
  });
});

describe("synthesizePlans", () => {
  it("short-circuits identical sections verbatim", async () => {
    const section = "## Shared\nexactly the same content\nline two";
    const a = mkPlan("a", section);
    const b = mkPlan("b", section);
    const out = await synthesizePlans([a, b]);
    expect(out).toContain("## Shared");
    expect(out).toContain("exactly the same content");
    expect(out).not.toContain("Synthesis required");
    expect(out).not.toContain("Variant:");
  });

  it("emits Synthesis required block for divergent sections", async () => {
    const a = mkPlan("alpha", "## Design\nAlpha approach: use X");
    const b = mkPlan("beta", "## Design\nBeta approach: use Y");
    const out = await synthesizePlans([a, b]);
    expect(out).toContain("Synthesis required");
    expect(out).toContain("Variant: alpha");
    expect(out).toContain("Variant: beta");
    expect(out).toContain("Alpha approach: use X");
    expect(out).toContain("Beta approach: use Y");
  });

  it("falls back to whole mode when any plan lacks ## structure", async () => {
    const a = mkPlan("a", "## Has\nstructure");
    const b = mkPlan("b", "no headings here at all");
    const out = await synthesizePlans([a, b]);
    expect(out).toContain("whole-file fallback");
    expect(out).toContain("no headings here at all");
    expect(out).toContain("Planner: a");
    expect(out).toContain("Planner: b");
  });

  it("falls back to whole mode when opts.whole is true", async () => {
    const a = mkPlan("a", "## One\nfoo");
    const b = mkPlan("b", "## One\nfoo");
    const out = await synthesizePlans([a, b], { whole: true });
    expect(out).toContain("whole-file fallback");
    expect(out).toContain("whole mode requested");
  });

  it("handles empty plan list", async () => {
    const out = await synthesizePlans([]);
    expect(out).toContain("No planner outputs provided");
  });
});

describe("shouldUseSectionWise", () => {
  it("returns false below 500 files", () => {
    expect(shouldUseSectionWise(0)).toBe(false);
    expect(shouldUseSectionWise(499)).toBe(false);
  });
  it("returns true at or above 500 files", () => {
    expect(shouldUseSectionWise(500)).toBe(true);
    expect(shouldUseSectionWise(10_000)).toBe(true);
  });
});

describe("buildCalibrationPromptSection", () => {
  function makeTmpCwd(): string {
    return mkdtempSync(join(tmpdir(), "flywheel-test-"));
  }

  function writeCalibration(cwd: string, report: CalibrationReport): void {
    const dir = join(cwd, ".pi-flywheel");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "calibration.json"), JSON.stringify(report), "utf8");
  }

  function makeReport(overrides: Partial<CalibrationReport> = {}): CalibrationReport {
    return {
      cwd: "/tmp/test",
      sinceDays: 90,
      generatedAt: new Date().toISOString(),
      totalBeadsConsidered: 10,
      droppedBeads: 0,
      rows: [],
      untemplated: { count: 0 },
      ...overrides,
    };
  }

  it("splices calibration into prompt when calibration.json has rows with lowConfidence:false", async () => {
    const cwd = makeTmpCwd();
    try {
      const report = makeReport({
        rows: [
          {
            templateId: "add-tool",
            templateVersion: 1,
            estimatedEffort: "M",
            estimatedMinutes: 90,
            sampleCount: 12,
            meanMinutes: 126,
            medianMinutes: 110,
            p95Minutes: 200,
            ratio: 1.4,
            lowConfidence: false,
            proxyStartedCount: 2,
          },
          {
            templateId: "fix-bug",
            templateVersion: 1,
            estimatedEffort: "S",
            estimatedMinutes: 30,
            sampleCount: 3,
            meanMinutes: 25,
            medianMinutes: 22,
            p95Minutes: 45,
            ratio: 0.83,
            lowConfidence: true,
            proxyStartedCount: 0,
          },
        ],
      });
      writeCalibration(cwd, report);

      const section = await buildCalibrationPromptSection(cwd);
      expect(section).toContain("## Past calibration");
      expect(section).toContain("add-tool");
      expect(section).toContain("1.4×");
      expect(section).toContain("ratio > 1.3×");
      // low-confidence row excluded
      expect(section).not.toContain("fix-bug");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("skips splice when calibration file is missing", async () => {
    const cwd = makeTmpCwd();
    try {
      const section = await buildCalibrationPromptSection(cwd);
      expect(section).toBe("");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
