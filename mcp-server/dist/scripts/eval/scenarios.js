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
export const SCENARIOS = [
    {
        id: "s1-step0d-and-step5",
        description: "After the Phase 0.5 brainstorm skip, Step 5 fires a Plan-mode (4 options) + Ambition (2 options) AskUserQuestion.",
        goal: "/agent-flywheel:start design the `flywheel_echo` observability subsystem — add a new MCP tool that returns a prefixed message plus structured telemetry per call, a shared Zod schema registry used by every existing tool handler, a conformance test suite covering every schema, AGENTS.md documentation of the registry pattern, a migration guide for third-party plugin authors, and a dashboard view exposing per-tool telemetry trends",
        scripted: [
            { headerContains: "plan mode", option: "Standard plan" },
            { headerContains: "ambition", option: "As scoped" },
            { headerContains: "plan ready", option: "Create beads" },
            { headerContains: "rubric", option: "Abort" },
            ...COMMON_SCRIPTED,
        ],
        assert: (facts) => {
            const violations = [];
            const planAsks = asksByHeader(facts, "plan mode");
            if (planAsks.length === 0) {
                violations.push("Step 5 Plan-mode AskUserQuestion not observed; investigate skill drift.");
            }
            else {
                const q = questionWithHeader(planAsks[0], "plan mode");
                const opts = q?.["options"] || [];
                if (opts.length !== 4) {
                    violations.push(`Step 5 Plan-mode question has ${opts.length} options, expected 4.`);
                }
            }
            const ambAsks = asksByHeader(facts, "ambition");
            if (ambAsks.length === 0) {
                violations.push("Step 5 Ambition AskUserQuestion not observed.");
            }
            else {
                const q = questionWithHeader(ambAsks[0], "ambition");
                const opts = q?.["options"] || [];
                if (opts.length !== 2) {
                    violations.push(`Step 5 Ambition question has ${opts.length} options, expected 2.`);
                }
            }
            return violations;
        },
        maxTurns: 40,
    },
    {
        id: "s2-standard-no-early-br-create",
        description: "Standard plan path reaches the plan-ready/plan-gate menu and runs no `br create` before the user picks Create beads.",
        goal: "/agent-flywheel:start build the `flywheel_ping` caching subsystem — a new MCP tool returning cache-stats, a TTL-driven cache layer wrapping every read-heavy tool handler, a benchmark harness proving a measurable latency improvement, documentation of per-field staleness windows in AGENTS.md, a migration guide for callers that depended on uncached reads, telemetry hooks, and regression tests across the full doctor sweep",
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
            const violations = [];
            const planGate = asksByHeader(facts, "plan ready")[0];
            const anchorTurn = planGate?.turn ?? Number.POSITIVE_INFINITY;
            const early = brCreateBeforeTurn(facts, anchorTurn);
            if (early.length > 0) {
                violations.push(`${early.length} \`br create\` call(s) fired before Plan-ready menu (turns ${early
                    .map((t) => t.turn)
                    .join(", ")})`);
            }
            if (!planGate) {
                violations.push("Plan-ready AskUserQuestion not observed within turn budget.");
            }
            return violations;
        },
        maxTurns: 70,
    },
    {
        id: "s3-ambitious-writes-charter-first",
        description: "Ambitious path writes docs/brainstorms/<slug>-<date>-ambition.md before calling flywheel_plan with ambition='ambitious'.",
        goal: "/agent-flywheel:start redesign the compliance signal pipeline around a new `flywheel_lint_imports` MCP tool — a shared pattern-match engine, per-source-file config, structured violation output, a vitest conformance suite covering every pattern, telemetry hooks on each scan, a migration guide for the current scanner's consumers, dashboards for pattern-hit frequency, and AGENTS.md documentation of the rule-set contract",
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
        maxTurns: 80,
    },
    {
        id: "s4-rubric-gate-before-bead-creation",
        description: "Choosing Create beads triggers the Step 5.6.5 rubric gate (flywheel_synthesize_rubric) before any bead creation.",
        goal: "/agent-flywheel:start architect the `flywheel_hash_bead` fingerprinting subsystem — a new MCP tool returning a stable sha256 fingerprint of a bead, a shared hashing module reused by compliance-audit and verify-beads, telemetry on fingerprint computations, a migration guide for existing audit tooling, a conformance test suite proving determinism across inputs, documentation of the fingerprint schema in AGENTS.md, and a dashboard view exposing fingerprint-change frequency",
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
        maxTurns: 100,
    },
    // -------------------------------------------------------------------------
    // 4p7: cover start_implement, start_review, start_wrapup past bead approval
    // -------------------------------------------------------------------------
    {
        id: "s5-dispatch-server-prompts",
        description: "Standard path reaches bead-approval, picks Create beads + Skip rubric + Start implementing, and the server-built implementer prompts are returned by flywheel_approve_beads(action: 'start').",
        goal: "/agent-flywheel:start design a new `flywheel_whisper` observability subsystem — add a new MCP tool that emits structured breadcrumbs per call, a shared telemetry registry used by every existing tool handler, a conformance test suite covering every schema, AGENTS.md documentation of the registry pattern, a migration guide for third-party plugin authors, and a dashboard view exposing per-tool telemetry trends",
        scripted: [
            { headerContains: "plan mode", option: "Standard plan" },
            { headerContains: "ambition", option: "As scoped" },
            { headerContains: "plan ready", option: "Create beads" },
            // Picking "Skip rubric" lets flywheel_approve_beads(start) fire; the
            // Beads header follows. "Start implementing" is the dispatch step.
            { headerContains: "rubric", option: "Skip rubric" },
            { headerContains: "beads", option: "Start implementing" },
            // Terminate before the model spawns any real NTM pane. "Polish"
            // (as "Polish" / "Polish more" / "Polish (refine beads to remove
            // overlap)") is the one non-launching option present across every
            // Launch-menu shape the orchestrator renders.
            { headerContains: "launch", option: "Polish" },
            // The orchestrator sometimes asks a separate `Init beads` menu
            // when the eval worktree has no `.beads/` yet; let it run `br init`
            // so the dispatch path keeps going.
            { headerContains: "init beads", option: "Run br init" },
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
        assert: (facts) => {
            const violations = [];
            const startCall = facts.toolUses.find((t) => {
                const isApprove = t.tool_name === "flywheel_approve_beads" ||
                    t.tool_name.endsWith("__flywheel_approve_beads");
                if (!isApprove)
                    return false;
                return String(t.input["action"] ?? "").toLowerCase() === "start";
            });
            if (!startCall) {
                violations.push("flywheel_approve_beads(action: 'start') not observed; implementer-dispatch gate never fired.");
            }
            const brCreateBefore = facts.toolUses.filter((t) => t.turn < (startCall?.turn ?? Number.POSITIVE_INFINITY) &&
                t.tool_name === "Bash" &&
                typeof t.input["command"] === "string" &&
                /\bbr\s+create\b/.test(t.input["command"]));
            if (brCreateBefore.length === 0 && startCall) {
                violations.push("No `br create` observed before dispatch — the bead-creation step was skipped.");
            }
            const beadsAsk = asksByHeader(facts, "beads")[0];
            if (!beadsAsk) {
                violations.push("Beads header AskUserQuestion not observed; dispatch menu never surfaced.");
            }
            return violations;
        },
        maxTurns: 120,
    },
    {
        id: "s6-review-wrapup-outcome-gate",
        description: "At phase=wrapup with a tiny closed bead pre-seeded, /start routes to the wrap-up flow and the outcome-grading/verdict gate fires (either flywheel_grade_outcome runs or the rubric-skip path short-circuits).",
        goal: "/agent-flywheel:start wrap up the completed cycle, run the outcome grader, and record the verdict",
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
            await writeFile(join(worktree, ".pi-flywheel", "completion", `${stubBeadId}.json`), JSON.stringify(attestation, null, 2), "utf8");
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
            await writeFile(join(worktree, ".pi-flywheel", "checkpoint.json"), JSON.stringify(checkpoint, null, 2), "utf8");
        },
        assert: (facts) => {
            const violations = [];
            const reviewed = facts.toolUses.find((t) => t.tool_name === "flywheel_review" ||
                t.tool_name.endsWith("__flywheel_review"));
            const graded = facts.toolUses.find((t) => t.tool_name === "flywheel_grade_outcome" ||
                t.tool_name.endsWith("__flywheel_grade_outcome"));
            const rubricSkip = facts.toolUses.find((t) => (t.tool_name === "flywheel_synthesize_rubric" ||
                t.tool_name.endsWith("__flywheel_synthesize_rubric")) &&
                String(t.input["action"] ?? "").toLowerCase() === "skip");
            const verifyBeads = facts.toolUses.find((t) => t.tool_name === "flywheel_verify_beads" ||
                t.tool_name.endsWith("__flywheel_verify_beads"));
            if (!reviewed && !graded && !rubricSkip && !verifyBeads) {
                violations.push("neither flywheel_review nor flywheel_grade_outcome nor flywheel_synthesize_rubric(skip) nor flywheel_verify_beads observed; wrap-up/review phase never engaged");
            }
            // Any of these headers means a wrap-up / review skill menu fired.
            // The grader "Recover" menu is the one the skill asks when
            // `flywheel_grade_outcome` can't run (no rubric), which is itself
            // evidence that the wrap-up skill routed through outcome-grading.
            const wrapAsk = asksByHeader(facts, "verdict")[0] ??
                asksByHeader(facts, "grading")[0] ??
                asksByHeader(facts, "iterate")[0] ??
                asksByHeader(facts, "review mode")[0] ??
                asksByHeader(facts, "review")[0] ??
                asksByHeader(facts, "recover")[0] ??
                asksByHeader(facts, "wrap-up")[0] ??
                asksByHeader(facts, "post-mortem")[0];
            if (!wrapAsk) {
                violations.push("No review-mode / verdict-gate / recover / wrap-up / post-mortem AskUserQuestion observed; skill-text menu never fired at wrap-up.");
            }
            return violations;
        },
        maxTurns: 120,
    },
];
//# sourceMappingURL=scenarios.js.map