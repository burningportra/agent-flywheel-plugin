import type { Scenario, ScenarioFacts, ToolUseRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Goal-stability notes (M3 reopen round 3, 2026-10-15)
//
// Earlier scenarios used goals that overlapped with the compression program's
// own beads (e.g. "consolidate the three NTM readiness bash gates" was D1's
// own work). At any sha after D1 landed, Sonnet observed the repo state and
// asked an ad-hoc "Scope" question instead of running the plan flow.
//
// Every goal below names a SYNTHETIC redesign anchored on a `flywheel_*` MCP
// tool name that is deliberately unused in `mcp-server/src/tools/` and in
// `br list` (no D or E bead will land these). The MCP tool names change per
// scenario so per-worktree Agent Mail reservations and docs/brainstorms
// slugs don't collide when the eval runs in parallel.
//
// The goals are deliberately MULTI-COMPONENT (schema + tests + migration +
// docs + telemetry). The flywheel is meant to plan these, not treat them
// as five-minute edits.
//
// Scripted-label contract (M3 reopen round 3): every label referenced below
// must appear verbatim as an option in the matching AskUserQuestion header
// in the current skills tree. The harness's `pick.ts` matches rules against
// the question `header` only, substring-matches `option` against offered
// labels, and fails the scenario on an unmatched target rather than
// injecting free text. If an upstream skill rewords an option, that label
// move surfaces as a `harness: scripted target "..." matched no option ...`
// violation and the scenario here must be updated — don't paper over it.
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

// Shared steering: picks that drive the model past Pre-flight and the
// framing stage to Step 5 without triggering a long grill-with-docs
// interview. The Phase 0.5 Qs (Smallest / 10x / Adjacents) are also
// scripted in case the orchestrator runs the light pressure-test despite
// the pre-written brainstorm fixture.
const COMMON_SCRIPTED = [
  // Pre-flight / setup
  { headerContains: "pre-flight", option: "Continue with degraded" },
  { headerContains: "setup fixes", option: "Continue with degraded" },
  // Framing: skip so Phase 0.5 skip conditions apply via the brainstorm.
  { headerContains: "framing", option: "Skip framing" },
  // Phase 0.5 three-question pressure-test (fires only if skip didn't apply).
  { headerContains: "smallest", option: "Happy-path MVP" },
  { headerContains: "floor", option: "Happy-path MVP" },
  { headerContains: "10x", option: "Breadth expansion" },
  { headerContains: "ceiling", option: "Breadth expansion" },
  { headerContains: "adjacents", option: "Nothing adjacent" },
  // Grill-with-docs branch (fires if the operator picked Grill with docs).
  { headerContains: "decompose", option: "Keep as one cycle" },
  { headerContains: "problem", option: "Missing capability" },
  { headerContains: "non-goals", option: "No new dependencies" },
  { headerContains: "success", option: "Tests / CI gate" },
  { headerContains: "constraints", option: "Compatibility" },
  { headerContains: "kill criteria", option: "None — framing is solid" },
  { headerContains: "kill signal", option: "Record as kill criterion, proceed" },
  { headerContains: "approve", option: "Approve" },
  // Mid-plan steering (the model generates these per-plan — options vary).
  // No rule means pick.ts falls back to options[0] and logs a `default` event.
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
      { headerContains: "plan ready", option: "Create beads" },
      { headerContains: "rubric", option: "Abort" },
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
    maxTurns: 40,
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
      // Pick Review plan at the first Plan-ready ask — the assertion is
      // "no br create BEFORE the Plan-ready ask fires", so any pick works;
      // Review plan avoids triggering the whole bead-create pipeline on
      // every run and keeps per-scenario cost down.
      { headerContains: "plan ready", option: "Review plan" },
      { headerContains: "post-review", option: "Looks good" },
      { headerContains: "refine mode", option: "Abort" },
      { headerContains: "rubric", option: "Abort" },
      ...COMMON_SCRIPTED,
    ],
    assert: (facts) => {
      const violations: string[] = [];
      const planGate = asksByHeader(facts, "plan ready")[0];
      const anchorTurn = planGate?.turn ?? Number.POSITIVE_INFINITY;
      const early = brCreateBeforeTurn(facts, anchorTurn);
      if (early.length > 0) {
        violations.push(
          `${early.length} \`br create\` call(s) fired before Plan-ready menu (turns ${early
            .map((t) => t.turn)
            .join(", ")})`,
        );
      }
      if (!planGate) {
        violations.push(
          "Plan-ready AskUserQuestion not observed within turn budget.",
        );
      }
      return violations;
    },
    maxTurns: 70,
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
      // Ambition-pass follow-up questions.
      { headerContains: "rung", option: "Standing outcome" },
      { headerContains: "stretch", option: "Full stretch" },
      { headerContains: "plan ready", option: "Create beads" },
      { headerContains: "rubric", option: "Abort" },
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
    maxTurns: 80,
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
      { headerContains: "plan ready", option: "Create beads" },
      // Rubric gate: picking Skip rubric is the recommended terminator.
      // The assertion only checks that flywheel_synthesize_rubric fired,
      // which happens immediately before this ask.
      { headerContains: "rubric", option: "Skip rubric" },
      { headerContains: "beads", option: "Reject" },
      { headerContains: "launch", option: "Back to plan" },
      ...COMMON_SCRIPTED,
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
    maxTurns: 100,
  },
];

export type { Scenario, ScenarioFacts } from "./types.js";
