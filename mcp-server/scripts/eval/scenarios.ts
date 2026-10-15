import type { Scenario, ScenarioFacts, ToolUseRecord } from "./types.js";

const asksByHeader = (
  facts: ScenarioFacts,
  headerSubstring: string,
): ToolUseRecord[] => {
  const needle = headerSubstring.toLowerCase();
  return facts.toolUses.filter(
    (t) =>
      t.tool_name === "AskUserQuestion" &&
      ((t.input["questions"] as Array<Record<string, unknown>>) || []).some(
        (q) => String(q["header"] ?? "").toLowerCase().includes(needle),
      ),
  );
};

const questionWithHeader = (
  ask: ToolUseRecord,
  headerSubstring: string,
): Record<string, unknown> | undefined => {
  const needle = headerSubstring.toLowerCase();
  const qs = (ask.input["questions"] as Array<Record<string, unknown>>) || [];
  return qs.find((q) => String(q["header"] ?? "").toLowerCase().includes(needle));
};

const brCreateBeforeTurn = (
  facts: ScenarioFacts,
  anchorTurn: number,
): ToolUseRecord[] =>
  facts.toolUses.filter(
    (t) =>
      t.turn < anchorTurn &&
      t.tool_name === "Bash" &&
      typeof t.input["command"] === "string" &&
      /\bbr\s+create\b/.test(t.input["command"] as string),
  );

const findFlywheelTool = (
  facts: ScenarioFacts,
  nameSuffix: string,
): ToolUseRecord | undefined =>
  facts.toolUses.find(
    (t) => t.tool_name === nameSuffix || t.tool_name.endsWith(`__${nameSuffix}`),
  );

const findWrite = (
  facts: ScenarioFacts,
  pathPattern: RegExp,
): ToolUseRecord | undefined =>
  facts.toolUses.find(
    (t) =>
      (t.tool_name === "Write" || t.tool_name === "Edit") &&
      typeof t.input["file_path"] === "string" &&
      pathPattern.test(t.input["file_path"] as string),
  );

export const SCENARIOS: Scenario[] = [
  {
    id: "s1-step0d-and-step5",
    description:
      "Fresh /agent-flywheel:start emits a goal-routing menu (Step 0d) and a Plan-mode menu with 4 options (Step 5).",
    goal: "/agent-flywheel:start make the CLI 10% faster",
    scripted: [
      { headerContains: "goal input", option: "Yes, full flywheel" },
      { headerContains: "goal", option: "Yes, full flywheel" },
      { headerContains: "metric", option: "Startup time" },
      { headerContains: "smallest", option: "Happy-path MVP" },
      { headerContains: "plan mode", option: "Standard" },
      { headerContains: "ambition", option: "Scoped" },
      { headerContains: "target cli", option: "lint:skill" },
      { headerContains: "target", option: "lint:skill" },
      { headerContains: "approach", option: "compiled" },
      { headerContains: "plan gate", option: "Stop here" },
      { headerContains: "plan ready", option: "Stop here" },
    ],
    assert: (facts) => {
      const violations: string[] = [];

      const goalAsks = asksByHeader(facts, "goal");
      if (goalAsks.length === 0) {
        violations.push("Step 0d goal-routing AskUserQuestion not observed");
      }

      const planAsks = asksByHeader(facts, "plan mode");
      if (planAsks.length === 0) {
        violations.push("Step 5 Plan-mode AskUserQuestion not observed");
      } else {
        const q = questionWithHeader(planAsks[0], "plan mode");
        const opts = (q?.["options"] as unknown[]) || [];
        if (opts.length !== 4) {
          violations.push(
            `Step 5 Plan-mode question has ${opts.length} options, expected 4`,
          );
        }
      }
      return violations;
    },
    maxTurns: 25,
  },
  {
    id: "s2-standard-no-early-br-create",
    description:
      "Standard plan path reaches the plan-ready/plan-gate menu and runs no `br create` before the user picks Create beads.",
    goal: "/agent-flywheel:start make the CLI 10% faster",
    scripted: [
      { headerContains: "goal", option: "Yes, full flywheel" },
      { headerContains: "metric", option: "Startup time" },
      { headerContains: "smallest", option: "Happy-path MVP" },
      { headerContains: "plan mode", option: "Standard" },
      { headerContains: "ambition", option: "Scoped" },
      { headerContains: "target cli", option: "lint:skill" },
      { headerContains: "target", option: "lint:skill" },
      { headerContains: "approach", option: "compiled" },
      // Plan gate (3 options: Create beads / Refine plan / Stop here) —
      // pick "Stop here" so the no-br-create invariant is testable.
      { headerContains: "plan gate", option: "Stop here" },
      { headerContains: "plan ready", option: "Stop here" },
    ],
    assert: (facts) => {
      const violations: string[] = [];
      const planGate =
        asksByHeader(facts, "plan gate")[0] ?? asksByHeader(facts, "plan ready")[0];
      const anchorTurn = planGate?.turn ?? Number.POSITIVE_INFINITY;
      const early = brCreateBeforeTurn(facts, anchorTurn);
      if (early.length > 0) {
        violations.push(
          `${early.length} \`br create\` call(s) fired before plan-gate menu (turns ${early
            .map((t) => t.turn)
            .join(", ")})`,
        );
      }
      if (!planGate) {
        violations.push(
          "Plan-gate / plan-ready AskUserQuestion not observed (standard path did not reach the gate within turn budget)",
        );
      }
      return violations;
    },
    maxTurns: 60,
  },
  {
    id: "s3-ambitious-writes-charter-first",
    description:
      "Ambitious path writes docs/brainstorms/<slug>-<date>-ambition.md before calling flywheel_plan with ambition='ambitious'.",
    goal: "/agent-flywheel:start make the CLI 10% faster",
    scripted: [
      { headerContains: "goal", option: "Yes, full flywheel" },
      { headerContains: "metric", option: "Startup time" },
      { headerContains: "smallest", option: "Happy-path MVP" },
      { headerContains: "plan mode", option: "Standard" },
      { headerContains: "ambition", option: "Ambitious" },
      { headerContains: "target cli", option: "lint:skill" },
      { headerContains: "target", option: "lint:skill" },
      { headerContains: "approach", option: "compiled" },
      { headerContains: "plan gate", option: "Stop here" },
      { headerContains: "plan ready", option: "Stop here" },
    ],
    assert: (facts) => {
      const violations: string[] = [];
      const planCall = facts.toolUses.find((t) => {
        const isPlan =
          t.tool_name === "flywheel_plan" ||
          t.tool_name.endsWith("__flywheel_plan");
        if (!isPlan) return false;
        return (
          String(t.input["ambition"] ?? "").toLowerCase() === "ambitious"
        );
      });
      if (!planCall) {
        violations.push(
          "flywheel_plan with ambition='ambitious' not observed on ambitious path",
        );
        return violations;
      }
      const charterWrite = facts.toolUses.find(
        (t) =>
          t.turn < planCall.turn &&
          (t.tool_name === "Write" || t.tool_name === "Edit") &&
          typeof t.input["file_path"] === "string" &&
          /docs\/brainstorms\/.+-ambition\.md$/.test(t.input["file_path"] as string),
      );
      if (!charterWrite) {
        violations.push(
          "Ambition charter write under docs/brainstorms/<slug>-<date>-ambition.md not observed before flywheel_plan",
        );
      }
      return violations;
    },
    maxTurns: 60,
  },
  {
    id: "s4-rubric-gate-before-bead-creation",
    description:
      "Choosing Create beads triggers the Step 5.6.5 rubric gate (flywheel_synthesize_rubric) before any bead creation.",
    goal: "/agent-flywheel:start make the CLI 10% faster",
    scripted: [
      { headerContains: "goal", option: "Yes, full flywheel" },
      { headerContains: "metric", option: "Startup time" },
      { headerContains: "smallest", option: "Happy-path MVP" },
      { headerContains: "plan mode", option: "Standard" },
      { headerContains: "ambition", option: "Scoped" },
      { headerContains: "target cli", option: "lint:skill" },
      { headerContains: "target", option: "lint:skill" },
      { headerContains: "approach", option: "compiled" },
      { headerContains: "plan gate", option: "Create beads" },
      { headerContains: "plan ready", option: "Create beads" },
      { headerContains: "rubric", option: "Approve" },
    ],
    assert: (facts) => {
      const violations: string[] = [];
      const rubricCall = findFlywheelTool(facts, "flywheel_synthesize_rubric");
      if (!rubricCall) {
        violations.push(
          "flywheel_synthesize_rubric not observed after picking Create beads",
        );
        return violations;
      }
      const earlyBr = brCreateBeforeTurn(facts, rubricCall.turn);
      if (earlyBr.length > 0) {
        violations.push(
          `${earlyBr.length} \`br create\` call(s) fired before Step 5.6.5 rubric gate`,
        );
      }
      return violations;
    },
    maxTurns: 80,
  },
];

// Keep the helper exports so types.ts users can reach ScenarioFacts without importing.
export type { Scenario, ScenarioFacts } from "./types.js";
// Mark findWrite as intentionally referenced for tooling that strips unused symbols.
export const _internal = { findWrite };
