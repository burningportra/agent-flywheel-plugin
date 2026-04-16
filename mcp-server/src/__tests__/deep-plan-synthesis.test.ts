import { describe, it, expect } from "vitest";
import {
  splitBySections,
  synthesizePlans,
  shouldUseSectionWise,
} from "../deep-plan-synthesis.js";
import type { DeepPlanResult } from "../deep-plan.js";

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
