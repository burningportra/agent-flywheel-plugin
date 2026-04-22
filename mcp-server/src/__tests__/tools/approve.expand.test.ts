/**
 * I9 — Approve-time bead template expansion.
 *
 * Coverage:
 *   - Plan with a well-formed `template: "foundation-with-fresh-eyes-gate@1"`
 *     hint → bead created with expanded body (snapshot).
 *   - Plan with `add-feature@99` (version mismatch) → `template_not_found`
 *     envelope emitted through `makeFlywheelErrorResult`.
 *   - Plan missing a required placeholder → `template_placeholder_missing`
 *     envelope with hint remediation.
 *   - Legacy plan without any template hints → passthrough unchanged.
 *
 * This file exercises the pure helpers `expandBeadPlanSpec` and
 * `expandBeadPlanSpecs` — the bead-creation path is tested without touching
 * the br CLI or hotspot-matrix code (disjoint from I5 wiring per I9 spec).
 */

import { describe, it, expect } from "vitest";
import {
  expandBeadPlanSpec,
  expandBeadPlanSpecs,
  type BeadPlanSpec,
  type BeadExpansionOutcome,
} from "../../tools/approve.js";
import type { FlywheelPhase } from "../../types.js";

const PHASE: FlywheelPhase = "creating_beads";

// Minimal input that satisfies every I8 template used in the happy-path tests.
const FOUNDATION_SPEC: BeadPlanSpec = {
  title: "Introduce BeadTemplateContract at the MCP boundary.",
  template: "foundation-with-fresh-eyes-gate@1",
  scope: "Add BeadTemplateContract to types.ts.",
  acceptance: "Contract is exported and consumed by two downstream beads.",
  test_plan: "Vitest covers contract round-trip.",
  extraPlaceholders: {
    PARENT_WAVE_BEADS: "I8, I9",
    TARGET_FILE: "mcp-server/src/types.ts",
  },
};

describe("expandBeadPlanSpec — happy path", () => {
  it("expands a well-formed foundation hint into a rendered body", () => {
    const outcome = expandBeadPlanSpec(FOUNDATION_SPEC, PHASE);
    expect(outcome.status).toBe("expanded");
    if (outcome.status !== "expanded") return;
    expect(outcome.usedTemplate).toEqual({
      id: "foundation-with-fresh-eyes-gate",
      version: 1,
    });
    expect(outcome.description).toContain("I8, I9");
    expect(outcome.description).toContain("mcp-server/src/types.ts");
    expect(outcome.title).toBe(FOUNDATION_SPEC.title);
    expect(outcome.description).toMatchSnapshot();
  });

  it("expands add-feature with minimal inputs", () => {
    const outcome = expandBeadPlanSpec(
      {
        title: "Add verbose flag.",
        template: "add-feature@1",
        scope: "Opt-in JSON field.",
        acceptance: "--verbose adds five fields.",
        test_plan: "One happy-path test.",
        extraPlaceholders: { TARGET_FILE: "src/tools/status.ts" },
      },
      PHASE,
    );
    expect(outcome.status).toBe("expanded");
    if (outcome.status !== "expanded") return;
    expect(outcome.description).toContain("Add verbose flag.");
    expect(outcome.description).toContain("src/tools/status.ts");
  });
});

describe("expandBeadPlanSpec — error branches", () => {
  it("emits template_not_found envelope on version mismatch", () => {
    const outcome = expandBeadPlanSpec(
      { ...FOUNDATION_SPEC, template: "foundation-with-fresh-eyes-gate@99" },
      PHASE,
    );
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.code).toBe("template_not_found");

    const envelope = outcome.errorResult.structuredContent;
    expect(envelope).toBeDefined();
    if (!envelope) return;
    const typed = envelope as {
      tool: string;
      status: string;
      phase: string;
      data: { kind: string; error: { code: string; hint?: string; details?: Record<string, unknown> } };
    };
    expect(typed.tool).toBe("flywheel_approve_beads");
    expect(typed.status).toBe("error");
    expect(typed.phase).toBe(PHASE);
    expect(typed.data.kind).toBe("error");
    expect(typed.data.error.code).toBe("template_not_found");
    expect(typed.data.error.hint).toBeDefined();
    expect(typed.data.error.details?.templateId).toBe("foundation-with-fresh-eyes-gate");
    expect(typed.data.error.details?.templateVersion).toBe(99);
  });

  it("emits template_not_found for unknown id", () => {
    const outcome = expandBeadPlanSpec(
      { ...FOUNDATION_SPEC, template: "does-not-exist@1" },
      PHASE,
    );
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.code).toBe("template_not_found");
  });

  it("emits template_placeholder_missing when required fields are absent", () => {
    const outcome = expandBeadPlanSpec(
      {
        title: "Incomplete foundation",
        template: "foundation-with-fresh-eyes-gate@1",
        // no scope, acceptance, test_plan, PARENT_WAVE_BEADS, TARGET_FILE
      },
      PHASE,
    );
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.code).toBe("template_placeholder_missing");
    const envelope = outcome.errorResult.structuredContent as {
      data: { error: { code: string; hint?: string; message: string } };
    };
    expect(envelope.data.error.code).toBe("template_placeholder_missing");
    expect(envelope.data.error.hint).toContain("placeholder");
    // At least one of the missing placeholder names should surface in message.
    expect(envelope.data.error.message).toMatch(/SCOPE|ACCEPTANCE|TEST_PLAN|PARENT_WAVE_BEADS|TARGET_FILE/);
  });

  it("emits template_expansion_failed for invalid placeholder values", () => {
    const outcome = expandBeadPlanSpec(
      {
        ...FOUNDATION_SPEC,
        // carriage return in title triggers the invalid-value path
        title: "Broken\rtitle",
      },
      PHASE,
    );
    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") return;
    expect(outcome.code).toBe("template_expansion_failed");
  });
});

describe("expandBeadPlanSpec — backwards-compat passthrough", () => {
  it("returns passthrough when no hint is supplied (legacy plan)", () => {
    const outcome = expandBeadPlanSpec(
      {
        title: "Legacy bead",
        description: "Free-form description from the plan.",
      },
      PHASE,
    );
    expect(outcome.status).toBe("passthrough");
    if (outcome.status !== "passthrough") return;
    expect(outcome.description).toBe("Free-form description from the plan.");
    expect(outcome.title).toBe("Legacy bead");
  });

  it("returns passthrough with empty description when neither hint nor description is set", () => {
    const outcome = expandBeadPlanSpec({ title: "Bare bead" }, PHASE);
    expect(outcome.status).toBe("passthrough");
    if (outcome.status !== "passthrough") return;
    expect(outcome.description).toBe("");
  });

  it("treats a malformed hint as passthrough (warn-logged, bead flows through)", () => {
    const outcome = expandBeadPlanSpec(
      {
        title: "Bead with bad hint",
        template: "this is not a valid hint",
        description: "Free-form fallback.",
      },
      PHASE,
    );
    expect(outcome.status).toBe("passthrough");
    if (outcome.status !== "passthrough") return;
    expect(outcome.description).toBe("Free-form fallback.");
  });
});

describe("expandBeadPlanSpecs — ordered batch expansion", () => {
  it("expands mixed specs preserving order and surfaces per-bead errors", () => {
    const specs: BeadPlanSpec[] = [
      FOUNDATION_SPEC,
      { title: "Legacy", description: "Free-form." },
      { ...FOUNDATION_SPEC, template: "does-not-exist@1", title: "Bad one" },
    ];
    const outcomes: BeadExpansionOutcome[] = expandBeadPlanSpecs(specs, PHASE);
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0].status).toBe("expanded");
    expect(outcomes[1].status).toBe("passthrough");
    expect(outcomes[2].status).toBe("error");
    if (outcomes[2].status === "error") {
      expect(outcomes[2].code).toBe("template_not_found");
      expect(outcomes[2].title).toBe("Bad one");
    }
  });

  it("returns an empty array when given no specs", () => {
    expect(expandBeadPlanSpecs([], PHASE)).toEqual([]);
  });
});
