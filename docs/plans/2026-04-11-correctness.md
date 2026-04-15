# StructuredContent contracts for flywheel_* tools: correctness-first deep plan

## Executive summary

The six flywheel tools `flywheel_profile`, `flywheel_discover`, `flywheel_select`, `flywheel_plan`, `flywheel_approve_beads`, and `flywheel_review` currently return only text via `content`, even when some responses are already machine-shaped JSON serialized into text (`flywheel_plan` deep mode, `flywheel_review` hit-me, parallel-bead handoff in `flywheel_approve_beads`). This is the core correctness risk: downstream automation has to parse prose or JSON embedded in prose, which is fragile, under-typed, and inconsistent across branches.

The safest implementation path is to add explicit `structuredContent` contracts without breaking current text consumers:

1. Add a typed result envelope in `mcp-server/src/types.ts` for MCP tool responses that supports both `content` and optional `structuredContent`.
2. Define per-tool structured payload schemas as TypeScript interfaces plus JSON-schema-like output contract objects in one shared place.
3. Add helper builders so every success/error path can return both:
   - human-compatible text in `content`
   - machine-readable data in `structuredContent`
4. Register output contracts in `mcp-server/src/server.ts` for all six `flywheel_*` tools.
5. Update each tool incrementally, preserving existing text textually where practical and ensuring structured fields accurately mirror state transitions and branch-specific outcomes.
6. Expand tests from “text contains string” to also assert exact structured payload shape, discriminants, and state invariants.

The main correctness objective is not merely “include some JSON”, but to guarantee:
- every tool branch has a stable discriminated result shape
- state mutations and structured outputs agree
- error branches are machine-readable too
- previously working conversational/text flows remain intact
- no client must parse prose to know what happened next

## Current architecture and constraints

### Existing server/tool shape

From `mcp-server/src/server.ts` and `mcp-server/src/types.ts`:

- Tool definitions currently specify only `name`, `description`, and `inputSchema`.
- `ListToolsRequestSchema` publishes those tool definitions.
- `CallToolRequestSchema` dispatches into `runProfile`, `runDiscover`, `runSelect`, `runPlan`, `runApprove`, `runReview`, and `runMemory`.
- `McpToolResult` is currently:
  - `content: Array<{ type: "text"; text: string }>`
  - optional `isError`
- There is no shared output schema registration and no `structuredContent` typing.

### Current tool behavior by branch

`flywheel_profile`
- Mutates phase to `profiling`, then `discovering`
- Stores `repoProfile`, coordination backend/strategy, optional `selectedGoal`
- Returns a long human summary only
- Important structured data already exists in memory but is not emitted directly

`flywheel_discover`
- Requires `state.repoProfile`
- Stores `candidateIdeas`, sets phase `awaiting_selection`
- Writes a best-effort artifact to temp dir
- Returns a human-formatted idea list only

`flywheel_select`
- Validates `goal`
- Sets `selectedGoal`, phase `planning`, preserves/initializes `constraints`
- Returns workflow options and direct-to-beads instructions only in prose

`flywheel_plan`
- Has three materially different success modes:
  1. planning prompt (`mode=standard`, no plan input)
  2. spawn-plan-agents config (`mode=deep`, no plan input) returned as JSON string in text
  3. plan registration (`planFile` or `planContent`) transitioning to `awaiting_plan_approval`
- Error branch for missing selected goal
- Error branch for missing `planFile`

`flywheel_approve_beads`
- Has two major super-modes:
  1. plan approval mode when `state.planDocument` is active
  2. bead approval mode using `br list --json`
- Within those, actions branch heavily: `start`, `polish`, `reject`, `advanced`, `git-diff-review`
- Produces multiple machine-worthy outcomes currently encoded as prose or JSON-in-fences/text
- Uses module-level `_lastBeadSnapshot`, which creates a correctness-sensitive hidden state during refinement rounds

`flywheel_review`
- Supports normal bead review plus sentinels:
  - `__gates__`
  - `__regress_to_plan__`
  - `__regress_to_beads__`
  - `__regress_to_implement__`
- Branches on `hit-me`, `looks-good`, `skip`
- Returns JSON string for review agents in `hit-me`
- Returns prose for gates and transitions

### Existing tests

Relevant tests already cover many state transitions and branch behaviors:
- `profile.test.ts`
- `discover.test.ts`
- `select.test.ts`
- `plan.test.ts`
- `approve.test.ts`
- `review.test.ts`

This is good news: the repo already has correctness-oriented tests for state mutation and many branch conditions. The structuredContent rollout should extend these tests rather than replace them.

## Correctness goals

1. Every `flywheel_*` tool returns stable `structuredContent` on all success branches.
2. Every error branch for those tools also returns stable `structuredContent` with a machine-readable error code/category.
3. Text compatibility is preserved:
   - existing `content[0].text` should remain semantically equivalent
   - where clients or tests inspect specific phrases, avoid gratuitous text rewrites
4. Structured payloads must encode branch identity explicitly via discriminants.
5. Structured payloads must capture enough data that no caller needs to scrape prose for:
   - next action
   - phase transition
   - selected goal / plan path / bead IDs
   - agent spawn instructions
   - gate progress
   - approval mode and action result
6. Structured payloads must agree with actual state mutations and external command results.
7. Output contracts must reflect branch-specific optionality, not hand-wave it as loose `Record<string, unknown>`.

## Architectural plan

### 1. Introduce a shared typed response model

File: `mcp-server/src/types.ts`

Add a richer MCP result type that still matches current usage:

- `McpTextContentBlock`
- `McpStructuredToolResult<TStructured>` generic
- base error/result metadata types

Recommended shape:

```ts
export type McpTextContentBlock = { type: "text"; text: string };

export interface ToolErrorInfo {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export type McpToolResult<TStructured = Record<string, unknown>> = {
  content: McpTextContentBlock[];
  structuredContent?: TStructured;
  isError?: boolean;
};
```

Key correctness rule: do not make `structuredContent` mandatory until every branch is migrated and tested.

### 2. Define discriminated structured contracts per tool

File: `mcp-server/src/types.ts` or a new dedicated file such as `mcp-server/src/tool-contracts.ts`

Prefer a dedicated file if the type section becomes too large. From a correctness/readability perspective, that is safer.

Define one top-level union per tool. Each should have:
- `tool`: exact tool name
- `ok`: boolean
- branch discriminator, e.g. `resultType`, `mode`, or `approvalKind`
- `phaseBefore` and/or `phaseAfter` where meaningful
- branch-specific payload
- `nextAction` / `nextActions` object(s) instead of prose-only instructions

Recommended unions:

### `flywheel_profile`

Success contract should include at minimum:
- `tool: "flywheel_profile"`
- `ok: true`
- `phaseAfter: "discovering"`
- `profile`
- `fromCache`
- `coordination`
- `foundationGaps`
- `existingBeadsSummary`
- `selectedGoal` if provided
- `nextStep`

Error contract likely only needed for server-level exception path or future validation expansion, since current tool body mostly succeeds/fails by throwing.

### `flywheel_discover`

Need explicit distinction between success and prerequisite/input failure.

Success fields:
- `tool: "flywheel_discover"`
- `ok: true`
- `phaseAfter: "awaiting_selection"`
- `ideaCounts: { total, top, honorable }`
- `ideas` (full normalized list)
- optional artifact metadata if write succeeded
- `nextStep: { tool: "flywheel_select", reason: "user_must_choose_goal" }`

Error fields:
- `tool: "flywheel_discover"`
- `ok: false`
- `error.code: "missing_repo_profile" | "missing_ideas" | ...`
- `phaseAfter` should reflect unchanged phase when applicable

### `flywheel_select`

Success fields:
- `tool: "flywheel_select"`
- `ok: true`
- `phaseAfter: "planning"`
- `selectedGoal`
- `constraints`
- `workflowOptions`
  - `standard_plan`
  - `deep_plan`
  - `direct_to_beads`
- optional `repoContextSummary`

Error fields:
- `error.code: "invalid_goal"`

### `flywheel_plan`

This tool needs the most careful discriminated union because it has multiple incompatible outputs.

Use `resultType` as discriminator:
- `"plan_prompt"` for standard planning prompt generation
- `"deep_plan_spawn"` for multi-agent spawn config
- `"plan_registered"` for `planFile`/`planContent` registration
- `"error"`

For `plan_prompt`:
- `phaseAfter: "planning"`
- `goal`
- `planDocument`
- `mode: "standard"`
- `requirements`
- `nextStep`

For `deep_plan_spawn`:
- `phaseAfter: "planning"`
- `goal`
- `mode: "deep"`
- `planAgents`
- `instructions`
- `synthesisPrompt`

For `plan_registered`:
- `phaseAfter: "awaiting_plan_approval"`
- `goal`
- `planDocument`
- `source: "planFile" | "planContent"`
- `stats: { chars, lines }`
- `nextStep: { tool: "flywheel_approve_beads", action: "start|polish|reject?" }` (probably action omitted here; just next tool)

Error codes:
- `missing_selected_goal`
- `plan_file_not_found`

### `flywheel_approve_beads`

This needs two-level discrimination:
- `approvalTarget: "plan" | "beads"`
- `resultType` for branch outcome

Plan approval mode result types:
- `plan_rejected`
- `plan_refinement_requested`
- `plan_git_diff_review_requested`
- `plan_approved_for_bead_creation`
- `error`

Bead approval mode result types:
- `beads_rejected`
- `bead_refinement_requested`
- `advanced_refinement_requested`
- `implementation_started_single`
- `implementation_started_parallel`
- `implementation_blocked_no_ready_beads`
- `no_open_beads`
- `error`

Critical structured fields:
- `selectedGoal`
- `phaseAfter`
- `activeBeadIds`
- `polish` summary: round, changes, converged, convergenceScore, outputSizes? maybe omit raw sizes if noisy
- `beadQuality`
- `readyBeads`
- `agentConfigs` when parallel spawn is requested
- `currentBeadId` when sequential start occurs
- `advancedAction` when applicable
- `planDocument`, `planStats`, `refinementRound` for plan mode

Important correctness note: some current text returns embed JSON inside fenced blocks for agent configs. Structured content should contain the raw arrays/objects, while text may keep the existing blocks for compatibility.

### `flywheel_review`

Use `resultType` with explicit sentinels/actions:
- `review_agents_requested`
- `bead_passed_all_done_enter_gates`
- `bead_passed_next_single`
- `bead_passed_next_parallel`
- `bead_skipped_all_done_enter_gates`
- `bead_skipped_next_single`
- `bead_skipped_next_parallel`
- `gate_presented`
- `gate_advanced`
- `flywheel_complete`
- `phase_regressed`
- `already_complete`
- `error`

Critical fields:
- `beadId`
- `action`
- `phaseAfter`
- `beadResult` if one was recorded
- `reviewPassCount`
- `hitMeState`
- `agentTasks` for `hit-me`
- `nextBeads` / `agentConfigs` when moving forward
- `gateIndex`, `consecutiveCleanRounds`, `round`
- `regressionTarget`

## Invariants to encode and preserve

These should be explicitly documented in types/tests and checked in implementation:

1. `content` and `structuredContent` must describe the same branch outcome.
2. If `isError === true`, then `structuredContent.ok === false`.
3. If `structuredContent.ok === false`, include a stable `error.code`.
4. If `phaseAfter` is present, it must equal the actual saved `state.phase` after mutation.
5. For `flywheel_plan`:
   - `resultType === "plan_registered"` implies `state.planDocument` is set and `phaseAfter === "awaiting_plan_approval"`.
   - `resultType === "plan_prompt"` implies `state.planDocument` exists and `phaseAfter === "planning"`.
6. For `flywheel_approve_beads` start success:
   - single-start branch implies exactly one ready bead and `currentBeadId` matches it
   - parallel-start branch implies `agentConfigs.length === readyBeads.length`
7. For `flywheel_review` hit-me:
   - `beadHitMeTriggered[beadId] === true`
   - `beadHitMeCompleted[beadId] === false`
   - `agentTasks.length === 5` under current behavior
8. For gate completion:
   - `phaseAfter === "complete"` iff `consecutiveCleanRounds >= 2` in that branch
9. For regression sentinels:
   - `resultType === "phase_regressed"`
   - `phaseAfter` equals the sentinel target phase
10. No branch should require consumers to deserialize `content[0].text` to obtain primary machine state.

## Backward compatibility plan

### Content compatibility

Preserve existing text output as much as possible, especially in tests that assert substrings like:
- `No repo profile found`
- `Plan Document Requirements`
- `Beads approved`
- `Orchestration Complete`
- `Unknown action`

Where current text is JSON stringified (`flywheel_plan` deep mode, `flywheel_review` hit-me), keep the text output for now, but add the same object under `structuredContent`. This minimizes breakage for existing consumers that already parse the text while giving new consumers a canonical path.

### API compatibility

- Do not remove `content`.
- Do not rename existing tools.
- Avoid tightening runtime validation in the same patch unless required for structural correctness, because that changes behavior scope.
- If adding `outputSchema` to tool definitions in `server.ts`, ensure it reflects the union contract but does not require immediate client changes.

### Test compatibility

Existing text assertions should continue to pass.
New assertions should verify structured payloads in addition to text.

## Ordered implementation phases

## Phase 1: contract design and shared helpers

Files:
- `mcp-server/src/types.ts`
- possibly new `mcp-server/src/tool-contracts.ts`
- possibly new `mcp-server/src/tools/result.ts` or similar helper

Changes:
- Introduce generic `McpToolResult<TStructured>` with `structuredContent`
- Define shared error/result primitives
- Define per-tool structured contract unions
- Add helper functions like:
  - `textResult(text, structuredContent?)`
  - `errorResult(text, errorStructured)`

Correctness checkpoints:
- every branch must be representable without `as any`
- unions use discriminants, not ad hoc optional combinations
- error codes are explicit and finite where possible

## Phase 2: publish tool output schemas in `server.ts`

File:
- `mcp-server/src/server.ts`

Changes:
- For each flywheel tool in `TOOLS`, add an output schema field if supported by the MCP SDK shape in use.
- If the SDK/tool descriptor typing does not currently expose `outputSchema`, still centralize schema objects for later attachment and use them in tests/helpers.

Correctness checkpoints:
- schema/tool name alignment is exact
- output contract mirrors actual runtime union branches
- avoid a mismatch where schema claims a required field some branch does not supply

## Phase 3: migrate `flywheel_profile`

File:
- `mcp-server/src/tools/profile.ts`

Changes:
- Keep current text output
- Add structured payload containing profile, cache/coordinator/foundation/bead summaries, selected goal, next step

Correctness edge cases to encode:
- cache hit vs miss
- beads available vs not installed
- goal supplied vs absent
- profile still succeeds if bead parsing fails; structured output should reflect what is known, not invent missing bead data

## Phase 4: migrate `flywheel_discover` and `flywheel_select`

Files:
- `mcp-server/src/tools/discover.ts`
- `mcp-server/src/tools/select.ts`

Changes:
- Add structured success/error payloads
- Include explicit next action objects

Correctness edge cases:
- missing `repoProfile`
- empty ideas list
- honorable/top counts
- goal trimming in `select`
- `constraints` initialization/preservation
- `select` success without `repoProfile`

## Phase 5: migrate `flywheel_plan`

File:
- `mcp-server/src/tools/plan.ts`

Changes:
- Convert each mode/branch to a typed discriminated structured result
- Preserve JSON text payload for deep mode, but make structured content canonical
- Include plan stats and registration source when applicable

Correctness edge cases:
- no selected goal
- whitespace-only `planContent` falls through to standard prompt branch
- missing `planFile`
- `planFile` relative-path behavior vs stored `planDocument`
- date-derived filenames: structured output should use the actual final path, not a recomputed approximation

Important observation: there is an unused `relativePath` variable in the `planFile` branch. The plan should explicitly avoid copying such dead values into the structured contract.

## Phase 6: migrate `flywheel_approve_beads`

File:
- `mcp-server/src/tools/approve.ts`

Changes:
- Add structured contracts for both plan approval and bead approval super-modes
- Normalize every major branch into an explicit result type
- Include readiness, convergence, quality, and next-step data

Correctness edge cases:
- selected goal missing
- `br list` command failure
- `br list` parse failure
- no open beads
- plan document missing
- plan approval `reject`/`polish`/`git-diff-review`/`start`
- bead `reject`/`polish`/`advanced`/`start`
- `advanced` missing or unknown `advancedAction`
- `br ready` failure causing fallback to first three beads
- zero ready beads after fallback
- single vs parallel implementation start
- convergence score only present after 3+ rounds
- `polishConverged` depends on two consecutive zero-change rounds

Special correctness concern:
`_lastBeadSnapshot` is module-level hidden state. Structured outputs must describe only the resulting state, not assume snapshot correctness across module reloads. Tests should keep isolating module state as they already do.

## Phase 7: migrate `flywheel_review`

File:
- `mcp-server/src/tools/review.ts`

Changes:
- Add structured result unions for bead review, gates, and regressions
- Promote existing JSON text payloads to structured content
- Include next-step data for all transitions

Correctness edge cases:
- missing beadId
- bead lookup failure
- bead JSON parse failure
- already-complete bead
- skip
- looks-good with/without parent auto-close
- next step: gates vs next single bead vs next parallel beads
- hit-me agent generation
- gates first entry / repeated entry / completion after 2 clean rounds
- regression sentinels
- unknown action

## Phase 8: test expansion and contract verification

Files:
- `mcp-server/src/__tests__/tools/profile.test.ts`
- `discover.test.ts`
- `select.test.ts`
- `plan.test.ts`
- `approve.test.ts`
- `review.test.ts`
- maybe add `tool-contracts.test.ts`

Changes:
- Preserve current text assertions
- Add structuredContent assertions for all major branches
- Add a small set of schema-shape tests that ensure expected discriminants and required fields exist

Correctness checkpoints:
- state and structured output stay in lockstep
- error branches include machine-readable error codes
- JSON-in-text branches equal structured payload semantically

## File-level change map

### `mcp-server/src/types.ts`
- Expand `McpToolResult`
- Add shared tool result/error primitives
- Add tool-specific structured result interfaces/unions, or move them to a new file if this file becomes too dense

### `mcp-server/src/server.ts`
- Register output schemas/contracts alongside `inputSchema`
- Ensure request handler return type still accepts structured content

### `mcp-server/src/tools/profile.ts`
- Wrap return path(s) with structured success payload

### `mcp-server/src/tools/discover.ts`
- Wrap success and both current error returns with structured payloads

### `mcp-server/src/tools/select.ts`
- Wrap success and invalid-goal error with structured payloads

### `mcp-server/src/tools/plan.ts`
- Convert three success modes and both error paths to structured discriminated results

### `mcp-server/src/tools/approve.ts`
- Convert plan mode and bead mode to explicit structured union branches
- Optionally refactor into small result-builder helpers because this file has the highest branch count

### `mcp-server/src/tools/review.ts`
- Convert all normal/sentinel/gate branches to structured union branches

### Tests under `mcp-server/src/__tests__/tools`
- Assert `result.structuredContent`
- Assert discriminants and fields per branch
- Assert state/result coherence

## Testing strategy

### 1. Preserve all current tests

First pass should update only as needed to accommodate generic typing, but all current behavior assertions should remain.

### 2. Add structuredContent assertions per existing branch tests

Examples:

`profile.test.ts`
- assert `structuredContent.tool === "flywheel_profile"`
- assert `structuredContent.profile.name === state.repoProfile.name`
- assert `structuredContent.phaseAfter === "discovering"`

`discover.test.ts`
- success: count fields match idea array
- error: `ok === false`, `error.code === "missing_repo_profile"` or `"missing_ideas"`

`select.test.ts`
- assert trimmed `selectedGoal` in both state and structured content
- assert workflow options count and identifiers

`plan.test.ts`
- standard prompt: `resultType === "plan_prompt"`
- deep mode: `resultType === "deep_plan_spawn"`, `planAgents.length >= 3`
- plan registration: `resultType === "plan_registered"`, `source`, `stats`, `planDocument`
- error branches: stable codes

`approve.test.ts`
- single-start, parallel-start, no-open-beads, reject, polish, plan approval, git-diff-review, advanced actions
- assert `approvalTarget` plus precise `resultType`
- assert `phaseAfter` mirrors state
- assert `readyBeads`, `currentBeadId`, `agentConfigs`, convergence, quality where relevant

`review.test.ts`
- hit-me: `resultType === "review_agents_requested"`, `agentTasks.length === 5`
- looks-good all-done: `resultType === "bead_passed_all_done_enter_gates"`
- gates completion: `resultType === "flywheel_complete"`
- regression sentinels: `resultType === "phase_regressed"`

### 3. Add state/structured lockstep tests

These are high-value correctness tests:
- whenever `phaseAfter` exists, compare to `state.phase`
- whenever `currentBeadId` exists, compare to state
- whenever `planDocument` exists, compare to state
- whenever `beadResult` exists, compare to `state.beadResults[beadId]`

### 4. Add “no prose parsing required” tests

For deep plan / hit-me / parallel start branches, assert consumers can get all actionable data from `structuredContent` alone:
- plan agents available without parsing text JSON
- review agents available without parsing text JSON
- parallel bead agent configs available without parsing fenced JSON

### 5. Run focused and full tests

From `mcp-server/package.json`, the available command is `npm test` (Vitest).

Recommended execution sequence after implementation:
- focused tool suite first
- then full `npm test`

## Acceptance criteria

1. All six targeted `flywheel_*` tools return `structuredContent` on every success path.
2. All current explicit error returns in those tools also return `structuredContent` with stable `error.code` values.
3. Existing human-readable `content` remains present and semantically compatible.
4. Deep-plan, review-agent, and parallel-bead payloads are available as native objects/arrays in structured content, not only JSON strings in text.
5. `server.ts` publishes output contracts for the six tools if supported by the MCP SDK descriptor shape in this repository version.
6. Tool tests cover the new structured payloads for representative success/error branches and state-transition branches.
7. Full `mcp-server` tests pass.
8. No source files outside the MCP server flywheel contract area are changed unnecessarily.

## Risks and mitigations

### Risk 1: branch explosion creates weak unions

`flywheel_approve_beads` and `flywheel_review` have many branches. If the contract is too loose, structured output becomes misleading.

Mitigation:
- use discriminated unions with explicit `resultType`
- keep branch payloads narrow and specific
- add tests for each major branch family

### Risk 2: text and structuredContent diverge

Future edits may update prose but forget structured fields, or vice versa.

Mitigation:
- central response-builder helpers
- state/structured lockstep tests
- derive both text and structured values from the same local variables

### Risk 3: over-tight schema breaks backward compatibility

If output schemas are too strict or mandatory fields are wrong, clients may reject valid results.

Mitigation:
- keep schemas faithful to actual branch behavior
- prefer unions over one giant object with misleading required fields
- roll out optional `structuredContent` in type first, then make branch coverage complete

### Risk 4: hidden module state in approve flow

`_lastBeadSnapshot` can make refinement outputs history-sensitive.

Mitigation:
- avoid encoding assumptions about prior hidden state beyond the resulting persisted state fields
- retain test isolation with `vi.resetModules()`
- consider documenting snapshot behavior in structured fields only through persisted consequences (`polishRound`, `polishChanges`, `polishConverged`)

### Risk 5: external command failures produce underspecified errors

`br list`, `br ready`, and `br show` failures are important control-flow branches.

Mitigation:
- standardize error codes like `br_list_failed`, `br_list_parse_failed`, `br_show_failed`, `plan_file_not_found`
- include `stderr` or parse message in `error.details`

### Risk 6: SDK support uncertainty for output schemas

The repository uses `@modelcontextprotocol/sdk ^1.0.0`. Depending on local typings, tool descriptors may or may not formally expose `outputSchema`.

Mitigation:
- verify actual SDK typing before final implementation
- if direct registration is unsupported, still define internal schema constants and return structured content now
- do not block the whole migration on descriptor typing alone

## Suggested discriminant summary

For implementation clarity, keep these branch discriminants stable:

- `flywheel_profile`: `resultType = "profile_ready" | "error"`
- `flywheel_discover`: `resultType = "ideas_stored" | "error"`
- `flywheel_select`: `resultType = "goal_selected" | "error"`
- `flywheel_plan`: `resultType = "plan_prompt" | "deep_plan_spawn" | "plan_registered" | "error"`
- `flywheel_approve_beads`: `approvalTarget = "plan" | "beads"` plus per-target `resultType`
- `flywheel_review`: `resultType = "review_agents_requested" | "bead_transition" | "gate_transition" | "phase_regressed" | "already_complete" | "error"`

If desired, subtypes can refine `bead_transition` and `gate_transition`, but avoid too many near-duplicate discriminants unless tests genuinely benefit.

## Recommended implementation sequencing within files

1. Add shared types/helpers first.
2. Migrate the simplest tools first: `profile`, `discover`, `select`.
3. Migrate `plan` next because it introduces the important “JSON currently hidden in text” pattern.
4. Migrate `approve` next, because `review` depends conceptually on similar transition/result patterns.
5. Migrate `review` last.
6. Only then attach or finalize output schemas in `server.ts`, when contracts are proven by tests.

This order reduces the chance of broad type churn with unclear branch coverage.

## Definition of done

The work is done when a client can call any of the six flywheel tools and reliably determine, from `structuredContent` alone:
- what branch executed
- whether it succeeded
- what state transition occurred
- what artifact/path/bead/goal is now active
- what exact next action is expected
- what machine payload to use for agent spawning or follow-up automation

while the existing prose responses remain available for current conversational flows.