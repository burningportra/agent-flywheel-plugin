# Robustness Plan: Structured `structuredContent` Contracts for `orch_*` Tools

Date: 2026-04-11
Perspective: Robustness
Scope: `orch_profile`, `orch_discover`, `orch_select`, `orch_plan`, `orch_approve_beads`, `orch_review`
Code inspected: `mcp-server/src/server.ts`, `mcp-server/src/tools/{profile,discover,select,plan,approve,review,shared}.ts`, `mcp-server/src/types.ts`, `mcp-server/src/__tests__/tools/*`

---

## Executive Summary

The current MCP server returns only text content from the orchestration tools. Several tools already embed machine-readable JSON inside text blobs (`orch_plan` deep mode, `orch_review` hit-me mode, parallel next-bead flows), but the contract is implicit, inconsistent, and fragile for hosts that want to consume tool output programmatically.

The safest rollout is not "replace text with JSON". It is:

1. Introduce typed result contracts in `mcp-server/src/types.ts` for each `orch_*` tool.
2. Add a small result-builder layer that returns both:
   - `content: [{ type: "text", text: ... }]` for current host compatibility
   - `structuredContent: ...` for machine-readable consumers
3. Keep current human text stable in phase 1, especially instructional text and the JSON-in-text blocks that existing hosts may currently parse.
4. Add server-level tool metadata for output contracts where the SDK/host path supports it, but do not make runtime correctness depend on that metadata being honored.
5. Add exhaustive tests for success, error, degradation, and payload-size-sensitive paths.

From a robustness lens, the main risks are host compatibility regressions, oversized structured payloads, duplicated text+JSON drift, and partial adoption where some tools return structured data and others do not. The plan below contains a staged rollout that preserves current behavior first, then tightens contracts once telemetry and tests prove compatibility.

---

## Current-State Findings

### 1. Tool results are text-only today

`mcp-server/src/types.ts` defines:

```ts
export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};
```

This shape has no `structuredContent`, no result discriminant, and no per-tool output typing.

### 2. Server dispatch passes tool output through unchanged

`mcp-server/src/server.ts` dispatches each tool and returns the tool result directly. That means structured output support can be added mostly at the tool/type layer without changing orchestration semantics, but `server.ts` will likely need metadata and/or stronger typing updates.

### 3. Some tools already carry implicit machine-readable payloads inside text

This is the strongest evidence that structured contracts are overdue:

- `orch_plan` deep mode returns `JSON.stringify({ action: 'spawn-plan-agents', ... }, null, 2)` as text.
- `orch_review` hit-me returns `JSON.stringify({ action: 'spawn-agents', ... }, null, 2)` as text.
- `orch_approve_beads` returns JSON agent configs inside fenced code blocks for parallel implementation.
- `orch_review` next-bead parallel branch returns JSON agent configs inside fenced code blocks.

These are already de facto contracts, but they are fragile because consumers must scrape text.

### 4. Tests are text-centric today

The existing tests under `mcp-server/src/__tests__/tools` mainly assert on:

- state transitions
- `isError`
- presence of specific phrases in `content[0].text`
- ad hoc `JSON.parse(result.content[0].text)` for `orch_plan` deep mode and `orch_review` hit-me mode

This means the current suite will not prevent drift between text and future `structuredContent` unless new dual-surface assertions are added.

### 5. Output sizes vary substantially by tool

Robustness-sensitive cases:

- `orch_profile` can include large formatted repo summaries.
- `orch_discover` can include 3-15 ideas plus rationale/scores.
- `orch_plan` deep mode can emit multiple large prompts and synthesis instructions.
- `orch_approve_beads` and `orch_review` can emit many agent task specs.

Structured payloads must therefore be intentionally compact and should avoid duplicating large freeform text where not required.

---

## Design Goals

1. Preserve existing text compatibility for current clients.
2. Expose stable machine-readable contracts for all six target tools.
3. Keep contracts compact, versioned, and easy to validate in tests.
4. Make error handling structured too, not just success paths.
5. Avoid forcing all hosts to understand output schemas on day 1.
6. Prevent drift between text and structured output with shared builders.
7. Gracefully degrade when structured output is unsupported or too large.

Non-goals for the first rollout:

- Rewriting orchestration flow logic
- Removing existing human-readable instructions
- Changing `orch_memory`
- Introducing a heavyweight schema library if simple TS + plain JSON contracts are enough

---

## Proposed Architecture

### A. Introduce a versioned orchestration result envelope

Add a small family of output contracts in `mcp-server/src/types.ts`.

Recommended pattern:

```ts
export interface McpTextContentBlock {
  type: 'text';
  text: string;
}

export interface OrchestrationContractBase {
  contractVersion: 1;
  tool: 'orch_profile' | 'orch_discover' | 'orch_select' | 'orch_plan' | 'orch_approve_beads' | 'orch_review';
  kind: string;
}

export interface McpToolResult<TStructured = unknown> {
  content: McpTextContentBlock[];
  structuredContent?: TStructured;
  isError?: boolean;
}
```

Then define per-tool `structuredContent` types rather than one giant unionless blob.

Why this is robust:

- versioned from the start
- explicit tool ownership
- supports narrow tests
- can evolve additively

### B. Use shared result-builder helpers

Create a helper module, likely `mcp-server/src/tools/result.ts` or `mcp-server/src/tools/contracts.ts`, that centralizes:

- `textResult(text, structuredContent?)`
- `errorResult(text, structuredError?)`
- optional size guards / truncation helpers
- optional contract-version constants

This is important because otherwise every tool will manually compose `content`, `structuredContent`, and `isError`, which creates drift and inconsistent error contracts.

### C. Keep text and structured surfaces intentionally different

The text surface should remain optimized for humans.
The structured surface should remain optimized for machines.

Do not mirror the entire text blob into structured content.
Instead, structured content should carry normalized fields such as:

- phase
- nextAction
- artifact paths
- counts
- selected IDs
- agent task arrays
- warnings
- diagnostics
- compact summaries

This reduces payload size, duplication, and synchronization bugs.

### D. Prefer stable enums and small discriminated unions

Each tool should emit a small `kind` enum representing its output variant. Example for `orch_plan`:

- `plan_prompt`
- `deep_plan_spawn`
- `plan_registered`
- `error`

This is more robust than asking consumers to infer meaning from optional fields.

### E. Add optional server-level output schema metadata

If the SDK path and host behavior allow it, extend `TOOLS` metadata in `mcp-server/src/server.ts` with explicit output schemas or descriptive contract notes. However, runtime compatibility must not depend on hosts understanding these declarations.

Phase 1 rule: runtime `structuredContent` is the source of truth; metadata is advisory.

---

## Proposed Structured Contracts by Tool

### 1. `orch_profile`

Current behavior:
- updates state
- returns workflow roadmap, coordination mode, gap warnings, bead status, formatted repo profile

Proposed contract:

```ts
interface OrchProfileStructuredContent extends OrchestrationContractBase {
  tool: 'orch_profile';
  kind: 'profile_ready' | 'error';
  phase: 'discovering';
  fromCache?: boolean;
  selectedGoal?: string;
  coordination: {
    backend: 'beads' | 'bare';
    beadsAvailable: boolean;
  };
  foundationGaps: string[];
  existingBeads?: {
    openCount: number;
    deferredCount: number;
  };
  nextStep: {
    suggestedTool: 'orch_discover' | 'orch_select';
    reason: string;
  };
  profileSummary: {
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
  };
}
```

Robustness note:
- Do not include full `structure`, README, or key-file contents in structured content initially; that would bloat payloads.
- Keep the full rich profile only in text.

### 2. `orch_discover`

Current behavior:
- stores ideas
- writes temp artifact best-effort
- returns presentation text

Proposed contract:

```ts
interface OrchDiscoverStructuredContent extends OrchestrationContractBase {
  tool: 'orch_discover';
  kind: 'ideas_registered' | 'error';
  phase: 'awaiting_selection';
  counts: {
    total: number;
    top: number;
    honorable: number;
  };
  ideas: Array<{
    id: string;
    title: string;
    category: IdeaCategory;
    effort: 'low' | 'medium' | 'high';
    impact: 'low' | 'medium' | 'high';
    tier: 'top' | 'honorable';
    rationale?: string;
    weightedScore?: number;
  }>;
  nextStep: {
    suggestedTool: 'orch_select';
    reason: string;
  };
  artifact?: {
    attempted: boolean;
    written: boolean;
    path?: string;
  };
}
```

Robustness note:
- Include a compact idea list only; avoid duplicating full long descriptions if text already carries them.
- Capture best-effort artifact write status in structured form because silent best-effort failures are hard to diagnose today.

### 3. `orch_select`

Current behavior:
- sets `selectedGoal`
- transitions to planning
- returns three workflow options and bead creation instructions

Proposed contract:

```ts
interface OrchSelectStructuredContent extends OrchestrationContractBase {
  tool: 'orch_select';
  kind: 'goal_selected' | 'error';
  phase: 'planning';
  goal: string;
  constraints: string[];
  workflowOptions: Array<{
    id: 'plan-first' | 'deep-plan' | 'direct-to-beads';
    label: string;
    recommendedFor: string;
    nextTool?: 'orch_plan' | 'orch_approve_beads';
  }>;
  nextStep: {
    suggestedUserDecision: 'choose_workflow';
  };
}
```

Robustness note:
- Do not put the large bead creation prompt into structured content; provide canonical option metadata only.

### 4. `orch_plan`

Current behavior has three major success modes plus errors:
- standard prompt mode
- deep spawn config mode
- plan registration via `planFile` or `planContent`

Proposed discriminated contract:

```ts
interface OrchPlanPromptStructuredContent extends OrchestrationContractBase {
  tool: 'orch_plan';
  kind: 'plan_prompt';
  phase: 'planning';
  mode: 'standard';
  goal: string;
  constraints: string[];
  planDocument: string;
  nextStep: {
    suggestedAction: 'write_plan_file';
    followupTool: 'orch_approve_beads';
  };
}

interface OrchPlanDeepStructuredContent extends OrchestrationContractBase {
  tool: 'orch_plan';
  kind: 'deep_plan_spawn';
  phase: 'planning';
  mode: 'deep';
  goal: string;
  constraints: string[];
  planAgents: Array<{
    perspective: string;
    model?: string;
    subagent_type?: string;
    task: string;
  }>;
  synthesisInstructions: {
    outputPathTemplate: string;
    registrationMethod: 'planFile';
  };
}

interface OrchPlanRegisteredStructuredContent extends OrchestrationContractBase {
  tool: 'orch_plan';
  kind: 'plan_registered';
  phase: 'awaiting_plan_approval';
  mode: 'standard' | 'deep';
  goal: string;
  planDocument: string;
  planStats: {
    chars: number;
    lines: number;
    source: 'planFile' | 'planContent';
  };
  nextStep: {
    suggestedTool: 'orch_approve_beads';
  };
}
```

Robustness note:
- This is the highest-value contract because it replaces current JSON-in-text scraping.
- Keep existing text JSON in phase 1 for compatibility, but structured content becomes canonical.

### 5. `orch_approve_beads`

This tool has two distinct domains:
- plan approval mode
- bead approval / implementation launch mode

Proposed discriminated union:

```ts
interface OrchApprovePlanReviewStructuredContent extends OrchestrationContractBase {
  tool: 'orch_approve_beads';
  kind: 'plan_review_status' | 'plan_review_prompt' | 'plan_approved';
  phase: 'planning' | 'creating_beads' | 'awaiting_plan_approval';
  goal: string;
  planDocument: string;
  planStats?: {
    lines: number;
    refinementRound: number;
    sizeAssessment: 'too_short' | 'short' | 'substantial';
  };
  nextStep: {
    suggestedAction: 'refine_plan' | 'run_git_diff_review' | 'create_beads';
    suggestedTool?: 'orch_approve_beads';
  };
}

interface OrchApproveBeadsStructuredContent extends OrchestrationContractBase {
  tool: 'orch_approve_beads';
  kind: 'beads_review_status' | 'beads_polish_prompt' | 'implementation_started' | 'parallel_implementation_ready' | 'error';
  phase: 'awaiting_bead_approval' | 'refining_beads' | 'implementing';
  goal: string;
  beadSummary: {
    totalOpen: number;
    readyCount?: number;
    activeBeadIds: string[];
  };
  convergence?: {
    round: number;
    changes: number[];
    score?: number;
    converged: boolean;
  };
  quality?: {
    score: number;
    label: string;
    weakBeads: string[];
  };
  nextStep: {
    suggestedAction: 'polish' | 'start' | 'advanced' | 'diagnose_blocked';
  };
  readyBeads?: Array<{
    id: string;
    title: string;
    descriptionPreview: string;
  }>;
  agentConfigs?: Array<{
    name: string;
    cwd: string;
    task: string;
  }>;
}
```

Robustness note:
- For `readyBeads`, only include short description previews in structured content, not full long descriptions, unless there is exactly one ready bead.
- For parallel configs, structured content can be full-fidelity because machine use is the point, but size must be tested.

### 6. `orch_review`

This tool has the most output variants:
- bead review agent spawn
- looks-good advancement to next bead / gates
- skip advancement
- gate prompts
- regression sentinels

Proposed discriminated union:

```ts
interface OrchReviewStructuredContent extends OrchestrationContractBase {
  tool: 'orch_review';
  kind:
    | 'review_agents_requested'
    | 'bead_completed'
    | 'bead_skipped'
    | 'next_bead'
    | 'parallel_next_beads'
    | 'gates_prompt'
    | 'gate_passed'
    | 'orchestration_complete'
    | 'phase_regressed'
    | 'error';
  phase: string;
  beadId?: string;
  completedBeadId?: string;
  goal?: string;
  reviewRound?: number;
  nextStep?: {
    suggestedTool?: 'orch_review' | 'orch_approve_beads';
    suggestedAction?: string;
  };
  agentTasks?: Array<{
    name: string;
    perspective: string;
    task: string;
  }>;
  nextBeads?: Array<{
    id: string;
    title: string;
    descriptionPreview: string;
  }>;
  gates?: {
    currentGateIndex: number;
    consecutiveCleanRounds: number;
    totalGates: number;
  };
  regression?: {
    targetPhase: OrchestratorPhase;
    phaseName: string;
  };
}
```

Robustness note:
- This tool currently encourages text scraping heavily; structured output will materially reduce host fragility.
- Gate and regression sentinel flows need structured coverage too, not just the happy path.

---

## Ordered Implementation Phases

### Phase 0 — Contract design and compatibility audit

Goal:
- lock down shapes before code churn

Tasks:
1. Inventory every success and error shape for the six tools.
2. Define discriminants (`kind`) per tool.
3. Decide which fields are canonical in structured content and which remain text-only.
4. Decide whether to add server-declared output schemas now or after runtime adoption.

Deliverables:
- TS interfaces in `types.ts` or a new `tool-contracts.ts`
- a small compatibility note in code comments documenting phase-1 dual output policy

Exit criteria:
- each tool has an explicit success/error union documented in code
- no field in structured content is "maybe whatever"

### Phase 1 — Shared result builder and base typing

Goal:
- make dual-surface responses easy and uniform

Tasks:
1. Expand `McpToolResult` to allow `structuredContent` generically.
2. Add shared helpers for `ok`, `error`, and optional truncation metadata.
3. Add a common structured error contract:

```ts
interface OrchestrationToolError {
  contractVersion: 1;
  tool: ...;
  kind: 'error';
  message: string;
  code:
    | 'missing_prerequisite'
    | 'invalid_input'
    | 'not_found'
    | 'cli_failure'
    | 'parse_failure'
    | 'blocked_state'
    | 'unsupported_action'
    | 'internal_error';
  retryable?: boolean;
  details?: Record<string, unknown>;
}
```

4. Add unit tests for builder helpers.

Exit criteria:
- any tool can return `content + structuredContent` with one helper call
- text and structured error flows are standardized

### Phase 2 — Add structured contracts to low-risk, low-payload tools first

Recommended order:
1. `orch_select`
2. `orch_discover`
3. `orch_profile`

Why this order:
- simpler state transitions
- fewer output variants
- lower agent-task payload risk

Tasks:
- keep existing text unchanged
- add compact structured payloads
- add tests asserting both surfaces

Exit criteria:
- all three tools pass old text assertions and new structured assertions

### Phase 3 — Convert `orch_plan` and `orch_review` JSON-in-text flows

Goal:
- formalize the most scrape-prone outputs first

Tasks:
1. `orch_plan` deep mode emits `structuredContent.planAgents` identical in semantics to the current JSON text payload.
2. `orch_review` hit-me emits `structuredContent.agentTasks` identical in semantics to current JSON text payload.
3. `orch_review` next-bead parallel path emits structured agent configs.
4. Preserve current JSON text blocks in phase 1 for compatibility.
5. Add snapshot-like tests ensuring text JSON and structured payload remain semantically aligned.

Exit criteria:
- no host needs to parse `content[0].text` for these flows anymore
- compatibility text remains present

### Phase 4 — Convert `orch_approve_beads` complex union flows

Goal:
- structure plan-review and bead-review/launch outputs without making payloads explode

Tasks:
1. Add plan approval structured variants.
2. Add bead approval structured variants.
3. For large bead/agent outputs, include summary arrays plus full configs only where necessary.
4. Add size guardrails and tests.

Exit criteria:
- all major approval paths produce stable structured discriminants
- large-path payload sizes are measured and within agreed guardrails

### Phase 5 — Server metadata, rollout guardrails, and observability

Goal:
- make adoption visible and safe

Tasks:
1. Update `mcp-server/src/server.ts` tool metadata to document structured result contracts.
2. If supported by SDK/host, attach output schema metadata.
3. Add logging fields for result kind, structured payload presence, and approximate payload size.
4. Optionally gate verbose structured payloads behind an env flag if early compatibility issues arise.

Exit criteria:
- structured output presence is observable in logs/tests
- metadata and runtime output agree

### Phase 6 — Cleanup and deprecation decision

Goal:
- decide whether text-embedded JSON can be removed later

Tasks:
1. Audit downstream consumers.
2. If safe, remove duplicated JSON-in-text blocks in a later release.
3. Keep high-quality human text regardless.

Exit criteria:
- deprecation only happens with evidence, not assumption

---

## File-Level Change Plan

### `mcp-server/src/types.ts`

Primary changes:
- expand `McpToolResult` to include generic `structuredContent`
- add base contract interfaces
- add common error contract
- add per-tool structured content interfaces/unions

Robustness concerns:
- do not create circular import pressure with tool modules
- keep interfaces serializable and free of runtime-only types/functions

### `mcp-server/src/server.ts`

Primary changes:
- update typing to accept expanded tool results
- optionally declare tool output contract metadata in `TOOLS`
- add compact logging of tool result kind / payload size / structured presence

Robustness concerns:
- do not require hosts to understand output schemas to continue working
- avoid server-side transformation that could mutate tool text

### `mcp-server/src/tools/profile.ts`

Primary changes:
- wrap existing text with `structuredContent.profile_ready`
- include compact profile summary, next-step metadata, gap arrays, bead counts
- add structured error outputs for missing prerequisites or parse failures where applicable

Robustness concerns:
- avoid returning full raw profile structure in structured content initially

### `mcp-server/src/tools/discover.ts`

Primary changes:
- emit `ideas_registered` structured payload
- surface artifact write success/failure in structured metadata
- keep idea descriptions primarily in text, compact fields in structured form

Robustness concerns:
- best-effort temp file writes should not silently disappear from observability

### `mcp-server/src/tools/select.ts`

Primary changes:
- emit `goal_selected` structured payload
- include workflow option metadata and next user decision

Robustness concerns:
- low risk; good first structured adoption target

### `mcp-server/src/tools/plan.ts`

Primary changes:
- add discriminated structured outputs for standard prompt, deep spawn, and plan registration
- preserve current deep JSON text compatibility in phase 1
- optionally extract prompt/build logic into helpers to avoid duplication

Robustness concerns:
- largest prompt payload among target tools; must measure size
- avoid duplicating giant prompts unnecessarily in both text and structured content if host limits are tight

### `mcp-server/src/tools/approve.ts`

Primary changes:
- add structured variants for plan review, plan approved, bead review, polish prompt, implementation started, parallel implementation ready, reject/error
- expose convergence and quality scores structurally
- include compact ready bead summaries and full agent configs only when necessary

Robustness concerns:
- many branches; easiest place for missing discriminants or shape drift
- module-level `_lastBeadSnapshot` state means tests must stay isolated

### `mcp-server/src/tools/review.ts`

Primary changes:
- add structured variants for hit-me, looks-good, skip, next bead, parallel next beads, gates, completion, regression sentinels
- preserve JSON text compatibility for hit-me and parallel branches in phase 1

Robustness concerns:
- highest branch count after `approve.ts`
- gate flows and regression sentinels must not be left text-only

### New helper module: `mcp-server/src/tools/contracts.ts` or `mcp-server/src/tools/result.ts`

Primary changes:
- shared builders
- contract version constant
- optional size estimation/truncation helpers

Robustness concerns:
- all tools should rely on this helper to prevent style drift

### `mcp-server/src/__tests__/tools/profile.test.ts`

Add assertions for:
- `structuredContent.tool === 'orch_profile'`
- `kind === 'profile_ready'`
- next-step metadata
- gap arrays / counts
- compatibility: existing text still contains prior phrases

### `mcp-server/src/__tests__/tools/discover.test.ts`

Add assertions for:
- `kind === 'ideas_registered'`
- idea counts and IDs
- weighted score presence when scores exist
- error structured payloads

### `mcp-server/src/__tests__/tools/select.test.ts`

Add assertions for:
- `kind === 'goal_selected'`
- workflow options array
- phase and goal fields

### `mcp-server/src/__tests__/tools/plan.test.ts`

Add assertions for:
- standard mode structured prompt payload
- deep mode structured spawn payload
- plan registration structured payload from `planFile` and `planContent`
- error payload on missing goal / missing plan file
- compatibility with existing text JSON behavior during rollout

### `mcp-server/src/__tests__/tools/approve.test.ts`

Add assertions for:
- plan review and bead review discriminants
- convergence fields
- bead quality fields
- agent configs in structured content for parallel start path
- structured errors for parse failure and missing advancedAction

### `mcp-server/src/__tests__/tools/review.test.ts`

Add assertions for:
- structured hit-me payload with 5 agent tasks
- structured next-bead and parallel-next-beads payloads
- structured gates metadata
- structured completion payload
- structured regression payloads

### Possible new server-level test

If a server test harness exists or is added, include one integration-style test verifying:
- `CallToolRequestSchema` response preserves `structuredContent`
- `isError` responses also carry structured errors

---

## Testing Strategy

### 1. Preserve all existing text assertions first

Do not replace existing tests outright. Augment them.
This is the main safety net against compatibility regressions.

### 2. Add structured-content assertions alongside text assertions

For each tool path:
- assert `structuredContent` exists
- assert tool name
- assert `contractVersion === 1`
- assert `kind`
- assert branch-specific fields

### 3. Add semantic dual-surface consistency tests

Especially for current JSON-in-text flows:
- `orch_plan` deep mode
- `orch_review` hit-me
- `orch_approve_beads` parallel implementation
- `orch_review` parallel next-beads

Recommended pattern:
- parse current JSON text when present
- compare key fields with `structuredContent`
- assert semantic equality for agent count, IDs, names, perspectives, etc.

### 4. Add structured error tests

Cover at least:
- `orch_discover` without profile
- `orch_discover` empty ideas
- `orch_select` empty goal
- `orch_plan` without selected goal
- `orch_plan` missing `planFile`
- `orch_approve_beads` missing goal / failed `br list` / invalid `advancedAction`
- `orch_review` missing beadId / bead not found / unknown action

### 5. Add payload-size tests

Because this is a robustness project, add explicit upper-bound checks for representative structured payloads.

Suggested checks:
- deep plan payload stays under a chosen size budget under normal fixture conditions
- hit-me review payload stays under a chosen size budget
- parallel implementation payload scales reasonably with bead count

If exact limits are unknown, at minimum log and snapshot approximate JSON byte length in tests.

### 6. Add graceful-degradation tests

If size guards or fallback behavior are introduced, test that:
- text still contains full instructions
- structured content may switch to summary form with artifact references
- a warning/flag indicates truncation or compaction

### 7. Add observability tests if logging changes are added

At minimum ensure no exceptions occur when logging payload sizes/kinds.

---

## Acceptance Criteria

1. All six target tools return valid `content` text exactly as before or with only additive, compatibility-safe changes.
2. All six target tools return `structuredContent` on success.
3. All major error paths return structured error payloads in addition to `isError: true` and text.
4. `structuredContent` includes `contractVersion` and stable discriminants.
5. `orch_plan` deep mode and `orch_review` hit-me no longer require text scraping for machine consumers.
6. `orch_approve_beads` and `orch_review` complex branch outputs are covered by structured unions.
7. Test suite verifies both text compatibility and structured correctness.
8. Payload-size-sensitive paths are measured and kept within acceptable limits or compacted intentionally.
9. Server/tool metadata documents the existence of structured contracts without breaking older hosts.
10. No source path outside the targeted tooling/types/tests/server metadata is modified except shared helper additions needed for the contracts.

---

## Robustness Risks and Mitigations

### Risk 1: Host compatibility regression

Scenario:
- Existing host expects only `content` and may ignore or mishandle additional fields.

Mitigation:
- make `structuredContent` purely additive
- preserve current text shape in phase 1
- do not remove text-embedded JSON until downstream consumers are audited
- add one integration check at server dispatch level

### Risk 2: Text/structured drift

Scenario:
- tool updates one surface but not the other

Mitigation:
- use shared builders
- derive both surfaces from the same local variables
- add semantic consistency tests for JSON-like flows

### Risk 3: Payload size blow-up

Scenario:
- duplicating prompts, bead descriptions, or repo structure in both surfaces causes stdio bloat or host truncation

Mitigation:
- structured content should be summaries plus IDs/paths, not full narrative copies
- include artifact/file paths where large content already exists on disk
- add payload-size tests and optional truncation flags

### Risk 4: Performance overhead from serialization

Scenario:
- repeated large `JSON.stringify` for deep plans or large agent task arrays increases latency

Mitigation:
- minimize structured payload size
- avoid serializing duplicate large fields
- keep text generation unchanged where possible
- do not introduce runtime schema validation on every response unless needed

### Risk 5: Partial adoption across tools

Scenario:
- some tools have contracts while others remain text-only, forcing hosts into mixed parsing strategies

Mitigation:
- treat all six tools as one contract rollout
- land low-risk tools first behind a short-lived feature branch, but release as a coherent set

### Risk 6: Error-path neglect

Scenario:
- happy paths get structured payloads, errors stay text-only, making automation brittle under failure

Mitigation:
- define common error contract up front
- add explicit error tests for every target tool

### Risk 7: Graceful degradation gaps

Scenario:
- large or unsupported structured payloads fail hard

Mitigation:
- text remains canonical fallback for humans
- allow compact structured summaries with artifact references
- if server metadata schemas are unsupported by some hosts, runtime still works because fields are additive

### Risk 8: Observability blind spots

Scenario:
- rollout works locally but hosts silently drop structured output

Mitigation:
- log result kind and whether `structuredContent` was attached
- optionally record approximate payload bytes
- compare adoption in integration tests or real host smoke tests

### Risk 9: Retry/failure-mode ambiguity

Scenario:
- consumers cannot tell whether an error is retryable or what the next step should be

Mitigation:
- structured errors include `code` and `retryable`
- success contracts include explicit `nextStep` metadata

---

## Rollout Safety Strategy

### Stage 1: Additive runtime support only

- Add `structuredContent` to runtime results.
- Keep all current text, including JSON-in-text compatibility blocks.
- Do not remove or rename current textual cues.

### Stage 2: Add metadata and richer tests

- Annotate tool definitions with contract documentation/output schema where supported.
- Expand test coverage to all branches.

### Stage 3: Observe downstream usage

- Verify at least one real MCP host can consume the fields.
- Check no host breaks on additive response fields.

### Stage 4: Optional de-duplication

- Only after evidence, reduce redundant JSON-in-text payloads.
- Preserve human-oriented prose indefinitely.

---

## Recommended Implementation Order by File

1. `mcp-server/src/types.ts`
2. new helper: `mcp-server/src/tools/result.ts` or `contracts.ts`
3. `mcp-server/src/tools/select.ts`
4. `mcp-server/src/tools/discover.ts`
5. `mcp-server/src/tools/profile.ts`
6. `mcp-server/src/tools/plan.ts`
7. `mcp-server/src/tools/review.ts`
8. `mcp-server/src/tools/approve.ts`
9. `mcp-server/src/server.ts`
10. tests under `mcp-server/src/__tests__/tools`
11. optional server/integration tests

Why this order:
- types/helpers first reduce churn
- simplest tools prove pattern
- scrape-prone tools next provide highest value
- `approve.ts` last because it has the most branching

---

## Concrete Decisions to Make Before Coding

1. Will structured error payloads always be present when `isError: true`?
   - Recommendation: yes.

2. Will `structuredContent` include full prompts/tasks or only summaries + references?
   - Recommendation: full task arrays where machine execution needs them, summaries elsewhere.

3. Will current JSON-in-text payloads remain for one release or more?
   - Recommendation: at least one release cycle.

4. Where should contracts live?
   - Recommendation: `types.ts` if keeping repository style simple; separate `tool-contracts.ts` if `types.ts` becomes too crowded.

5. Will output schema metadata be enforced or advisory?
   - Recommendation: advisory first.

---

## Final Recommendation

Implement structured contracts as a dual-surface, additive rollout with compact, versioned, discriminated unions per tool. The most important robustness move is not merely adding `structuredContent`; it is making the contract stable across all branches, especially errors and multi-agent spawn flows, while preserving current text compatibility. The best first wins are `orch_plan`, `orch_review`, and `orch_approve_beads`, because those tools already expose implicit machine-readable payloads inside brittle text.
