const asksByHeader = (facts, headerSubstring) => {
    const needle = headerSubstring.toLowerCase();
    return facts.toolUses.filter((t) => t.tool_name === "AskUserQuestion" &&
        (t.input["questions"] || []).some((q) => String(q["header"] ?? "").toLowerCase().includes(needle)));
};
const questionWithHeader = (ask, headerSubstring) => {
    const needle = headerSubstring.toLowerCase();
    const qs = ask.input["questions"] || [];
    return qs.find((q) => String(q["header"] ?? "").toLowerCase().includes(needle));
};
const brCreateBeforeTurn = (facts, anchorTurn) => facts.toolUses.filter((t) => t.turn < anchorTurn &&
    t.tool_name === "Bash" &&
    typeof t.input["command"] === "string" &&
    /\bbr\s+create\b/.test(t.input["command"]));
const findFlywheelTool = (facts, nameSuffix) => facts.toolUses.find((t) => t.tool_name === nameSuffix || t.tool_name.endsWith(`__${nameSuffix}`));
// Each scenario uses a UNIQUE goal so its slug (via slugifyGoal in
// mcp-server/src/tools/shared.ts) doesn't collide with other scenarios'
// Agent Mail reservations on docs/brainstorms/<slug>-<date>.md.
// Each scenario's fixture pre-writes that brainstorm so Phase 0.5 skips
// and the orchestrator jumps straight to Step 5 Plan-mode + Ambition.
export const SCENARIOS = [
    {
        id: "s1-step0d-and-step5",
        description: "After the Phase 0.5 brainstorm skip, Step 5 fires a Plan-mode (4 options) + Ambition (2 options) AskUserQuestion.",
        goal: "/agent-flywheel:start redesign flywheel_doctor to emit a versioned structured JSON envelope per check with timing, cross-check correlation IDs, backward-compatible shim for every current consumer, migration tests for all 23 checks, AGENTS.md quick-reference updates with versioned examples, and a deprecation plan for the current text output",
        scripted: [
            { headerContains: "plan mode", option: "Standard plan" },
            { headerContains: "ambition", option: "As scoped" },
            { headerContains: "plan review", option: "Stop here" },
            { headerContains: "plan gate", option: "Stop here" },
            { headerContains: "plan ready", option: "Stop here" },
            { headerContains: "scope", option: "Scope is right" },
            { headerContains: "approach", option: "Agree" },
            { headerContains: "framing", option: "Light framing" },
            { headerContains: "pre-flight", option: "Continue" },
            { headerContains: "setup fixes", option: "Continue" },
            { headerContains: "goal input", option: "Yes, full flywheel" },
            { headerContains: "goal", option: "Yes, full flywheel" },
        ],
        assert: (facts) => {
            const violations = [];
            const planAsks = asksByHeader(facts, "plan mode");
            if (planAsks.length === 0) {
                violations.push("Step 5 Plan-mode AskUserQuestion not observed. The _planning.md skill guarantees this question fires after Phase 0.5 (brainstorm) is complete; investigate skill drift.");
            }
            else {
                const q = questionWithHeader(planAsks[0], "plan mode");
                const opts = q?.["options"] || [];
                if (opts.length !== 4) {
                    violations.push(`Step 5 Plan-mode question has ${opts.length} options, expected 4 (Standard / Deep / Duel / Direct to beads).`);
                }
            }
            const ambAsks = asksByHeader(facts, "ambition");
            if (ambAsks.length === 0) {
                violations.push("Step 5 Ambition AskUserQuestion not observed. _planning.md calls for Plan mode + Ambition as a two-question Step 5 ask.");
            }
            else {
                const q = questionWithHeader(ambAsks[0], "ambition");
                const opts = q?.["options"] || [];
                if (opts.length !== 2) {
                    violations.push(`Step 5 Ambition question has ${opts.length} options, expected 2 (As scoped / Ambitious).`);
                }
            }
            return violations;
        },
        maxTurns: 30,
    },
    {
        id: "s2-standard-no-early-br-create",
        description: "Standard plan path reaches the plan-ready/plan-gate menu and runs no `br create` before the user picks Create beads.",
        goal: "/agent-flywheel:start build a cross-cutting cache layer for flywheel_profile with TTL + git-write-hook invalidation, benchmark harness against the current baseline, documented staleness window per profile field, new MCP tool exposing cache metrics, migration guide for existing callers, and regression tests across the full doctor sweep",
        scripted: [
            { headerContains: "plan mode", option: "Standard plan" },
            { headerContains: "ambition", option: "As scoped" },
            // At whichever label the orchestrator renders the plan-gate as
            // (Plan ready / Plan gate / Plan review), pick a non-Create-beads
            // option so the "no br create before Create beads" invariant can
            // be tested.
            { headerContains: "plan review", option: "Stop here" },
            { headerContains: "plan gate", option: "Stop here" },
            { headerContains: "plan ready", option: "Stop here" },
            { headerContains: "framing", option: "Light framing" },
            { headerContains: "pre-flight", option: "Continue" },
            { headerContains: "setup fixes", option: "Continue" },
            { headerContains: "goal input", option: "Yes, full flywheel" },
            { headerContains: "goal", option: "Yes, full flywheel" },
        ],
        assert: (facts) => {
            const violations = [];
            const planGate = asksByHeader(facts, "plan review")[0] ??
                asksByHeader(facts, "plan gate")[0] ??
                asksByHeader(facts, "plan ready")[0];
            const anchorTurn = planGate?.turn ?? Number.POSITIVE_INFINITY;
            const early = brCreateBeforeTurn(facts, anchorTurn);
            if (early.length > 0) {
                violations.push(`${early.length} \`br create\` call(s) fired before plan-gate menu (turns ${early
                    .map((t) => t.turn)
                    .join(", ")})`);
            }
            if (!planGate) {
                violations.push("Plan-gate / plan-ready AskUserQuestion not observed (standard path did not reach the gate within turn budget).");
            }
            return violations;
        },
        maxTurns: 60,
    },
    {
        id: "s3-ambitious-writes-charter-first",
        description: "Ambitious path writes docs/brainstorms/<slug>-<date>-ambition.md before calling flywheel_plan with ambition='ambitious'.",
        goal: "/agent-flywheel:start redesign the compliance-audit pipeline so every closed bead has a validated attestation with retry on transient failures, deferred remediation beads, telemetry hooks, a migration guide for existing beads, dashboarding for the compliance score across waves, and documentation of the full lifecycle in AGENTS.md",
        scripted: [
            { headerContains: "plan mode", option: "Standard plan" },
            { headerContains: "ambition", option: "Ambitious" },
            { headerContains: "plan review", option: "Stop here" },
            { headerContains: "plan gate", option: "Stop here" },
            { headerContains: "plan ready", option: "Stop here" },
            { headerContains: "framing", option: "Light framing" },
            { headerContains: "pre-flight", option: "Continue" },
            { headerContains: "setup fixes", option: "Continue" },
            { headerContains: "goal input", option: "Yes, full flywheel" },
            { headerContains: "goal", option: "Yes, full flywheel" },
        ],
        assert: (facts) => {
            const violations = [];
            const planCall = facts.toolUses.find((t) => {
                const isPlan = t.tool_name === "flywheel_plan" ||
                    t.tool_name.endsWith("__flywheel_plan");
                if (!isPlan)
                    return false;
                return String(t.input["ambition"] ?? "").toLowerCase() === "ambitious";
            });
            if (!planCall) {
                violations.push("flywheel_plan with ambition='ambitious' not observed on ambitious path.");
                return violations;
            }
            const charterWrite = facts.toolUses.find((t) => t.turn < planCall.turn &&
                (t.tool_name === "Write" || t.tool_name === "Edit") &&
                typeof t.input["file_path"] === "string" &&
                /docs\/brainstorms\/.+-ambition\.md$/.test(t.input["file_path"]));
            if (!charterWrite) {
                violations.push("Ambition charter write under docs/brainstorms/<slug>-<date>-ambition.md not observed before flywheel_plan.");
            }
            return violations;
        },
        maxTurns: 70,
    },
    {
        id: "s4-rubric-gate-before-bead-creation",
        description: "Choosing Create beads triggers the Step 5.6.5 rubric gate (flywheel_synthesize_rubric) before any bead creation.",
        goal: "/agent-flywheel:start consolidate the three NTM readiness bash gates across skills/start into one doctor remediation with ownership story, state machine documentation, migration path for existing checkpoints, UX for the recovery flow, telemetry on each state transition, and a comprehensive regression test suite covering every transition",
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
            const violations = [];
            const rubricCall = findFlywheelTool(facts, "flywheel_synthesize_rubric");
            if (!rubricCall) {
                violations.push("flywheel_synthesize_rubric not observed after picking Create beads.");
                return violations;
            }
            const earlyBr = brCreateBeforeTurn(facts, rubricCall.turn);
            if (earlyBr.length > 0) {
                violations.push(`${earlyBr.length} \`br create\` call(s) fired before Step 5.6.5 rubric gate.`);
            }
            return violations;
        },
        maxTurns: 90,
    },
];
//# sourceMappingURL=scenarios.js.map