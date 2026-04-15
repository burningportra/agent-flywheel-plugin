# Ergonomics Plan: Structured `structuredContent` Contracts for `orch_*` Tools

Date: 2026-04-11
Perspective: Ergonomics
Scope: `flywheel_profile`, `flywheel_discover`, `flywheel_select`, `flywheel_plan`, `flywheel_approve_beads`, `flywheel_review`

## Executive Summary

The current MCP tool surface is optimized for human-readable prose, but several `orch_*` tools also smuggle machine-readable meaning inside free-form text. In practice, hosts and agents must scrape markdown, parse ad hoc JSON embedded inside text blocks, or infer workflow state from phrasing like “NEXT: Call `flywheel_select`”. That is workable for Claude-in-the-loop, but ergonomically poor for:

- host integrations that want to render buttons, workflow status, or next-step affordances
- Hermes and other agents that should not have to prompt-scrape prose to decide what to do next
- future test coverage that should assert stable contracts instead of brittle phrasing
- migration to richer MCP clients that already understand `structuredContent`

The plan is to add first-class, typed `structuredContent` contracts to every flywheel tool while preserving current text output compatibility. The ergonomic goal is not “replace prose with JSON”; it is “make the machine contract explicit while keeping the prose pleasant to read and safe for older clients.”

Recommended design:

1. Extend the shared MCP result type to support optional `structuredContent`.
2. Introduce a small family of typed tool result contracts in `mcp-server/src/types.ts` with a consistent envelope:
   - `tool`
   - `version`
   - `status`
   - `phase`
   - `goal?`
   - `nextStep?`
   - `data`
3. Add helper builders in `mcp-server/src/tools/shared.ts` so each tool returns:
   - readable `content` prose for humans
   - predictable `structuredContent` for machines
4. Preserve existing prose as much as possible, but stop encoding machine-only payloads solely inside text. In particular, `flywheel_plan` deep mode and `flywheel_review` hit-me mode should expose their JSON payloads as real `structuredContent`, with prose kept as a summary/instruction layer.
5. Update tests so they verify both backward-compatible text and stable structured contracts.

This yields a far more discoverable API, a cleaner migration path for Hermes, less prompt scraping, and better host rendering opportunities without forcing a breaking change.

## Current State and Ergonomic Problems

### Observed patterns in the codebase

From `mcp-server/src/server.ts` and the tool implementations:

- `McpToolResult` currently only allows `content` and optional `isError`.
- `flywheel_profile`, `flywheel_discover`, `flywheel_select`, and most `flywheel_approve_beads` branches return only markdown-ish text.
- `flywheel_plan` deep mode returns `JSON.stringify(...)` inside `content[0].text` instead of actual `structuredContent`.
- `flywheel_review` hit-me mode likewise returns `JSON.stringify(...)` inside text.
- The server already lives in an MCP ecosystem where `structuredContent` is a normal concept; the repo even has agent-mail code/tests that explicitly read `result.structuredContent`.

### Ergonomic issues

1. API discoverability is low
   Machines cannot reliably tell whether a response contains:
   - a workflow transition
   - a menu of options
   - agent-spawn instructions
   - an error requiring retry
   - a plan-approval prompt versus bead-approval prompt

2. Naming is implicit and inconsistent
   The prose uses “NEXT”, “Option A/B/C”, “Plan approved!”, “Spawn X agents”, etc. Those are human-friendly but not stable API fields.

3. Host integration is unnecessarily hard
   A host that wants to render:
   - a primary next action
   - a list of workflow options
   - a current phase badge
   - plan stats
   - bead quality/convergence cards
   must parse prose or special-case embedded JSON in text.

4. Hermes migration path is fragile
   Hermes can consume prose, but doing so requires prompt-level pattern matching. That is brittle across copy edits and discourages richer automation.

5. Prompt scraping is currently incentivized
   Important structured payloads are hidden in prose or fenced JSON blocks. That encourages LLMs to regex or fuzzy-interpret text instead of reading a declared contract.

6. Readable prose still matters
   Some current outputs are genuinely helpful to humans. The ergonomic goal is not to delete them, but to decouple “human explanation” from “machine contract”.

## Design Principles

1. Human-readable by default, machine-readable by contract
   Every response should still include clear prose unless the payload is purely mechanical and already self-explanatory.

2. Stable envelopes, tool-specific data
   All tools should share a common top-level shape, but each tool’s `data` should be specialized.

3. Backward-compatible rollout
   Existing clients reading only `content` should continue to function.

4. No hidden JSON-in-text for primary machine data
   If a host or agent is expected to parse it, it belongs in `structuredContent`.

5. Phase and next-step semantics should be first-class
   The flywheel tools are a workflow engine. Workflow metadata should not be implicit.

6. Keep prose readable and concise
   Text should summarize what happened and what the user/agent should do, not duplicate every field verbatim.

## Proposed Result Architecture

### Shared envelope

Add a consistent result envelope for all flywheel tools:

```ts
interface ToolNextStep {
  type:
    | "call_tool"
    | "present_choices"
    | "generate_artifact"
    | "run_cli"
    | "spawn_agents"
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

interface OrchestrationStructuredContentBase {
  tool: "flywheel_profile" | "flywheel_discover" | "flywheel_select" | "flywheel_plan" | "flywheel_approve_beads" | "flywheel_review";
  version: 1;
  status: "ok" | "error";
  phase: import("./types.js").OrchestratorPhase | "unknown";
  goal?: string;
  nextStep?: ToolNextStep;
  data: Record<string, unknown>;
}
```

Ergonomic value:

- Hosts get a universal top-level shape.
- Hermes can branch on `tool`, `status`, `phase`, and `nextStep.type` without scraping prose.
- The contract is explicit enough to document and test.

### `content` strategy

Keep `content` text for compatibility and readability, but tighten its role:

- summary of what happened
- user-facing explanation
- human-readable instructions
- no longer the sole carrier of machine-critical payloads

### Error strategy

Error responses should also carry `structuredContent` with:

- `status: "error"`
- stable `error.code`
- human `error.message`
- optional `recovery` / `nextStep`

This is especially important because current errors are prose-only and make host UX difficult.

## Proposed Tool Contracts

### 1. `flywheel_profile`

Current ergonomic role:
- returns repo summary
- indicates coordination backend
- optionally says a goal was provided
- tells caller whether to go to discovery or select

Proposed `data` shape:

```ts
interface OrchProfileStructuredData {
  fromCache: boolean;
  coordination: {
    backend: "beads" | "bare";
    beadsAvailable: boolean;
  };
  foundationGaps: string[];
  existingBeads?: {
    openCount: number;
    deferredCount: number;
  };
  repoProfile: RepoProfile;
  scanResult?: ScanResult;
  workflow: {
    current: "profile";
    upcoming: ["discover", "select", "plan", "approve_beads", "implement", "review"];
  };
  goalProvided?: string;
}
```

Recommended `nextStep` behavior:
- if `args.goal` present: `present_choices` between `flywheel_select` and `flywheel_discover`
- otherwise: `call_tool` -> `flywheel_discover`

Ergonomic gains:
- host can render repo cards and foundation warnings directly
- Hermes can immediately decide whether discovery is required
- no need to parse “Since a goal was provided...” prose

### 2. `flywheel_discover`

Current ergonomic role:
- stores ideas
- tells agent to present ideas to user
- then call `flywheel_select`

Proposed `data` shape:

```ts
interface OrchDiscoverStructuredData {
  ideas: CandidateIdea[];
  counts: {
    total: number;
    top: number;
    honorable: number;
  };
  selectionMode: "user-choice-required";
  artifact?: {
    kind: "ideas-markdown";
    tempDir: string | null;
  };
}
```

Recommended `nextStep` behavior:
- `present_choices` with `options` derived from ideas
- each option can pre-wire `tool: "flywheel_select"` with `{ goal: idea.title }` or better `{ goal: idea.title/description string }`

Ergonomic gains:
- hosts can render idea pickers instead of dumping markdown only
- Hermes can safely present structured candidate options to the user
- scores, risks, synergies become directly available without text mining

### 3. `flywheel_select`

Current ergonomic role:
- persists selected goal
- presents three workflow choices
- includes direct-to-beads instructions

Proposed `data` shape:

```ts
interface OrchSelectStructuredData {
  selectedGoal: string;
  constraints: string[];
  workflowOptions: Array<{
    id: "plan-first" | "deep-plan" | "direct-to-beads";
    label: string;
    description: string;
    recommendedFor: string[];
    nextAction: {
      type: "call_tool" | "run_cli";
      tool?: "flywheel_plan";
      args?: Record<string, unknown>;
    };
  }>;
  beadCreationPrompt: string;
}
```

Recommended `nextStep` behavior:
- `present_choices` with the three workflow options

Ergonomic gains:
- workflow menu is explicit, not buried in headings
- host can render buttons for standard plan / deep plan / direct beads
- prose can stay exactly as helpful as today

### 4. `flywheel_plan`

This tool needs the biggest ergonomic cleanup because it currently mixes three very different behaviors:

- planning prompt generation (`mode=standard`)
- agent-spawn config generation (`mode=deep`)
- plan registration (`planFile` or `planContent`)

Recommended contract strategy:
- keep one tool name for compatibility
- make `data.kind` explicit so machines know which branch occurred

```ts
type OrchPlanStructuredData =
  | {
      kind: "plan_prompt";
      mode: "standard";
      goal: string;
      constraints: string[];
      planDocument: string;
      repoContext?: {
        name: string;
        languages: string[];
        frameworks: string[];
        hasTests: boolean;
      };
      planRequirements: string[];
    }
  | {
      kind: "deep_plan_spawn";
      mode: "deep";
      goal: string;
      constraints: string[];
      planAgents: Array<{
        model?: string;
        subagent_type?: string;
        perspective: string;
        task: string;
      }>;
      synthesisPrompt: string;
      instructions: string;
    }
  | {
      kind: "plan_registered";
      source: "planFile" | "planContent";
      goal: string;
      constraints: string[];
      planDocument: string;
      stats: {
        chars: number;
        lines: number;
      };
    };
```

Recommended `nextStep` behavior:
- standard prompt branch: `generate_artifact`
- deep plan branch: `spawn_agents`
- plan registered branch: `call_tool` -> `flywheel_approve_beads`

Critical ergonomic change:
- stop putting the deep-plan payload only in `content[0].text`
- keep a short prose summary, but expose `planAgents` and `synthesisPrompt` as `structuredContent`

### 5. `flywheel_approve_beads`

This tool has multiple sub-flows and should expose them clearly:
- plan approval mode
- bead approval mode
- polish / advanced refinement
- implementation launch

Recommended contract strategy:
- use `data.kind` to distinguish response families

```ts
type OrchApproveStructuredData =
  | {
      kind: "plan_review";
      planDocument: string;
      planRefinementRound: number;
      planStats: {
        lines: number;
        sizeAssessment: "too_short" | "short" | "substantial";
      };
      availableActions: Array<"start" | "polish" | "reject" | "git-diff-review">;
    }
  | {
      kind: "bead_review";
      selectedGoal: string;
      beads: Bead[];
      activeBeadIds: string[];
      polishRound: number;
      polishChanges: number[];
      convergenceScore?: number;
      polishConverged: boolean;
      beadQuality: ReturnType<typeof computeBeadQualityScore>;
      availableActions: Array<"start" | "polish" | "reject" | "advanced">;
      advancedActions?: string[];
    }
  | {
      kind: "implementation_ready";
      selectedGoal: string;
      readyBeads: Bead[];
      launchMode: "single" | "parallel";
      currentBeadId?: string;
      beadQuality: ReturnType<typeof computeBeadQualityScore>;
      convergenceScore?: number;
      agentConfigs?: Array<{ name: string; cwd: string; task: string }>;
    }
  | {
      kind: "refinement_request";
      refinementType: "polish" | "advanced" | "git-diff-review";
      round: number;
      modelHint?: string;
      instructions: string;
    };
```

Recommended `nextStep` behavior:
- plan review: `present_choices`
- bead review: `present_choices`
- implementation ready single: `resume_phase`
- implementation ready parallel: `spawn_agents`
- refinement request: `spawn_agents` or `run_cli` depending on branch

Ergonomic gains:
- hosts can render approval menus directly
- bead quality and convergence can be displayed numerically without text parsing
- advanced actions stop being hidden inside prose

### 6. `flywheel_review`

This tool currently has the other major structured-output problem:
- hit-me returns JSON as stringified text
- looks-good / skip return workflow text
- gates and regression sentinels are prose-only state transitions

Recommended contract strategy:

```ts
type OrchReviewStructuredData =
  | {
      kind: "review_agents";
      beadId: string;
      beadTitle: string;
      round: number;
      files: string[];
      agentTasks: Array<{
        name: string;
        perspective: string;
        task: string;
      }>;
    }
  | {
      kind: "bead_progress";
      beadId: string;
      status: "passed" | "skipped" | "already_complete";
      nextReadyBeads: Bead[];
      nextMode: "gates" | "single" | "parallel" | "none";
      currentBeadId?: string;
      agentConfigs?: Array<{ name: string; cwd: string; task: string }>;
    }
  | {
      kind: "review_gate";
      gateIndex: number;
      gateLabel: string;
      iterationRound: number;
      consecutiveCleanRounds: number;
      completionThreshold: number;
      instructions: {
        passAction: { beadId: "__gates__"; action: "looks-good" };
        failAction: { beadId: "__gates__"; action: "hit-me" };
      };
    }
  | {
      kind: "phase_regression";
      targetPhase: "planning" | "creating_beads" | "implementing";
      reasonLabel: string;
      instructions: string;
    };
```

Recommended `nextStep` behavior:
- hit-me: `spawn_agents`
- looks-good/skip: one of `resume_phase`, `spawn_agents`, `call_tool`, or `none`
- gates: `call_tool` with sentinel args guidance
- regression: `resume_phase`

Ergonomic gains:
- no more scraping stringified JSON from text
- gate progression becomes renderable and testable
- sentinel transitions become explicit workflow state rather than magic bead IDs buried in prose

## Naming Recommendations

Naming matters because these contracts are intended for both humans and machines.

### Recommended naming rules

1. Use `kind` for response family discrimination
   Better than ambiguous booleans like `isDeepPlan` or `needsApproval`.

2. Use `nextStep` for immediate flywheel guidance
   Avoid `next`, `instruction`, or `actionHint` fragmentation.

3. Use `availableActions` only for literal action menus accepted by the same tool
   Example: `flywheel_approve_beads` should expose `availableActions` and `advancedActions`.

4. Use `workflowOptions` for user-facing branches
   Example: `flywheel_select` should expose plan-first / deep-plan / direct-to-beads as `workflowOptions`.

5. Use `stats` for quantitative metadata
   Example: chars, lines, counts.

6. Keep text labels distinct from ids
   - `id`: stable machine key
   - `label`: human display string
   - `description`: explanation

### Avoid

- booleans that imply hidden modes
- prose-only next-step indicators
- raw embedded JSON strings in `content`
- inconsistent synonyms like `prompt`, `instructions`, `action`, `menu`, `options` for the same concept

## File-Level Change Plan

### `mcp-server/src/types.ts`

Add the shared contract definitions here.

Planned additions:

1. Expand `McpToolResult`:

```ts
export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
```

2. Add shared flywheel result helpers/types:
- `OrchestrationStructuredContentBase`
- `ToolNextStep`
- error contract type

3. Add per-tool structured data interfaces/unions:
- `OrchProfileStructuredData`
- `OrchDiscoverStructuredData`
- `OrchSelectStructuredData`
- `OrchPlanStructuredData`
- `OrchApproveStructuredData`
- `OrchReviewStructuredData`

4. Consider exporting a union:
- `OrchestrationStructuredContent`

Ergonomic rationale:
- one source of truth for response contracts
- easier for tests and future docs to reference
- strong signal to contributors that `structuredContent` is part of the API surface

### `mcp-server/src/tools/shared.ts`

Add helper builders so tools do not each hand-roll envelopes.

Recommended helpers:

```ts
function makeToolResult<T extends OrchestrationStructuredContent>(
  text: string,
  structuredContent: T,
  isError = false
): McpToolResult

function makeToolError(
  tool: ToolName,
  phase: OrchestratorPhase | "unknown",
  code: string,
  message: string,
  nextStep?: ToolNextStep
): McpToolResult
```

Optional helper families:
- `makeNextToolStep(...)`
- `makeChoiceOption(...)`
- `summarizePlanStats(...)`

Ergonomic rationale:
- consistent shape across six tools
- fewer copy/paste mistakes
- makes future contract expansion cheaper

### `mcp-server/src/server.ts`

Behavioral changes should be minimal.

Planned work:
- ensure returned `structuredContent` is passed through untouched by the MCP server
- optionally enrich argument validation errors to also return `structuredContent`

Important check:
- confirm the SDK response shape used by `CallToolRequestSchema` supports `structuredContent` transparently; if necessary, adjust typing/imports accordingly

Ergonomic rationale:
- server should not special-case or strip structured payloads
- validation errors should become host-renderable too

### `mcp-server/src/tools/profile.ts`

Modify success and error returns to emit structured payloads.

Preserve:
- current readable roadmap
- foundation gap summary
- repo profile formatting

Add:
- explicit repo profile data object
- backend and next-step metadata
- cache provenance

### `mcp-server/src/tools/discover.ts`

Modify success and error returns.

Preserve:
- readable idea list text for human presentation

Add:
- ideas array in structured data
- top/honorable counts
- selection options / next-step menu

### `mcp-server/src/tools/select.ts`

Modify success and error returns.

Preserve:
- current three-option prose
- bead creation prompt text

Add:
- workflow options as structured choice records
- direct mapping to recommended next actions

### `mcp-server/src/tools/plan.ts`

Highest-priority tool to refactor carefully.

Preserve:
- current prose summaries and instructions

Change materially:
- deep-mode spawn payload moves from stringified JSON in `content` to real `structuredContent`
- standard plan prompt branch gets explicit `kind: "plan_prompt"`
- `planFile` / `planContent` registration branch gets explicit plan stats and next-step contract

### `mcp-server/src/tools/approve.ts`

Second-highest-priority tool because it has many branching states.

Preserve:
- existing text guidance where useful

Add:
- explicit `kind` per branch
- available action menus
- bead quality / convergence as numeric structured fields
- implementation launch payloads in `structuredContent`

### `mcp-server/src/tools/review.ts`

Third-highest-priority tool because it currently returns stringified JSON and relies on sentinel identifiers.

Preserve:
- helpful textual summaries

Change materially:
- hit-me agent specs move to real `structuredContent`
- gate state becomes explicit contract
- next-bead transitions get structured `nextMode`

## Ordered Implementation Phases

### Phase 0: Contract design and ADR-style documentation

Deliverables:
- define top-level envelope shape
- define each tool’s `data.kind` taxonomy
- document compatibility policy: prose retained, `structuredContent` additive

Why first:
- prevents six tools from inventing six schemas
- reduces naming drift

Acceptance checkpoint:
- one written schema map agreed before code changes

### Phase 1: Shared type and helper foundation

Files:
- `mcp-server/src/types.ts`
- `mcp-server/src/tools/shared.ts`
- possibly `mcp-server/src/server.ts`

Deliverables:
- `McpToolResult` supports `structuredContent`
- helper builders exist
- validation errors can return structured errors

Acceptance checkpoint:
- one trivial tool can return `structuredContent` through the server boundary unchanged

### Phase 2: Low-complexity workflow tools

Files:
- `mcp-server/src/tools/profile.ts`
- `mcp-server/src/tools/discover.ts`
- `mcp-server/src/tools/select.ts`

Why these first:
- relatively linear flows
- easiest place to prove the envelope design
- highest leverage for host discoverability

Acceptance checkpoint:
- these tools all return stable `nextStep` contracts and preserve current prose readability

### Phase 3: `flywheel_plan` contract split

Files:
- `mcp-server/src/tools/plan.ts`
- tests for plan branches

Why isolated:
- it has three distinct modes and currently embeds JSON in prose
- this is a critical migration target for Hermes

Acceptance checkpoint:
- deep mode no longer requires `JSON.parse(result.content[0].text)` in tests or host logic

### Phase 4: `flywheel_approve_beads` branching contract

Files:
- `mcp-server/src/tools/approve.ts`
- tests

Why after plan:
- approval semantics depend on plan/bead state transitions
- more complex branch families benefit from the now-proven helpers

Acceptance checkpoint:
- plan approval mode and bead approval mode are machine-distinguishable without prose inspection

### Phase 5: `flywheel_review` and sentinel ergonomics

Files:
- `mcp-server/src/tools/review.ts`
- tests

Why last:
- review has multiple sentinel pathways and next-step transitions
- easiest to model once earlier workflow contracts are stable

Acceptance checkpoint:
- hit-me, gates, and regression flows are fully represented in `structuredContent`

### Phase 6: Test hardening and optional documentation follow-through

Files:
- all relevant tool tests
- optional docs/README/skill references if they mention parsing text payloads

Acceptance checkpoint:
- every tool test asserts both text compatibility and structured contract correctness

## Testing Strategy

### Unit test updates by file

#### `mcp-server/src/__tests__/tools/profile.test.ts`
Add assertions for:
- `structuredContent.tool === "flywheel_profile"`
- `structuredContent.status === "ok"`
- `structuredContent.phase === "discovering"`
- `structuredContent.data.repoProfile` present
- `structuredContent.nextStep.tool` equals `flywheel_discover` or menu type if goal provided
- error branches, if added, expose structured error codes

#### `mcp-server/src/__tests__/tools/discover.test.ts`
Add assertions for:
- idea counts in `structuredContent.data.counts`
- ideas array preserved structurally
- `nextStep.type === "present_choices"`
- options exist for selecting an idea
- error branch returns structured error when no repo profile or no ideas

#### `mcp-server/src/__tests__/tools/select.test.ts`
Add assertions for:
- `workflowOptions` includes `plan-first`, `deep-plan`, `direct-to-beads`
- `nextStep.type === "present_choices"`
- `data.selectedGoal` and `data.constraints` are correct
- `beadCreationPrompt` exposed structurally

#### `mcp-server/src/__tests__/tools/plan.test.ts`
High-priority changes:
- standard mode should assert `structuredContent.data.kind === "plan_prompt"`
- deep mode should assert `structuredContent.data.kind === "deep_plan_spawn"`
- deep mode tests should stop parsing JSON from `content[0].text`
- `planFile` and `planContent` branches should assert `kind === "plan_registered"`
- plan stats should be asserted structurally
- error branch should assert structured error data

#### `mcp-server/src/__tests__/tools/approve.test.ts`
Add structured assertions for:
- `kind === "plan_review"` in plan approval mode
- `kind === "bead_review"` on review menu branches
- `kind === "implementation_ready"` on start branches
- bead quality and convergence fields
- available action menus and advanced action lists
- structured error data for missing goal, `br list` failures, parse failures

#### `mcp-server/src/__tests__/tools/review.test.ts`
High-priority changes:
- `hit-me` should assert `structuredContent.data.kind === "review_agents"`
- tests should stop parsing JSON from text
- looks-good/skip should assert `kind === "bead_progress"`
- gates should assert `kind === "review_gate"`
- regression sentinels should assert `kind === "phase_regression"`
- structured next-step assertions for moving to gates, next bead, or spawn-agents

### Additional test categories

1. Contract shape regression tests
   Add a small focused suite that asserts every `orch_*` tool returns:
   - `structuredContent.tool`
   - `structuredContent.version`
   - `structuredContent.status`
   - `structuredContent.phase`
   - `structuredContent.data`

2. Backward-compatibility tests
   For every tool, keep at least one assertion that existing human-readable text still contains critical phrases already relied on by current behavior.

3. Error contract tests
   Add explicit tests ensuring errors are not prose-only.

4. Server pass-through test
   If server tests exist or are easy to add, verify `CallToolRequestSchema` handler returns `structuredContent` unchanged.

## Acceptance Criteria

### Functional acceptance

1. All six flywheel tools return valid `structuredContent` on success.
2. All six flywheel tools return structured errors on failure.
3. `flywheel_plan` deep mode and `flywheel_review` hit-me mode no longer require parsing JSON out of `content[0].text`.
4. `content` prose remains present and readable for all existing human-facing flows.
5. `structuredContent.nextStep` is populated for all branches that expect a follow-up action.

### Ergonomic acceptance

1. A host can render the next action without parsing prose.
2. A host can render workflow choices for `flywheel_select` and `flywheel_approve_beads` directly from structured fields.
3. Hermes can drive the flywheel workflow by reading `structuredContent` alone.
4. Copy edits to human prose do not break machine integrations.
5. Contributors can understand each tool’s machine contract by reading exported types instead of reverse-engineering strings.

### Testing acceptance

1. Relevant tool tests assert `structuredContent` shape and branch-specific payloads.
2. Existing text-focused assertions continue to pass or are adjusted only where wording intentionally improves.
3. No branch that currently returns embedded JSON-in-text remains dependent on that pattern for machine consumers.

## Migration Path for Hermes

### Phase A: additive rollout

- add `structuredContent` while leaving prose untouched
- Hermes prefers `structuredContent` when present, falls back to text only for older tool versions

### Phase B: host/UI improvements

- render workflow controls from `nextStep` and `workflowOptions`
- use structured counts, stats, and quality fields for dashboards/cards

### Phase C: prompt simplification

Once Hermes consumes structured contracts reliably, reduce prompt instructions that currently explain how to interpret prose phrases like:
- “NEXT: Call ...”
- “Option A/B/C”
- fenced JSON instructions

This should shrink prompts and reduce error-prone meta-instructions.

### Compatibility note

Do not remove current readable prose in the first pass. That would create unnecessary migration pain for humans and any older automation that still reads `content`.

## Risks and Mitigations

### Risk 1: schema sprawl

If each tool invents its own top-level conventions, ergonomics get worse, not better.

Mitigation:
- enforce one shared envelope
- centralize types in `types.ts`
- centralize builders in `tools/shared.ts`

### Risk 2: prose and structured content drift apart

If text says one thing and structured content says another, trust collapses.

Mitigation:
- derive both from the same local variables
- use builder helpers so prose summary and structured payload are authored together
- add tests for both branches

### Risk 3: over-modeling the contract

An excessively detailed schema can become painful to evolve.

Mitigation:
- keep stable top-level fields small
- use `data.kind` plus focused branch-specific fields
- version the contract explicitly with `version: 1`

### Risk 4: breaking consumers that expect pure text

Some clients may ignore or mishandle unfamiliar fields.

Mitigation:
- additive only
- preserve `content`
- avoid changing tool names or required args

### Risk 5: embedded JSON remains in some branches out of convenience

That would undercut the entire ergonomics goal.

Mitigation:
- explicitly prioritize `flywheel_plan` deep mode and `flywheel_review` hit-me mode in code review
- add tests that consume `structuredContent` instead of parsing text

### Risk 6: sentinel-heavy review flow stays opaque

Even with structured content, magic bead IDs can remain conceptually awkward.

Mitigation:
- keep sentinel values for compatibility
- expose their semantic meaning via `kind`, `targetPhase`, and `nextStep`
- consider a future v2 cleanup if desired

## Recommended Implementation Order by ROI

1. `types.ts` + `tools/shared.ts`
2. `flywheel_plan`
3. `flywheel_review`
4. `flywheel_select`
5. `flywheel_profile`
6. `flywheel_discover`
7. `flywheel_approve_beads`
8. tests and docs polish

Why this order differs slightly from pure workflow order:
- `flywheel_plan` and `flywheel_review` currently have the worst machine ergonomics because they serialize JSON into text
- fixing those first delivers immediate Hermes value

If minimizing code-review risk is more important than fastest payoff, use the earlier low-complexity-first phase order instead.

## Recommended Review Checklist

When implementing, reviewers should ask:

1. Can a machine consume this branch without reading prose?
2. Is the top-level envelope consistent with the other tools?
3. Does `nextStep` tell the truth about the actual expected follow-up?
4. Is the prose still readable to a human in a terminal?
5. Are any fields merely duplicated strings instead of useful structured data?
6. Did we remove any stringified JSON from `content` where it was formerly machine-critical?
7. Are error codes stable and non-hand-wavy?

## Final Recommendation

Implement structured contracts as an additive compatibility layer, not a prose replacement. The ergonomically correct endpoint is:

- prose for humans
- `structuredContent` for machines
- stable next-step semantics for hosts and Hermes
- no prompt scraping required for core workflow transitions

If done with a shared envelope and disciplined helper functions, this change will make the flywheel tools substantially easier to discover, integrate, test, and automate, while keeping the current terminal-readable experience intact.