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
      // "Beads init" fires when the eval worktree has no `.beads/` DB
      // yet. Must be ORDERED BEFORE the generic `beads` rule because
      // headerContains matches the first rule by substring order.
      { headerContains: "beads init", option: "Run br init" },
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
  // -------------------------------------------------------------------------
  // 4p7: cover start_implement, start_review, start_wrapup past bead approval
  // -------------------------------------------------------------------------
  {
    id: "s5-dispatch-server-prompts",
    description:
      "At phase=implementing with approved beads pre-seeded, /start loads start_implement and robot-sends via a PATH-shimmed `ntm` that logs argv and exits 0, so no real pane spawns.",
    goal:
      "/agent-flywheel:start resume implementation — dispatch the ready beads via the standard swarm path",
    scripted: [
      { headerContains: "plan mode", option: "Standard plan" },
      { headerContains: "ambition", option: "As scoped" },
      { headerContains: "plan ready", option: "Create beads" },
      // Picking "Skip rubric" lets flywheel_approve_beads(start) fire; the
      // Beads header follows. "Start implementing" is the dispatch step.
      { headerContains: "rubric", option: "Skip rubric" },
      { headerContains: "beads", option: "Start implementing" },
      // Pick a dispatching option at Launch so the orchestrator loads
      // start_implement and robot-sends through the ntm shim. "launch"
      // (lowercase) substring-matches every dispatching option across
      // observed menu shapes: "Launch (Recommended)" and
      // "Coordinator-serial launch (one bead at a time, contention-safe)".
      // The ntm shim installed by prepareFixtures logs argv to
      // `.pi-flywheel/eval-bin/ntm.log` and exits 0 — no real pane spawns.
      { headerContains: "launch", option: "launch" },
      // The orchestrator sometimes asks a separate `Init beads` menu
      // when the eval worktree has no `.beads/` yet; let it run `br init`
      // so the dispatch path keeps going.
      { headerContains: "init beads", option: "Run br init" },
      // Avoid a mid-wave fresh-eyes review burning turns; off is cheapest.
      { headerContains: "batch review", option: "Off" },
      // Looper-based tending — the Recommended path. Note the AGENTS.md
      // contract still requires NTM for the DISPATCH itself regardless
      // of which tending mode is picked.
      { headerContains: "supervision", option: "Looper-based" },
      // Goal-labelling (fires on checkpoint-resume when the stored goal
      // was redacted or missing).
      { headerContains: "goal", option: "Use default" },
      // Fallback shared steering (same shape as the earlier four).
      { headerContains: "pre-flight", option: "Continue with degraded" },
      { headerContains: "setup fixes", option: "Continue with degraded" },
      { headerContains: "framing", option: "Skip framing" },
      { headerContains: "smallest", option: "Happy-path MVP" },
      { headerContains: "floor", option: "Happy-path MVP" },
      { headerContains: "10x", option: "Breadth expansion" },
      { headerContains: "ceiling", option: "Breadth expansion" },
      { headerContains: "adjacents", option: "Nothing adjacent" },
      { headerContains: "decompose", option: "Keep as one cycle" },
      { headerContains: "problem", option: "Missing capability" },
      { headerContains: "non-goals", option: "No new dependencies" },
      { headerContains: "success", option: "Tests / CI gate" },
      { headerContains: "constraints", option: "Compatibility" },
      { headerContains: "kill criteria", option: "None — framing is solid" },
      { headerContains: "kill signal", option: "Record as kill criterion, proceed" },
      { headerContains: "approve", option: "Approve" },
    ],
    prepareFixtures: async (worktree) => {
      const { mkdir, writeFile, chmod } = await import("node:fs/promises");
      const { execFileSync } = await import("node:child_process");
      const { join } = await import("node:path");
      const binDir = join(worktree, ".pi-flywheel", "eval-bin");
      await mkdir(binDir, { recursive: true });
      // `ntm` shim: log every argv to a file inside the worktree and exit
      // 0 so dispatch doesn't actually spawn panes. The skill's
      // "NTM-unavailable fallback" path triggers when `ntm deps -v` prints
      // nothing or looks unhealthy, so the shim prints a healthy-looking
      // line for `deps` / `--version` and still logs argv for `spawn` /
      // `--robot-send`. `--robot-send` payloads are the key evidence —
      // they must carry the server-built per-bead prompt.
      const ntmShim = `#!/usr/bin/env bash
set -u
log="${binDir}/ntm.log"
printf '%s\\0' "$@" >> "$log"
printf '\\n--CALL--\\n' >> "$log"
case "\${1:-}" in
  deps|--deps)
    echo "ntm-eval-shim: healthy (claude cc=ok cod=ok gem=ok)"
    ;;
  --version)
    echo "ntm-eval-shim 0.0.0"
    ;;
  config)
    if [ "\${2:-}" = "show" ]; then
      # Pretend projects_base is this worktree's parent so the doctor
      # row stays green and the dispatch path keeps going.
      printf 'projects_base=%s\\n' "\${PWD%/*}"
    fi
    ;;
  *)
    : # fall through; argv already logged
    ;;
esac
exit 0
`;
      const ntmPath = join(binDir, "ntm");
      await writeFile(ntmPath, ntmShim, "utf8");
      await chmod(ntmPath, 0o755);
      // Create a real bead in `.beads/` so the orchestrator doesn't bail
      // out with "No beads" and ask whether to Treat-as-goal / Scan /
      // Pick-up-existing-plan. The orchestrator reads the beads DB via
      // `br list`, so a checkpoint stub alone is insufficient.
      await mkdir(join(worktree, ".pi-flywheel"), { recursive: true });
      execFileSync("br", ["init", "--prefix", "eval"], { cwd: worktree, stdio: "ignore" });
      const beadId = execFileSync(
        "br",
        [
          "create",
          "--priority",
          "p1",
          "-t",
          "task",
          "--silent",
          "--description",
          "Eval fixture bead: dispatch-only scenario. The scenario's goal is to observe start_implement loading plus a `ntm --robot-send` call through the shim; the model never actually edits code.",
          "Add a tiny docstring to AGENTS.md",
        ],
        { cwd: worktree, encoding: "utf8" },
      ).trim();
      const now = new Date().toISOString();
      const checkpoint = {
        schemaVersion: 1,
        writtenAt: now,
        flywheelVersion: "eval-fixture",
        state: {
          phase: "implementing",
          selectedGoal: "resume implementation — dispatch the ready beads via the standard swarm path",
          goalSlug: "resume-implementation-dispatch",
          constraints: [],
          retryCount: 0,
          maxRetries: 3,
          maxReviewPasses: 2,
          iterationRound: 0,
          currentGateIndex: 0,
          activeBeadIds: [beadId],
          currentBeadId: beadId,
        },
        stateHash: "",
      };
      await writeFile(
        join(worktree, ".pi-flywheel", "checkpoint.json"),
        JSON.stringify(checkpoint, null, 2),
        "utf8",
      );
    },
    assert: (facts) => {
      const violations: string[] = [];
      const implementSkillLoad = facts.toolUses.find(
        (t) =>
          (t.tool_name === "flywheel_get_skill" ||
            t.tool_name.endsWith("__flywheel_get_skill")) &&
          String(t.input["name"] ?? "").includes("start_implement"),
      );
      if (!implementSkillLoad) {
        violations.push(
          "flywheel_get_skill(name: 'agent-flywheel:start_implement') never observed; dispatch did not reach _implement.md.",
        );
      }
      const ntmCalls = facts.toolUses.filter(
        (t) =>
          t.tool_name === "Bash" &&
          typeof t.input["command"] === "string" &&
          /\bntm\b/.test(t.input["command"] as string) &&
          /--robot-send/.test(t.input["command"] as string),
      );
      if (ntmCalls.length === 0) {
        violations.push(
          "No `ntm --robot-send` Bash call observed; dispatch never ran the robot-send through the ntm shim.",
        );
      } else {
        // The server-built implementer prompt from flywheel_approve_beads(start)
        // / completion-attestation-prompt.ts always directs the implementer to
        // write `.pi-flywheel/completion/<bead>.json`. That path is unique to
        // the server-built prompt text — a model-improvised robot-send would
        // not include it. Treat this substring as the marker that the
        // dispatcher forwarded the server bytes rather than paraphrased.
        const marker = ".pi-flywheel/completion";
        const hasMarker = ntmCalls.some(
          (t) => String(t.input["command"] ?? "").includes(marker),
        );
        if (!hasMarker) {
          violations.push(
            `No \`ntm --robot-send\` payload carried the server-built-prompt marker "${marker}"; dispatcher may have paraphrased the implementer prompt instead of forwarding the bytes.`,
          );
        }
      }
      return violations;
    },
    maxTurns: 120,
  },
  {
    id: "s6-review-wrapup-outcome-gate",
    description:
      "At phase=wrapup with a tiny closed bead pre-seeded, /start routes to the wrap-up flow and the outcome-grading/verdict gate fires (either flywheel_grade_outcome runs or the rubric-skip path short-circuits).",
    goal:
      "/agent-flywheel:start wrap up the completed cycle, run the outcome grader, and record the verdict",
    scripted: [
      { headerContains: "review mode", option: "Looks good" },
      { headerContains: "review", option: "Looks good" },
      { headerContains: "verdict", option: "Satisfied" },
      { headerContains: "grading", option: "Accept and continue" },
      { headerContains: "iterate", option: "Accept anyway" },
      { headerContains: "rubric", option: "Skip rubric" },
      // Grader short-circuit: when flywheel_grade_outcome can't run
      // (no rubric persisted), the skill asks the Recover menu. Accept
      // without grade terminates the cycle cleanly.
      { headerContains: "recover", option: "Accept without grade" },
      { headerContains: "wrap-up", option: "Skip wrap-up" },
      { headerContains: "stray files", option: "Skip stray files" },
      { headerContains: "version", option: "Skip" },
      { headerContains: "post-mortem", option: "Skip" },
      // Fallback steering if the orchestrator reroutes mid-stream.
      { headerContains: "pre-flight", option: "Continue with degraded" },
      { headerContains: "framing", option: "Skip framing" },
      { headerContains: "goal input", option: "Yes, full flywheel" },
      { headerContains: "goal", option: "Yes, full flywheel" },
    ],
    prepareFixtures: async (worktree) => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await mkdir(join(worktree, ".pi-flywheel", "completion"), { recursive: true });
      // Pre-seed a tiny closed bead's attestation. The orchestrator reads
      // this via flywheel_verify_beads at wrap-up and gates on its presence.
      const stubBeadId = "flywheel-eval-stub-closed-bead";
      const now = new Date().toISOString();
      const attestation = {
        version: 1,
        beadId: stubBeadId,
        agentName: "EvalFixture",
        status: "closed",
        changedFiles: ["AGENTS.md"],
        commits: ["0000000"],
        ubs: {
          ran: false,
          summary: "fixture — docs-only diff",
          findingsFixed: 0,
          deferredBeadIds: [],
          skippedReason: "eval fixture; not a real diff",
        },
        verify: [
          { command: "echo fixture", exitCode: 0, summary: "fixture pass" },
        ],
        selfReview: { ran: true, summary: "fixture pre-seeded by s6" },
        beadClosedVerified: true,
        reservationsReleased: true,
        createdAt: now,
      };
      await writeFile(
        join(worktree, ".pi-flywheel", "completion", `${stubBeadId}.json`),
        JSON.stringify(attestation, null, 2),
        "utf8",
      );
      // Pre-seed a wrap-up-phase checkpoint. `flywheelVersion` is left
      // blank because the orchestrator doesn't gate on an exact match for
      // test purposes, and `stateHash` is left blank for the same reason;
      // the loader tolerates both for fixture use.
      const checkpoint = {
        schemaVersion: 1,
        writtenAt: now,
        flywheelVersion: "eval-fixture",
        state: {
          phase: "wrapup",
          selectedGoal: "wrap up the completed cycle, run the outcome grader, and record the verdict",
          goalSlug: "wrap-up-the-completed-cycle",
          constraints: [],
          retryCount: 0,
          maxRetries: 3,
          maxReviewPasses: 2,
          iterationRound: 0,
          currentGateIndex: 0,
          activeBeadIds: [stubBeadId],
          outcomeGradingSkipped: false,
        },
        stateHash: "",
      };
      await writeFile(
        join(worktree, ".pi-flywheel", "checkpoint.json"),
        JSON.stringify(checkpoint, null, 2),
        "utf8",
      );
    },
    assert: (facts) => {
      const violations: string[] = [];
      const reviewed = facts.toolUses.find(
        (t) =>
          t.tool_name === "flywheel_review" ||
          t.tool_name.endsWith("__flywheel_review"),
      );
      const graded = facts.toolUses.find(
        (t) =>
          t.tool_name === "flywheel_grade_outcome" ||
          t.tool_name.endsWith("__flywheel_grade_outcome"),
      );
      const rubricSkip = facts.toolUses.find(
        (t) =>
          (t.tool_name === "flywheel_synthesize_rubric" ||
            t.tool_name.endsWith("__flywheel_synthesize_rubric")) &&
          String(t.input["action"] ?? "").toLowerCase() === "skip",
      );
      const verifyBeads = facts.toolUses.find(
        (t) =>
          t.tool_name === "flywheel_verify_beads" ||
          t.tool_name.endsWith("__flywheel_verify_beads"),
      );
      if (!reviewed && !graded && !rubricSkip && !verifyBeads) {
        violations.push(
          "neither flywheel_review nor flywheel_grade_outcome nor flywheel_synthesize_rubric(skip) nor flywheel_verify_beads observed; wrap-up/review phase never engaged",
        );
      }
      // Any of these headers means a wrap-up / review skill menu fired.
      // The grader "Recover" menu is the one the skill asks when
      // `flywheel_grade_outcome` can't run (no rubric), which is itself
      // evidence that the wrap-up skill routed through outcome-grading.
      const wrapAsk =
        asksByHeader(facts, "verdict")[0] ??
        asksByHeader(facts, "grading")[0] ??
        asksByHeader(facts, "iterate")[0] ??
        asksByHeader(facts, "review mode")[0] ??
        asksByHeader(facts, "review")[0] ??
        asksByHeader(facts, "recover")[0] ??
        asksByHeader(facts, "wrap-up")[0] ??
        asksByHeader(facts, "post-mortem")[0];
      if (!wrapAsk) {
        violations.push(
          "No review-mode / verdict-gate / recover / wrap-up / post-mortem AskUserQuestion observed; skill-text menu never fired at wrap-up.",
        );
      }
      return violations;
    },
    maxTurns: 120,
  },
  {
    id: "s7-review-phase-flywheel-review",
    description:
      "At phase=reviewing with a tiny closed bead pre-seeded, /start loads start_review and calls flywheel_review on the bead.",
    goal:
      "/agent-flywheel:start review the just-closed bead and record the verdict",
    scripted: [
      // "Review target" asks what to review. Options vary by orchestrator
      // state — "Review n4k.4 commits (Recommended)" or
      // "Review commit n4k.1" or "HEAD commit (Recommended)". Using the
      // bare word "Review" substring-matches all three recommended-review
      // paths; the fallback is "HEAD commit" in older menu shapes.
      { headerContains: "review target", option: "Review" },
      { headerContains: "review mode", option: "Looks good" },
      { headerContains: "stragglers", option: "Continue" },
      { headerContains: "br errors", option: "Continue" },
      { headerContains: "compliance", option: "Continue" },
      { headerContains: "progress", option: "Continue" },
      { headerContains: "drift", option: "Continue" },
      { headerContains: "coverage", option: "Continue" },
      { headerContains: "ui polish", option: "Skip" },
      // Fallback steering.
      { headerContains: "pre-flight", option: "Continue with degraded" },
      { headerContains: "framing", option: "Skip framing" },
      { headerContains: "goal input", option: "Yes, full flywheel" },
      { headerContains: "goal", option: "Yes, full flywheel" },
    ],
    prepareFixtures: async (worktree) => {
      const { mkdir, writeFile, chmod } = await import("node:fs/promises");
      const { execFileSync } = await import("node:child_process");
      const { join } = await import("node:path");
      // Same ntm shim as s5 — reviewer prompts may spawn robot-sends too.
      const binDir = join(worktree, ".pi-flywheel", "eval-bin");
      await mkdir(binDir, { recursive: true });
      const ntmShim = `#!/usr/bin/env bash
set -u
log="${binDir}/ntm.log"
printf '%s\\0' "$@" >> "$log"
printf '\\n--CALL--\\n' >> "$log"
case "\${1:-}" in
  deps|--deps) echo "ntm-eval-shim: healthy (claude cc=ok cod=ok gem=ok)";;
  --version) echo "ntm-eval-shim 0.0.0";;
  config)
    if [ "\${2:-}" = "show" ]; then printf 'projects_base=%s\\n' "\${PWD%/*}"; fi
    ;;
esac
exit 0
`;
      await writeFile(join(binDir, "ntm"), ntmShim, "utf8");
      await chmod(join(binDir, "ntm"), 0o755);
      // Create a real closed bead in `.beads/` and attach a completion
      // attestation. The orchestrator reads from `br`, so a checkpoint
      // stub alone isn't enough to route the review phase at the stub id.
      execFileSync("br", ["init", "--prefix", "eval"], { cwd: worktree, stdio: "ignore" });
      const stubBeadId = execFileSync(
        "br",
        [
          "create",
          "--priority",
          "p1",
          "-t",
          "task",
          "--silent",
          "--description",
          "Eval fixture bead: review-phase scenario. Pre-closed with a stub attestation so flywheel_review has a bead to score.",
          "Review stub for s7",
        ],
        { cwd: worktree, encoding: "utf8" },
      ).trim();
      execFileSync("br", ["close", stubBeadId, "--reason", "eval fixture"], {
        cwd: worktree,
        stdio: "ignore",
      });
      await mkdir(join(worktree, ".pi-flywheel", "completion"), { recursive: true });
      const now = new Date().toISOString();
      const attestation = {
        version: 1,
        beadId: stubBeadId,
        agentName: "EvalFixture",
        status: "closed",
        changedFiles: ["AGENTS.md"],
        commits: ["0000000"],
        ubs: {
          ran: false,
          summary: "fixture — docs-only diff",
          findingsFixed: 0,
          deferredBeadIds: [],
          skippedReason: "eval fixture; not a real diff",
        },
        verify: [{ command: "echo fixture", exitCode: 0, summary: "fixture pass" }],
        selfReview: { ran: true, summary: "fixture pre-seeded by s7" },
        beadClosedVerified: true,
        reservationsReleased: true,
        createdAt: now,
      };
      await writeFile(
        join(worktree, ".pi-flywheel", "completion", `${stubBeadId}.json`),
        JSON.stringify(attestation, null, 2),
        "utf8",
      );
      const checkpoint = {
        schemaVersion: 1,
        writtenAt: now,
        flywheelVersion: "eval-fixture",
        state: {
          phase: "reviewing",
          selectedGoal: "review the just-closed bead and record the verdict",
          goalSlug: "review-the-just-closed-bead",
          constraints: [],
          retryCount: 0,
          maxRetries: 3,
          maxReviewPasses: 2,
          iterationRound: 0,
          currentGateIndex: 0,
          activeBeadIds: [stubBeadId],
          currentBeadId: stubBeadId,
          beadReviews: {},
        },
        stateHash: "",
      };
      await writeFile(
        join(worktree, ".pi-flywheel", "checkpoint.json"),
        JSON.stringify(checkpoint, null, 2),
        "utf8",
      );
    },
    assert: (facts) => {
      const violations: string[] = [];
      // Both assertions are strict (per 4p7 reopen round 2): SKILL.md's
      // Universal Rule 3 requires `flywheel_get_skill(start_<phase>)` at
      // every phase boundary before any tool in that phase runs. If the
      // model skips the phase skill (as the resume path currently does),
      // the eval must record it as a fail — that's the point.
      const reviewSkillLoad = facts.toolUses.find(
        (t) =>
          (t.tool_name === "flywheel_get_skill" ||
            t.tool_name.endsWith("__flywheel_get_skill")) &&
          String(t.input["name"] ?? "").includes("start_review"),
      );
      if (!reviewSkillLoad) {
        violations.push(
          "flywheel_get_skill(name: 'agent-flywheel:start_review') never observed; SKILL.md Universal Rule 3 says every phase boundary must load the phase skill before any tool runs.",
        );
      }
      const reviewCall = facts.toolUses.find(
        (t) =>
          t.tool_name === "flywheel_review" ||
          t.tool_name.endsWith("__flywheel_review"),
      );
      if (!reviewCall) {
        violations.push(
          "flywheel_review not called; review phase never engaged.",
        );
      }
      return violations;
    },
    maxTurns: 120,
  },
];

export type { Scenario, ScenarioFacts } from "./types.js";
