# Synthesized Plan: Add `structuredContent` contracts for all `flywheel_*` tools

Date: 2026-04-11
Scope: `flywheel_profile`, `flywheel_discover`, `flywheel_select`, `flywheel_plan`, `flywheel_approve_beads`, `flywheel_review`
Primary goal: introduce explicit, typed, machine-readable `structuredContent` contracts for every branch of the flywheel tools while preserving current human-readable `content` compatibility.

## Executive summary

The three source plans agree on the core move: make `structuredContent` a first-class, additive contract for all flywheel tools, not a prose replacement. The synthesized implementation should preserve readable terminal text while making workflow state, next actions, errors, and machine-oriented payloads available without text scraping.

This plan combines:
- the correctness plan’s branch-by-branch discipline, invariants, and lockstep state/output expectations
- the robustness plan’s staged rollout, compact payload strategy, structured error taxonomy, and payload-size awareness
- the ergonomics plan’s strong shared envelope, `nextStep` semantics, explicit choice/action modeling, and host/Hermes usability focus

Best-of-all-worlds recommendation:
1. Add a shared versioned flywheel result envelope and a generic `McpToolResult<TStructured>`.
2. Use discriminated unions per tool so every success and error branch is machine-distinguishable.
3. Keep `content` human-friendly and compatibility-safe; stop making it the sole carrier of machine-critical data.
4. Introduce shared builders in `mcp-server/src/tools/shared.ts` so text and structured output are authored together.
5. Roll out low-risk tools first to prove the pattern, but prioritize eliminating JSON-in-text anti-patterns in `flywheel_plan` and `flywheel_review` early within the implementation sequence.
6. Prefer compact structured payloads; include full task/config arrays only when automation truly needs them.
7. Add output schema metadata in `server.ts` if the SDK supports it, but treat runtime `structuredContent` as canonical and metadata as advisory until verified.
8. Expand tests so every important branch asserts text compatibility, structured contract correctness, and state/result coherence.

## What each source plan contributed uniquely

### Unique strengths from `2026-04-11-correctness.md`

The correctness plan contributed the strongest branch inventory and invariant thinking. It is especially valuable for:
- mapping the real branch surface of `flywheel_plan`, `flywheel_approve_beads`, and `flywheel_review`
- insisting that every branch have an explicit discriminant rather than a loose optional blob
- requiring state/output lockstep (`phaseAfter`, `planDocument`, `currentBeadId`, bead results)
- identifying correctness-sensitive edge cases like `_lastBeadSnapshot`, plan registration modes, gate completion logic, and regression sentinels
- pushing structured errors, not just structured success payloads

This synthesized plan keeps that rigor as the baseline.

### Unique strengths from `2026-04-11-robustness.md`

The robustness plan contributed the strongest rollout discipline and operational caution. It is especially valuable for:
- emphasizing additive compatibility instead of replacing text
- introducing contract versioning from day one
- highlighting payload-size, serialization, and host-compatibility risks
- recommending compact summaries instead of duplicating large prose payloads structurally
- proposing graceful degradation, observability, and advisory output-schema rollout
- stressing that partial adoption across tools is itself a fragility risk

This synthesized plan adopts those guardrails so the contract rollout is safe in practice, not just elegant on paper.

### Unique strengths from `2026-04-11-ergonomics.md`

The ergonomics plan contributed the strongest API design and host/agent usability model. It is especially valuable for:
- defining a consistent top-level envelope with `tool`, `version`, `status`, `phase`, `goal`, `nextStep`, and tool-specific `data`
- making `nextStep`, `workflowOptions`, `availableActions`, and renderable choices first-class instead of implied by prose headings
- focusing on Hermes/host consumption without prompt scraping
- separating “pleasant prose for humans” from “stable structure for machines” cleanly
- providing naming conventions that will reduce future schema drift

This synthesized plan uses those ergonomics conventions as the canonical public contract shape.

## Synthesis principles

1. Additive, not breaking
   - Keep `content` for existing conversational/terminal flows.
   - Add `structuredContent` everywhere relevant.
   - Do not rename tools or remove existing args.

2. One shared envelope, tool-specific `data`
   - Keep top-level semantics stable across all six tools.
   - Put branch-specific payloads under discriminated `data` unions.

3. Machines should never need to scrape prose for primary workflow state
   - Especially for next action, phase transition, selected goal, plan registration, gate state, agent tasks, and parallel launch configs.

4. Error branches are part of the contract
   - If `isError` is true, the result should also contain structured error information.

5. Compact by default, full-fidelity only where automation needs it
   - Include full arrays for agent tasks/configs.
   - Prefer summaries or references for bulky narrative context already present in text or files.

6. Text and structure must be authored from the same facts
   - Shared builders should minimize drift.

7. Prefer plan-file registration workflow
   - `planFile` remains the preferred registration path for larger plans.
   - Structured payloads should explicitly reflect whether a plan came from `planFile` or `planContent`.

## Architecture and contract design

### Shared result envelope

Add a shared envelope for all flywheel structured outputs.

Recommended shape:

```ts
export interface ToolNextStep {
  type:
    | "call_tool"
    | "present_choices"
    | "generate_artifact"
    | "spawn_agents"
    | "run_cli"
    | "resume_phase"
    | "none";
  message: string;
  tool?: "flywheel_profile" | "flywheel_discover" | "flywheel_select" | "flywheel_plan" | "flywheel_approve_beads" | "flywheel_review";
  argsSchemaHint?: Record<string, unknown>;
  options?: Array<{
    id: string;
    label: string;
    description?: string;
    tool?: string;
    args?: Record<string, unknown>;
  }>;
}

export interface OrchestrationContractBase {
  version: 1;
  tool: "flywheel_profile" | "flywheel_discover" | "flywheel_select" | "flywheel_plan" | "flywheel_approve_beads" | "flywheel_review";
  status: "ok" | "error";
  phase: OrchestratorPhase | "unknown";
  goal?: string;
  nextStep?: ToolNextStep;
}

export interface OrchestrationToolError {
  code:
    | "missing_prerequisite"
    | "invalid_input"
    | "not_found"
    | "cli_failure"
    | "parse_failure"
    | "blocked_state"
    | "unsupported_action"
    | "internal_error";
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export type McpToolResult<TStructured = Record<string, unknown>> = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: TStructured;
  isError?: boolean;
};
```

### Contract shape rules

1. Every flywheel `structuredContent` object must include:
   - `tool`
   - `version: 1`
   - `status`
   - `phase`
   - branch-specific `data`

2. Every branch-specific payload must have a stable discriminant.
   - Use `data.kind` consistently.
   - Avoid branch inference from optional fields.

3. Every error branch should return:
   - `status: "error"`
   - `data.kind: "error"`
   - `data.error` with stable `code`, `message`, and optional `retryable`/`details`

4. `nextStep` should be first-class whenever follow-up action is expected.

5. `content` remains human-optimized, not a mirror of the full structured payload.

### Contract placement

Recommended layout:
- Keep the generic `McpToolResult` and small shared primitives in `mcp-server/src/types.ts`.
- Move the larger flywheel contract families into a new `mcp-server/src/tool-contracts.ts` if `types.ts` becomes too dense.
- If repository style strongly prefers one file, keep them in `types.ts`, but avoid a giant unstructured section.

### Result builders

Use shared builders in `mcp-server/src/tools/shared.ts` rather than inventing a new helper file unless `shared.ts` becomes unwieldy.

Recommended helpers:

```ts
makeToolResult(text, structuredContent)
makeToolError(tool, phase, code, message, options?)
makeNextToolStep(...)
makeChoiceOption(...)
```

Key rule: both human text and structured payload should be derived from the same local variables.

## Per-tool structuredContent kinds and payloads

All examples below assume the common envelope and a tool-specific `data` object.

### 1. `flywheel_profile`

`data.kind` values:
- `profile_ready`
- `error`

Recommended payload for `profile_ready`:
- `fromCache: boolean`
- `selectedGoal?: string`
- `coordination: { backend: "beads" | "bare"; beadsAvailable: boolean }`
- `foundationGaps: string[]`
- `existingBeads?: { openCount: number; deferredCount: number }`
- `profileSummary: {
    name: string;
    languages: string[];
    frameworks: string[];
    hasTests: boolean;
    hasDocs: boolean;
    hasCI: boolean;
    testFramework?: string;
    ciPlatform?: string;
    entrypoints: string[];
    todoCount: number;
    recentCommitCount: number;
    keyFileNames: string[];
  }`
- optionally `scanSummary` / `scanSignals` if already compact and useful

Recommended `nextStep`:
- default: `call_tool -> flywheel_discover`
- if a goal was supplied and the product wants explicit choice UX: `present_choices` between discovery and direct goal selection flow

Payload-size note:
- Do not duplicate `RepoProfile.structure`, README text, or key file contents in structured output initially.

### 2. `flywheel_discover`

`data.kind` values:
- `ideas_registered`
- `error`

Recommended payload for `ideas_registered`:
- `counts: { total: number; top: number; honorable: number }`
- `ideas: Array<{
    id: string;
    title: string;
    category: IdeaCategory;
    effort: "low" | "medium" | "high";
    impact: "low" | "medium" | "high";
    tier: "top" | "honorable";
    rationale?: string;
    weightedScore?: number;
    sourceEvidence?: string[];
    risks?: string[];
    synergies?: string[];
  }>`
- `artifact?: { attempted: boolean; written: boolean; path?: string }`

Recommended `nextStep`:
- `present_choices` with one option per idea, each wiring to `flywheel_select`

Error codes to normalize:
- `missing_repo_profile`
- `missing_ideas`
- `invalid_ideas`

### 3. `flywheel_select`

`data.kind` values:
- `goal_selected`
- `error`

Recommended payload for `goal_selected`:
- `selectedGoal: string`
- `constraints: string[]`
- `workflowOptions: Array<{
    id: "plan-first" | "deep-plan" | "direct-to-beads";
    label: string;
    description: string;
    recommendedFor: string[];
    nextAction: {
      type: "call_tool" | "run_cli";
      tool?: "flywheel_plan" | "flywheel_approve_beads";
      args?: Record<string, unknown>;
    };
  }>`
- `beadCreationPrompt?: string`

Recommended `nextStep`:
- `present_choices` for the three workflow options

Error codes:
- `invalid_goal`

Ergonomic rule:
- Include structured workflow options and next actions, but keep the rich terminal prose menu intact.

### 4. `flywheel_plan`

`data.kind` values:
- `plan_prompt`
- `deep_plan_spawn`
- `plan_registered`
- `error`

Recommended payload for `plan_prompt`:
- `mode: "standard"`
- `goal: string`
- `constraints: string[]`
- `planDocument: string`
- `planRequirements: string[]`
- optional compact `repoContext`

Recommended `nextStep`:
- `generate_artifact` with preferred registration method `planFile`

Recommended payload for `deep_plan_spawn`:
- `mode: "deep"`
- `goal: string`
- `constraints: string[]`
- `planAgents: Array<{
    perspective: string;
    model?: string;
    subagent_type?: string;
    task: string;
  }>`
- `synthesisPrompt: string`
- `instructions: string`
- `registrationMethod: "planFile"`
- `outputPathTemplate?: string`

Recommended `nextStep`:
- `spawn_agents`

Recommended payload for `plan_registered`:
- `mode: "standard" | "deep"`
- `source: "planFile" | "planContent"`
- `goal: string`
- `planDocument: string`
- `stats: { chars: number; lines: number }`

Recommended `nextStep`:
- `call_tool -> flywheel_approve_beads`

Error codes:
- `missing_selected_goal`
- `plan_file_not_found`
- `invalid_plan_content`

Critical migration rule:
- Keep the current deep-plan JSON text block for one compatibility cycle if needed, but make `structuredContent.data.planAgents` and related fields canonical immediately.

### 5. `flywheel_approve_beads`

This tool should carry a second discriminator because it has two distinct review domains.

Recommended top-level fields within `data`:
- `approvalTarget: "plan" | "beads"`
- `kind: ...`

Plan-approval `kind` values:
- `plan_review`
- `plan_refinement_request`
- `plan_git_diff_review_request`
- `plan_approved`
- `plan_rejected`
- `error`

Recommended plan-approval payload fields:
- `goal: string`
- `planDocument: string`
- `planRefinementRound?: number`
- `planStats?: { lines: number; sizeAssessment: "too_short" | "short" | "substantial" }`
- `availableActions: Array<"start" | "polish" | "reject" | "git-diff-review">`
- `instructions?: string`

Bead-approval `kind` values:
- `bead_review`
- `bead_refinement_request`
- `advanced_refinement_request`
- `implementation_ready`
- `implementation_blocked_no_ready_beads`
- `no_open_beads`
- `beads_rejected`
- `error`

Recommended bead-approval payload fields:
- `selectedGoal: string`
- `activeBeadIds: string[]`
- `beadSummary: { totalOpen: number; readyCount?: number }`
- `polishRound?: number`
- `polishChanges?: number[]`
- `convergenceScore?: number`
- `polishConverged?: boolean`
- `beadQuality?: { score: number; label: string; weakBeads: string[] }`
- `availableActions: Array<"start" | "polish" | "reject" | "advanced">`
- `advancedActions?: string[]`
- `readyBeads?: Array<{ id: string; title: string; descriptionPreview: string }>`
- `launchMode?: "single" | "parallel"`
- `currentBeadId?: string`
- `agentConfigs?: Array<{ name: string; cwd: string; task: string }>`
- `instructions?: string`

Recommended `nextStep`:
- review menus: `present_choices`
- single start: `resume_phase`
- parallel start: `spawn_agents`
- blocked state: `present_choices` or `none` with diagnosis guidance

Error codes to normalize:
- `missing_selected_goal`
- `missing_plan_document`
- `br_list_failed`
- `br_list_parse_failed`
- `br_ready_failed`
- `invalid_advanced_action`
- `unsupported_action`

Payload-size rule:
- Use previews/summaries for bead descriptions in review menus.
- Include full parallel `agentConfigs` when machine execution depends on them.

### 6. `flywheel_review`

`data.kind` values:
- `review_agents_requested`
- `bead_progress`
- `parallel_next_beads`
- `review_gate`
- `gate_passed`
- `flywheel_complete`
- `phase_regression`
- `already_complete`
- `error`

Recommended payload for `review_agents_requested`:
- `beadId: string`
- `beadTitle?: string`
- `round: number`
- `files?: string[]`
- `agentTasks: Array<{ name: string; perspective: string; task: string }>`

Recommended payload for `bead_progress`:
- `beadId: string`
- `status: "passed" | "skipped" | "already_complete"`
- `nextMode: "gates" | "single" | "parallel" | "none"`
- `currentBeadId?: string`
- `nextReadyBeads?: Array<{ id: string; title: string; descriptionPreview: string }>`
- `agentConfigs?: Array<{ name: string; cwd: string; task: string }>`

Recommended payload for `review_gate` / `gate_passed`:
- `gateIndex: number`
- `gateLabel?: string`
- `round: number`
- `consecutiveCleanRounds: number`
- `completionThreshold: number`
- `instructions`

Recommended payload for `phase_regression`:
- `targetPhase: "planning" | "creating_beads" | "implementing"`
- `reasonLabel?: string`
- `instructions?: string`

Recommended `nextStep`:
- hit-me: `spawn_agents`
- next single bead: `resume_phase`
- parallel next beads: `spawn_agents`
- gate prompt: `call_tool` with sentinel guidance
- regression: `resume_phase`

Error codes:
- `missing_bead_id`
- `bead_not_found`
- `br_show_failed`
- `br_show_parse_failed`
- `unknown_action`

Critical migration rule:
- `hit-me` and parallel-next-beads must stop requiring `JSON.parse(result.content[0].text)` for machine consumers.

## Shared type changes

### Required changes

1. Expand `McpToolResult` in `mcp-server/src/types.ts`
   - add generic `structuredContent?`

2. Add shared flywheel primitives
   - `ToolNextStep`
   - `OrchestrationContractBase`
   - `OrchestrationToolError`
   - possibly `OrchestrationStructuredContent` union

3. Add per-tool structured contract types
   - either in `types.ts` or `tool-contracts.ts`

4. Consider a small `ToolName` union and shared `ChoiceOption` helper type for consistency.

### Invariants to encode in types/tests

1. If `isError === true`, then `structuredContent.status === "error"`.
2. Every `structuredContent` result must include `tool`, `version`, `status`, `phase`, and `data.kind`.
3. `phase` in structured output must reflect the actual persisted phase after the tool runs.
4. `nextStep` must agree with the actual expected follow-up action.
5. Branches that previously emitted machine JSON in text must expose semantically equivalent native arrays/objects under `structuredContent`.
6. No success branch should require prose parsing to discover primary workflow state.

## Server and tool implementation phases

### Phase 0: contract map and naming freeze

Goals:
- finalize envelope shape
- finalize per-tool `data.kind` taxonomies
- decide exact file placement for contract types

Deliverables:
- written contract map in code comments/types
- explicit compatibility rule: prose retained, `structuredContent` additive

### Phase 1: shared types and builders

Files:
- `mcp-server/src/types.ts`
- optionally `mcp-server/src/tool-contracts.ts`
- `mcp-server/src/tools/shared.ts`

Changes:
- add generic `McpToolResult<TStructured>`
- add shared contract primitives
- add builders for success/error/next-step payloads

Exit criteria:
- one simple flywheel tool can return `structuredContent` through the full server boundary unchanged

### Phase 2: low-risk workflow tools

Recommended order:
1. `flywheel_select`
2. `flywheel_discover`
3. `flywheel_profile`

Why:
- simpler flows
- easy place to prove shared envelope and `nextStep`
- low payload risk

Exit criteria:
- stable `nextStep` contracts
- text unchanged or only compatibility-safe edits
- structured success and error branches covered

### Phase 3: eliminate JSON-in-text dependence in highest-value flows

Files:
- `mcp-server/src/tools/plan.ts`
- `mcp-server/src/tools/review.ts`

Why these next:
- they currently have the worst machine-consumption ergonomics
- they already expose implicit contracts in stringified JSON

Exit criteria:
- `flywheel_plan` deep mode and `flywheel_review` hit-me can be consumed entirely from `structuredContent`
- compatibility JSON text may remain temporarily, but is no longer primary

### Phase 4: structure the complex approval flow

Files:
- `mcp-server/src/tools/approve.ts`

Goals:
- encode plan approval vs bead approval explicitly
- expose convergence, quality, readiness, advanced actions, and launch modes structurally
- keep payloads compact where possible

Exit criteria:
- major plan and bead review branches have stable discriminants
- start/polish/reject/advanced flows are machine-distinguishable

### Phase 5: server metadata and validation-path improvements

Files:
- `mcp-server/src/server.ts`

Changes:
- pass through `structuredContent` unchanged
- optionally make validation failures structured too
- attach output schema metadata if SDK typing/runtime support is confirmed
- if lightweight and already aligned with project practice, optionally add debug logging for result kind / payload size / structured presence

Exit criteria:
- runtime contracts work regardless of metadata support
- metadata does not claim fields branches do not actually return

### Phase 6: hardening and cleanup

Goals:
- expand tests to full branch coverage
- decide whether text-embedded JSON should remain for one release or more
- document any payload compaction or degradation behavior if introduced

## File-level changes

### `mcp-server/src/types.ts`
- expand `McpToolResult`
- add shared result/error/next-step primitives
- add or re-export flywheel structured contract families

### `mcp-server/src/tool-contracts.ts` (recommended if needed)
- hold per-tool contract unions and shared flywheel contract helpers if `types.ts` becomes too crowded

### `mcp-server/src/tools/shared.ts`
- add result-builder helpers
- add next-step/choice helper constructors if useful
- keep helper usage centralized across all six tools

### `mcp-server/src/server.ts`
- ensure request handlers and validation paths preserve `structuredContent`
- optionally add advisory output schema metadata for the six tools
- optionally return structured validation errors for malformed inputs

### `mcp-server/src/tools/profile.ts`
- wrap existing success output with `profile_ready` contract
- add structured error handling where applicable

### `mcp-server/src/tools/discover.ts`
- wrap success path with `ideas_registered`
- add structured prerequisite/input errors
- surface artifact write status structurally

### `mcp-server/src/tools/select.ts`
- wrap success path with `goal_selected`
- expose workflow options and next actions structurally
- add `invalid_goal` structured error

### `mcp-server/src/tools/plan.ts`
- split structured output into `plan_prompt`, `deep_plan_spawn`, `plan_registered`, `error`
- keep `planFile` as the preferred workflow path
- preserve deep-plan text compatibility if necessary

### `mcp-server/src/tools/approve.ts`
- add `approvalTarget` plus discriminated plan/bead branch families
- expose quality/convergence/readiness/launch data structurally
- normalize CLI-related errors

### `mcp-server/src/tools/review.ts`
- add structured branches for hit-me, bead progression, gates, completion, and regression sentinels
- expose agent tasks/configs as native arrays/objects

### `mcp-server/src/__tests__/tools/profile.test.ts`
- assert envelope and `profile_ready` payload
- keep current text assertions

### `mcp-server/src/__tests__/tools/discover.test.ts`
- assert counts, ideas, choice options, and structured errors

### `mcp-server/src/__tests__/tools/select.test.ts`
- assert selected goal, constraints, workflow options, and next-step menu

### `mcp-server/src/__tests__/tools/plan.test.ts`
- assert `plan_prompt`, `deep_plan_spawn`, and `plan_registered`
- stop requiring text JSON parsing as primary validation
- assert `planFile` and `planContent` registration payloads distinctly

### `mcp-server/src/__tests__/tools/approve.test.ts`
- assert plan vs bead approval branches
- assert quality/convergence/ready beads/current bead/parallel configs/errors

### `mcp-server/src/__tests__/tools/review.test.ts`
- assert hit-me agent tasks, next-bead transitions, gates, completion, and regression payloads

### Optional new test: `mcp-server/src/__tests__/tools/contracts.test.ts`
- focused shape/invariant tests for shared contract semantics

## Test strategy

### 1. Preserve current text assertions

Do not throw away existing text-based expectations. They are the best compatibility safety net.

### 2. Add structured-content assertions to each existing tool test suite

Each representative branch should assert:
- `structuredContent` exists
- `tool`, `version`, `status`, `phase`, `data.kind`
- branch-specific fields
- `nextStep` when follow-up is expected

### 3. Add state/result lockstep tests

High-value assertions:
- structured `phase` equals persisted `state.phase`
- structured `planDocument` equals persisted plan document path/content reference when relevant
- structured `currentBeadId` matches state when relevant
- structured bead outcome mirrors `state.beadResults[beadId]` when relevant

### 4. Add semantic equivalence tests for former JSON-in-text branches

For:
- `flywheel_plan` deep mode
- `flywheel_review` hit-me
- `flywheel_approve_beads` parallel launch
- `flywheel_review` parallel next-beads

Assert that all machine-critical data is available from `structuredContent` alone, and that any retained text JSON blocks are semantically aligned.

### 5. Add structured error tests

Cover at least:
- `flywheel_discover` without profile / without usable ideas
- `flywheel_select` invalid goal
- `flywheel_plan` without selected goal / missing plan file
- `flywheel_approve_beads` missing goal / CLI failures / invalid advanced action
- `flywheel_review` missing bead / parse failures / unknown action

### 6. Add payload-size checks for representative large branches

Measure approximate JSON size for:
- `flywheel_plan` deep mode
- `flywheel_review` hit-me
- `flywheel_approve_beads` parallel implementation

The goal is not arbitrary micro-optimization, but early detection of accidental payload blow-up.

### 7. Add server pass-through coverage

If practical, verify that `CallToolRequestSchema` responses preserve `structuredContent` and structured validation errors through the server boundary.

## Migration and backward compatibility

### Compatibility policy

Phase-1 rollout is additive only:
- preserve `content`
- add `structuredContent`
- preserve current tool names and inputs
- preserve key human phrases where tests or downstream behavior may rely on them

### JSON-in-text deprecation policy

For at least one compatibility cycle:
- keep existing JSON-in-text blocks where current clients may already parse them
- make `structuredContent` canonical immediately
- after downstream audit and test confidence, optionally reduce redundant text JSON while keeping readable prose

### Preferred plan registration path

Maintain the existing preference for `planFile` over `planContent` for large plans. Structured payloads should reinforce this by:
- clearly marking `source: "planFile" | "planContent"`
- setting `nextStep` and instructions to prefer file-based registration workflows

### Metadata rollout

If `outputSchema` is supported by the installed MCP SDK typing/runtime, attach it. If not, do not block runtime structured output on metadata support.

## Acceptance criteria

1. All six target `flywheel_*` tools return `structuredContent` on all major success branches.
2. All explicit error branches return structured errors in addition to `isError: true`.
3. Every structured result uses the shared envelope with `tool`, `version`, `status`, `phase`, and `data.kind`.
4. `flywheel_plan` deep mode and `flywheel_review` hit-me no longer require text scraping for machine consumers.
5. `flywheel_approve_beads` and `flywheel_review` complex branch families are machine-distinguishable without prose inspection.
6. `nextStep` is populated for every branch that expects a follow-up action.
7. Existing human-readable `content` remains present and compatibility-safe.
8. Payload-size-sensitive branches are intentionally compact or explicitly measured and guarded.
9. If output schema metadata is published, it faithfully matches the runtime contract.
10. Relevant tool tests verify text compatibility, structured contract correctness, and state/result coherence.

## Risks and mitigations

### Risk 1: text and structured output drift apart
Mitigation:
- use shared builders
- derive both surfaces from the same variables
- add semantic consistency tests

### Risk 2: weak unions in high-branch tools
Mitigation:
- require `data.kind` discriminants everywhere
- split `flywheel_approve_beads` by `approvalTarget`
- cover representative branches explicitly in tests

### Risk 3: payload-size blow-up
Mitigation:
- keep structured payloads compact
- avoid duplicating large prose bodies or repo trees
- include paths/references instead of giant repeated blobs
- measure large branches in tests

### Risk 4: host compatibility regression
Mitigation:
- additive rollout only
- preserve `content`
- keep JSON-in-text compatibility temporarily where needed
- add a server-level pass-through test

### Risk 5: error-path neglect
Mitigation:
- define structured error contract up front
- require error coverage in every tool test suite

### Risk 6: metadata/runtime mismatch
Mitigation:
- treat output schemas as advisory until verified
- do not declare fields as required unless every branch supplies them

### Risk 7: hidden state in approval/refinement flows
Mitigation:
- structure outputs around resulting persisted state, not implicit module history
- keep tests isolated for `_lastBeadSnapshot`-sensitive flows

### Risk 8: schema sprawl or naming drift
Mitigation:
- use one shared envelope
- standardize on `data.kind`, `nextStep`, `workflowOptions`, `availableActions`, and `stats`
- centralize types and builders

## Recommended implementation order

Best synthesis order:
1. `mcp-server/src/types.ts`
2. `mcp-server/src/tool-contracts.ts` if needed
3. `mcp-server/src/tools/shared.ts`
4. `mcp-server/src/tools/select.ts`
5. `mcp-server/src/tools/discover.ts`
6. `mcp-server/src/tools/profile.ts`
7. `mcp-server/src/tools/plan.ts`
8. `mcp-server/src/tools/review.ts`
9. `mcp-server/src/tools/approve.ts`
10. `mcp-server/src/server.ts`
11. `mcp-server/src/__tests__/tools/*.test.ts`
12. optional focused contract/pass-through tests

Rationale:
- shared foundations first
- simple tools prove the pattern safely
- JSON-in-text hotspots get addressed early enough to deliver immediate value
- `approve.ts` comes after helpers and prior contracts are stable because it has the largest branch surface
- metadata lands after runtime contract behavior is proven

## Definition of done

The rollout is done when a machine consumer can call any of the six flywheel tools and, from `structuredContent` alone, reliably determine:
- what happened
- whether it succeeded
- what phase the workflow is now in
- what artifact, goal, bead, or plan is active
- what exact next action is expected
- what agent tasks/configs to execute when automation is required

while a human still sees high-quality terminal-friendly prose in `content`.
