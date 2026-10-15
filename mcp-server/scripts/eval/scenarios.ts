import type { Scenario, ScenarioFacts, ToolUseRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Goal-stability notes (M3 reopen, 2026-10-15)
//
// Earlier scenarios used goals that overlapped with the compression program's
// own beads (e.g. "consolidate the three NTM readiness bash gates" was D1's
// own work). At any sha after D1 landed, Sonnet observed the repo state and
// asked an ad-hoc "Scope" question instead of running the plan flow, which
// then interacts badly with the harness's scripted-answer matcher.
//
// Every goal below names a SYNTHETIC redesign anchored on a `flywheel_*` MCP
// tool name that is deliberately unused in `mcp-server/src/tools/` and in
// `br list` (no D or E bead will land these). The MCP tool names change per
// scenario so per-worktree Agent Mail reservations and docs/brainstorms
// slugs don't collide when the eval runs in parallel.
//
// The goals are deliberately MULTI-COMPONENT (schema + tests + migration +
// docs + telemetry). An initial pass with narrow single-feature goals
// ("add a new MCP tool `flywheel_echo`...") caused Sonnet to short-circuit
// the orchestrator entirely at 768345f — the goal looked trivial enough
// that the model skipped planning and implemented directly. Keeping the
// goals cross-cutting forces the Plan-mode / Ambition / rubric gates the
// scenarios assert on.
// ---------------------------------------------------------------------------

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

const COMMON_SCRIPTED = [
  { headerContains: "plan review", option: "Stop here" },
  { headerContains: "plan gate", option: "Stop here" },
  { headerContains: "plan ready", option: "Stop here" },
  { headerContains: "framing", option: "Light framing" },
  { headerContains: "pre-flight", option: "Continue" },
  { headerContains: "setup fixes", option: "Continue" },
  { headerContains: "goal input", option: "Yes, full flywheel" },
  { headerContains: "goal", option: "Yes, full flywheel" },
];

export const SCENARIOS: Scenario[] = [
  {
    id: "s1-step0d-and-step5",
    description:
      "After the Phase 0.5 brainstorm skip, Step 5 fires a Plan-mode (4 options) + Ambition (2 options) AskUserQuestion.",
    goal:
      "/agent-flywheel:start design the `flywheel_echo` observability subsystem — add a new MCP tool that returns a prefixed message plus structured telemetry per call, a shared Zod schema registry used by every existing tool handler, a conformance test suite covering every schema, AGENTS.md documentation of the registry pattern, a migration guide for third-party plugin authors, and a dashboard view exposing per-tool telemetry trends",
    scripted: [
      { headerContains: "plan mode", option: "Standard plan" },
      { headerContains: "ambition", option: "As scoped" },
      ...COMMON_SCRIPTED,
    ],
    assert: (facts) => {
      const violations: string[] = [];
      const planAsks = asksByHeader(facts, "plan mode");
      if (planAsks.length === 0) {
        violations.push(
          "Step 5 Plan-mode AskUserQuestion not observed; investigate skill drift.",
        );
      } else {
        const q = questionWithHeader(planAsks[0], "plan mode");
        const opts = (q?.["options"] as unknown[]) || [];
        if (opts.length !== 4) {
          violations.push(
            `Step 5 Plan-mode question has ${opts.length} options, expected 4.`,
          );
        }
      }
      const ambAsks = asksByHeader(facts, "ambition");
      if (ambAsks.length === 0) {
        violations.push("Step 5 Ambition AskUserQuestion not observed.");
      } else {
        const q = questionWithHeader(ambAsks[0], "ambition");
        const opts = (q?.["options"] as unknown[]) || [];
        if (opts.length !== 2) {
          violations.push(
            `Step 5 Ambition question has ${opts.length} options, expected 2.`,
          );
        }
      }
      return violations;
    },
    maxTurns: 30,
  },
  {
    id: "s2-standard-no-early-br-create",
    description:
      "Standard plan path reaches the plan-ready/plan-gate menu and runs no `br create` before the user picks Create beads.",
    goal:
      "/agent-flywheel:start build the `flywheel_ping` caching subsystem — a new MCP tool returning cache-stats, a TTL-driven cache layer wrapping every read-heavy tool handler, a benchmark harness proving a measurable latency improvement, documentation of per-field staleness windows in AGENTS.md, a migration guide for callers that depended on uncached reads, telemetry hooks, and regression tests across the full doctor sweep",
    scripted: [
      { headerContains: "plan mode", option: "Standard plan" },
      { headerContains: "ambition", option: "As scoped" },
      ...COMMON_SCRIPTED,
    ],
    assert: (facts) => {
      const violations: string[] = [];
      const planGate =
        asksByHeader(facts, "plan review")[0] ??
        asksByHeader(facts, "plan gate")[0] ??
        asksByHeader(facts, "plan ready")[0];
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
          "Plan-gate / plan-ready AskUserQuestion not observed within turn budget.",
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
    goal:
      "/agent-flywheel:start redesign the compliance signal pipeline around a new `flywheel_lint_imports` MCP tool — a shared pattern-match engine, per-source-file config, structured violation output, a vitest conformance suite covering every pattern, telemetry hooks on each scan, a migration guide for the current scanner's consumers, dashboards for pattern-hit frequency, and AGENTS.md documentation of the rule-set contract",
    scripted: [
      { headerContains: "plan mode", option: "Standard plan" },
      { headerContains: "ambition", option: "Ambitious" },
      ...COMMON_SCRIPTED,
    ],
    assert: (facts) => {
      const violations: string[] = [];
      const planCall = facts.toolUses.find((t) => {
        const isPlan =
          t.tool_name === "flywheel_plan" ||
          t.tool_name.endsWith("__flywheel_plan");
        if (!isPlan) return false;
        return String(t.input["ambition"] ?? "").toLowerCase() === "ambitious";
      });
      if (!planCall) {
        violations.push(
          "flywheel_plan with ambition='ambitious' not observed on ambitious path.",
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
          "Ambition charter write under docs/brainstorms/<slug>-<date>-ambition.md not observed before flywheel_plan.",
        );
      }
      return violations;
    },
    maxTurns: 70,
  },
  {
    id: "s4-rubric-gate-before-bead-creation",
    description:
      "Choosing Create beads triggers the Step 5.6.5 rubric gate (flywheel_synthesize_rubric) before any bead creation.",
    goal:
      "/agent-flywheel:start architect the `flywheel_hash_bead` fingerprinting subsystem — a new MCP tool returning a stable sha256 fingerprint of a bead, a shared hashing module reused by compliance-audit and verify-beads, telemetry on fingerprint computations, a migration guide for existing audit tooling, a conformance test suite proving determinism across inputs, documentation of the fingerprint schema in AGENTS.md, and a dashboard view exposing fingerprint-change frequency",
    scripted: [
      { headerContains: "plan mode", option: "Standard plan" },
      { headerContains: "ambition", option: "As scoped" },
      { headerContains: "plan review", option: "Create beads" },
      { headerContains: "plan gate", option: "Create beads" },
      { headerContains: "plan ready", option: "Create beads" },
      { headerContains: "rubric", option: "Approve" },
      { headerContains: "framing", option: "Light framing" },
      { headerContains: "pre-flight", option: "Continue" },
      { headerContains: "setup fixes", option: "Continue" },
      { headerContains: "goal input", option: "Yes, full flywheel" },
      { headerContains: "goal", option: "Yes, full flywheel" },
    ],
    assert: (facts) => {
      const violations: string[] = [];
      const rubricCall = findFlywheelTool(facts, "flywheel_synthesize_rubric");
      if (!rubricCall) {
        violations.push(
          "flywheel_synthesize_rubric not observed after picking Create beads.",
        );
        return violations;
      }
      const earlyBr = brCreateBeforeTurn(facts, rubricCall.turn);
      if (earlyBr.length > 0) {
        violations.push(
          `${earlyBr.length} \`br create\` call(s) fired before Step 5.6.5 rubric gate.`,
        );
      }
      return violations;
    },
    maxTurns: 90,
  },
];

export type { Scenario, ScenarioFacts } from "./types.js";
