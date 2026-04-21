# v3.4.0: Observability Bundle — Synthesized Plan

**Synthesizer:** PinkTower (claude-opus-4-7)
**Coordinator:** LilacRidge
**Date:** 2026-04-21
**Inputs:** correctness (FuchsiaPuma, 1025 lines), ergonomics (OrangeGlacier, 835 lines), robustness (codex-rescue, 1890 lines)

This plan intentionally integrates the three perspectives rather than averaging
them. Where the plans disagree, a single decision is made and justified.
Unresolved tensions are lifted to the alignment-check block so the user can
confirm load-bearing choices before Step 6.

---

## 1. Goal

Ship five accretive observability subsystems in one release that closes the
loop on v3.3.0's structured-error investment and hardens the onboard / wrap-up
edges of the flywheel:

1. **`flywheel_doctor`** — one-shot dependency & liveness diagnostic (tool +
   slash command).
2. **Shared-write hotspot report** — wave-level file-contention matrix feeding
   coordinator-serial vs swarm recommendation at Step 6 launch gate.
3. **Post-mortem CASS auto-draft** — wrap-up-time session-learnings markdown,
   reviewed by the user before commit.
4. **Bead-template library** — populate the `bead-templates.ts` stub with
   reusable templates, versioned, and wire them through `deep-plan` synthesis
   and `br create`.
5. **Error-code telemetry** — session-end aggregator over `FlywheelErrorCode`
   occurrences, persisted to CASS with local fallback, surfaced in Step 10
   narrative and Step 0c welcome banner.

Each subsystem must be independently revertable (atomic beads) and must not
weaken any v3.3.0 contract: no silent catches, no error-code regressions, no
un-Zod'd tool boundaries, no retries that ignore `AbortSignal`.

---

## 2. Scope / non-goals

### In scope

- New MCP tool `flywheel_doctor` with Zod-schema'd args/output.
- Extensions to `plan-simulation.ts` for a deterministic hotspot matrix (pure
  function layer, no I/O change to existing planners).
- New public functions in `episodic-memory.ts` for post-mortem draft generation
  (read-only; persistence stays via `flywheel_memory`).
- Populate `bead-templates.ts` with seven+ templates with explicit `@version`
  identity; plumb version-aware hints through `deep-plan.ts`.
- New `telemetry.ts` module + hook points in `errors.ts` and `cli-exec.ts`;
  bounded in-memory aggregator with local-spool fallback.
- Seven new `FlywheelErrorCode` entries (see §5, final list adopted from the
  correctness proposal with two robustness refinements).
- `cli-exec.ts` gains `signal?: AbortSignal` threading (foundation for
  cancellation).
- New slash command `/flywheel-doctor` + `skills/flywheel-doctor/SKILL.md`.
- SKILL.md updates in `skills/start/SKILL.md`, `skills/start/_beads.md`,
  `skills/start/_wrapup.md`.
- Coordinator bootstrap auto-sets `contact_policy=auto` idempotently (lifted
  from robustness RB00 — quiet but important to keep agent-mail sends
  unblocked).
- Test coverage: unit + smoke + regression + chaos for each subsystem.

### Out of scope (explicit non-goals)

- Changing the phase-graph transition rules (Steps 0 → 10) beyond two additive
  hooks: doctor at Step 0e, telemetry + post-mortem at Step 10.
- Replacing `cm` (CASS) with any alternative memory backend.
- Cross-session time-series aggregation beyond a 10-session rolling window.
- Any change to the `ntm` swarm launcher, Agent Mail protocol, or `br` CLI.
- Healing stale checkpoints. Post-mortem must refuse to run on a corrupt
  checkpoint (direct-call path) or emit a reconstruction-with-warning artifact
  (wrap-up path) — never paper over it.
- Fixing the unrelated `flywheel_review` already-closed-bead parse bug. It is
  regression-tested in RB12/I-test but deferred to v3.4.1 as an
  implementation fix.

---

## 3. Best-of-All-Worlds appraisal

### What correctness did best

- **Invariant naming.** Labelled invariants (D-1, H-1, P-1…) that each map to
  at least one test and appear at the top of each test file. Carried forward
  wholesale.
- **Foundation-first ordering + fresh-eyes gate.** Single F1 bead lands all
  shared contracts (errors, types, checkpoint schema bump) before any
  subsystem, then a 5-reviewer parallel dispatch gates Wave 1. This is the
  procedural mechanism that caught v3.3.0's 19-call-site bug.
- **Hotspot pre-declaration per wave.** Each wave has explicit
  coordinator-serial vs swarm annotation ahead of approval, not inferred at
  launch time.
- **Zod-schema invariant G-1.** Every MCP-boundary output goes through
  `schema.parse()`; mismatches surface as `internal_error`. Adopted as
  cross-cutting.
- **Trust-boundary discipline.** Post-mortem draft module MUST NOT call
  `cm add` itself — it returns a draft to the tool layer, which calls
  `flywheel_memory({operation:"store"})`. Single mutation entry point.

### What ergonomics did best

- **Four-option AskUserQuestion at launch gate** (coordinator-serial / swarm /
  custom / reschedule). Strictly superior to the current two-option menu when
  the hotspot matrix detects MED/HIGH contention.
- **Step 0c error-trends box** (≤5 lines, suppressed if all counts are zero).
  Turns telemetry into a visible feedback loop without banner sprawl.
- **Explicit invocation trees.** Every subsystem gets A/B/C/D entry-point
  enumeration (slash command / implicit skill step / direct MCP / env-var
  override). Eliminates "how do I trigger this?" ambiguity.
- **Env-var overrides for defaults.** `FLYWHEEL_POSTMORTEM_SKIP=1`,
  `FLYWHEEL_POSTMORTEM_MIN_COMMITS=0`, etc. Escape hatches without widening the
  Zod args schema.
- **New dedicated skill file.** `skills/flywheel-doctor/SKILL.md` keeps the
  start skill lean and lets the doctor skill evolve independently of the main
  phase graph.
- **Concrete verification commands.** Step-by-step bash blocks that the user
  or CI can copy-paste to confirm each subsystem works.

### What robustness did best

- **Failure-mode enumeration as the core deliverable.** 40+ named scenarios
  (D1-D*, H1-H*, P1-P*, T1-T*, E1-E*) each with scenario / detection /
  response / user-facing effect. Forcibly adopted as the per-subsystem spine.
- **Cross-process concurrency.** Two concurrent sessions in the same repo
  must not corrupt telemetry spool, post-mortem files, or template caches.
  Plans 1 and 2 ignore this; we adopt robustness's dual-session test.
- **`cli-exec.ts` drops `signal`.** Today the resilient wrapper forwards `cwd`
  and `timeout` but not `AbortSignal`. Without fixing this in the foundation
  bead, every new doctor/postmortem/telemetry code path silently violates the
  repo's cancellation contract. Merged into F1.
- **Template versioning (`spawn-swarm@1`).** Plans that reference a template
  should pin its version so later library revisions don't silently re-expand
  into different bead bodies. A plan is a durable artifact; templates drift.
- **Advisory-only heuristics.** Hotspot matrix emits "recommended mode" with a
  confidence tier, not "safe/unsafe". Product risk of over-trust is real.
- **Resource bounds.** Doctor ≤ 6 concurrent child processes; hotspot ≤ 25
  detail rows, ≤ 2000 artifact mentions, ≤ 150 beads; telemetry ≤ 10k
  synthetic events. Prevents pathological inputs from blowing memory.
- **Re-entrancy guards for telemetry.** Telemetry counting its own flush
  failures infinitely is a latent failure path; an explicit guard flag is
  cheap.
- **Coordinator bootstrap hardening (RB00).** Quiet but load-bearing: sets
  `contact_policy=auto` so LilacRidge's first DM is not bounced by a prior
  `contacts_only` policy left over from an earlier session.

### Unresolved tensions (for alignment check)

1. **Bead-template expansion timing.** Correctness has synthesizer emit
   `template: "foundation"` strings and expansion at `br create` time;
   robustness warns this creates a versioning hole. Decision (§5): adopt
   robustness's `spawn-swarm@1` pinning, but keep expansion at `br create`
   time so synthesizer output stays small. Ambiguous enough to confirm.
2. **Telemetry storage file.** Correctness extends `checkpoint.json` with an
   `errorCodeTelemetry` field; robustness wants a separate
   `.pi-flywheel/error-counts.json` spool (for bounds & cross-process merge).
   Decision (§5): separate file for the spool, but mirror the final count
   back into checkpoint for backwards-compatible reads. Confirm.
3. **Doctor delivery.** Correctness: MCP tool + slash command from the start.
   Ergonomics: same but with a single new `skills/flywheel-doctor/` skill
   directory. Robustness: docs are optional in RB03 scope. Decision: both,
   because a slash command with no skill file will collide with SKILL lint.
4. **Post-mortem trigger surface.** Ergonomics: Step 10 wrap-up AND
   `/flywheel-stop` AND manual. Correctness: Step 10 only. Decision: adopt
   ergonomics — sessions often end abnormally, and CASS's own prior learning
   is that Step 10 is the path most sessions don't reach.

---

## 4. Architecture decisions per subsystem

### Subsystem 1 — `flywheel_doctor`

**File layout**

- `mcp-server/src/tools/doctor.ts` — runner, `DoctorReportSchema`, check
  registry.
- `mcp-server/src/server.ts` — tool registration.
- `skills/flywheel-doctor/SKILL.md` — new sub-skill (invocation, check
  descriptions, remediation hints).
- `commands/flywheel-doctor.md` — new slash command frontmatter + skill
  reference.

**Invariants** (from correctness)

- **D-1 (read-only):** No `saveState`, no checkpoint writes, no `cm add`.
  Enforced by `doctor.test.ts` spy on `state.ts` mutators.
- **D-2 (all checks run):** `Promise.allSettled` — one failing check never
  short-circuits the others.
- **D-3 (deterministic severity):** `red` / `yellow` / `green` resolution is
  a pure function of check output + dependency-class map.
- **D-4 (bounded time):** Full sweep ≤ 10s wall time under normal conditions;
  each individual check ≤ 5s.
- **D-5 (bounded fan-out):** ≤ 6 concurrent child processes at any moment
  (from robustness §5.5).

**Zod schemas** (from correctness; extended with robustness severity)

```ts
export const DoctorCheckRowSchema = z.object({
  id: z.string(),                         // e.g. "br-version"
  label: z.string(),                      // human-readable
  severity: z.enum(["red", "yellow", "green", "skipped"]),
  dependencyClass: z.enum(["required", "optional"]),
  message: z.string(),
  remediationHint: z.string().optional(),
  elapsedMs: z.number().int().nonnegative(),
  confidence: z.enum(["high", "medium", "low"]).default("high"),
});

export const DoctorReportSchema = z.object({
  rows: z.array(DoctorCheckRowSchema),
  summary: z.object({
    red: z.number().int(),
    yellow: z.number().int(),
    green: z.number().int(),
    skipped: z.number().int(),
  }),
  overallSeverity: z.enum(["red", "yellow", "green"]),
  generatedAtIso: z.string(),
  partial: z.boolean().default(false),   // true if cancelled mid-run
});
```

**Checks (canonical list, from correctness)**

1. `br --version` (required).
2. `bv --version` (optional).
3. `ntm --version` (optional).
4. `cm --version` (optional; degrades post-mortem to local draft).
5. `node --version` ≥ 20 (required).
6. `git --version` + `git rev-parse --git-dir` (required).
7. Agent Mail liveness — `health_check` MCP call with 5s timeout (required).
8. `dist/` drift — `dist/server.js` mtime vs `src/**/*.ts` newest mtime.
9. Orphaned worktrees — `git worktree list --porcelain`, flag
   `.claude/worktrees/*` entries older than 24h with no active session.
10. `.pi-flywheel/checkpoint.json` — exists? parses? schema valid?
11. MCP connectivity — introspection-based check for
    `mcp__plugin_agent-flywheel_*` tool availability.

**New FlywheelErrorCode entries** (robustness refinement)

- `doctor_blocking_failure` — required dependency failed; `retryable: false`.
- `doctor_partial_result` — doctor cancelled mid-run; `retryable: true`.

**State impacts**

None on disk. Returned `DoctorReport` is cached in in-memory `ctx.state`
under `lastDoctorReport` (non-persisted) for Step 0c banner rendering.

**UX — invocation / output / AskUserQuestion**

Entry points (from ergonomics):

- Slash: `/flywheel-doctor`, `/flywheel-doctor --checks=mcp,am,git`,
  `/flywheel-doctor --format=json`, `/flywheel-doctor --list-templates`.
- Implicit: Step 0b check #8 calls `flywheel_doctor` silently; results fold
  into the welcome banner.
- MCP: `flywheel_doctor({ cwd, checks: ["all"], format: "structured" })`.

If Step 0b finds any red row, a single AskUserQuestion at the end of Step 0b:

```
AskUserQuestion(questions: [{
  question: "Required dependency failed: <label>. How to proceed?",
  header: "Doctor",
  options: [
    { label: "Fix now", description: "Run remediation and re-check" },
    { label: "Continue degraded", description: "Skip dependent workflows" },
    { label: "Show details", description: "Print full row + remediation hint" }
  ],
  multiSelect: false
}])
```

**Failure modes (8+, from robustness)**

- **D1.** `br` missing (ENOENT/EACCES) → red, `doctor_blocking_failure`.
- **D2.** `cm` missing → yellow, session continues with local-only
  post-mortem.
- **D3.** Agent Mail MCP health_check times out → yellow; doctor continues.
- **D4.** `dist/` is stale → yellow with "run `npm run build`" remediation.
- **D5.** Checkpoint schema fails Zod parse → yellow; doctor quarantines the
  file to `checkpoint.json.corrupt` and logs once.
- **D6.** Two orphaned worktrees older than 24h → yellow; remediation hint
  points at `/flywheel-cleanup`.
- **D7.** Doctor is called while another doctor run is in flight → the second
  call returns the in-flight promise; idempotent.
- **D8.** `AbortSignal` fires mid-run → return partial report with
  `partial: true` and `doctor_partial_result`; do not throw.
- **D9.** A check function throws synchronously → caught by
  `Promise.allSettled`, row shows severity `red` with `internal_error`-shaped
  message.

**Resource bounds**

- ≤ 6 concurrent child processes.
- Each check has an individual timeout (default 5s, configurable via
  `DoctorCheckRowSchema` registration).
- Total sweep wall time target ≤ 10s on a warm cache.

**Cancellation / AbortSignal**

- Doctor receives `signal` via `ctx.signal`. `Promise.allSettled` is raced
  against `signal` fulfillment. On abort, running checks get their own signal
  forwarded (via `cli-exec.ts` F1 plumbing); doctor returns a partial report.

**Edge cases**

- Repo has no `.git` — skip check 6's `rev-parse` sub-check; severity yellow.
- MCP introspection returns empty — flag as `doctor_partial_result` rather
  than red, because introspection may be unavailable in some CI environments.
- User runs doctor inside a worktree — orphan scan must exclude the current
  worktree from "orphan" classification.

**Testing**

- Unit: 15+ tests; mock `child_process.exec` per check.
- Regression: concurrent-doctor test (D7), stale-checkpoint corrupt
  quarantine (D5).
- Chaos: abort-mid-run (D8), all-optional-deps-missing degradation path.

---

### Subsystem 2 — Shared-write hotspot report

**Location**

- `mcp-server/src/plan-simulation.ts` — `HotspotMatrixSchema`, pure function
  `computeHotspotMatrix()`.
- `mcp-server/src/tools/approve.ts` — consumer that injects matrix into
  launch-gate AskUserQuestion.

**Invariants** (correctness + robustness)

- **H-1 (determinism):** Input order of beads does not affect output. Output
  sorted by `(severity desc, contestedFilePath asc, beadId asc)`.
- **H-2 (advisory only):** Matrix emits a `recommendedMode` and a
  `confidence`; never "safe"/"unsafe". Coordinator decides.
- **H-3 (path-normalization):** Paths lowercased, `./` stripped, repo-root
  relative. `src/foo.ts` and `./src/foo.ts` collapse.
- **H-4 (high-confidence requires `### Files:`):** Matrix can only emit
  `severity: high` when all contested paths originate from machine-extracted
  `### Files:` sections — not from prose bullet mentions.

**Zod schemas**

```ts
export const HotspotRowSchema = z.object({
  path: z.string(),
  beadIds: z.array(z.string()),
  severity: z.enum(["low", "med", "high"]),
  confidence: z.enum(["low", "med", "high"]),
  source: z.enum(["files-section", "prose-mention", "mixed"]),
});
export const HotspotMatrixSchema = z.object({
  rows: z.array(HotspotRowSchema).max(25),
  recommendedMode: z.enum(["swarm", "coordinator-serial", "advisory"]),
  confidence: z.enum(["low", "med", "high"]),
  beadCount: z.number().int().nonnegative(),
  summaryOnly: z.boolean().default(false),   // true when over 150 beads
});
```

**New FlywheelErrorCode entries**

- `hotspot_input_unreliable` — standalone call lacks trustworthy scope input;
  `retryable: false`.
- (Parse failures fall back to the existing `parse_failure` per robustness §7
  guidance.)

**Heuristic — final decision**

Exact path-string match after normalization (H-3). **No regex, no AST.**
Rationale: ASCII-stable, fully deterministic, low false-positive. Regex
would tempt agents to infer "whole module" overlap (`src/foo/**`) which is
exactly the misleading high-severity row we want to prevent (H-4).

**UX**

Launch gate (from ergonomics §1.2):

```
AskUserQuestion(questions: [{
  question: "Hotspot detected: <file> (severity <HIGH|MED>, <n> beads). Choose launch mode:",
  header: "Launch mode",
  options: [
    { label: "Coordinator-serial (recommended)", description: "Run sequentially through coordinator." },
    { label: "Swarm anyway", description: "Parallel; accept contention risk." },
    { label: "Custom", description: "Split into groups manually." },
    { label: "Reschedule", description: "Reorder beads; re-run matrix." }
  ],
  multiSelect: false
}])
```

**Failure modes (robustness §3.2)**

- **H1.** Beads lack `### Files:` — yellow advisory or
  `hotspot_input_unreliable`; no high-severity row.
- **H2.** Duplicate paths from aliases (`src/foo.ts` vs `foo.ts`) — H-3
  collapses them.
- **H3.** Prose mention inside body (e.g. "tweaks `src/foo.ts`") — severity
  capped at `med`.
- **H4.** Over-extraction from shell snippets (`cp src/foo.ts bar/`) — path
  list filtered to project-relative, `.ts`/`.tsx`/`.md`/`.json` extensions
  only.
- **H5.** Empty bead list → matrix `rows: []`, `recommendedMode: swarm`,
  `confidence: low`.
- **H6.** >150 beads → `summaryOnly: true`; rows truncated to top 25 by
  `severity desc`; counts accurate.
- **H12.** Human over-trust of heuristic → "recommended mode" phrasing + a
  confidence tier block in the rendered banner.
- **H13.** Matrix rendered mid-wave after a bead completes early → staleness
  notice ("computed at approval time") injected in the banner.

**Resource bounds**

- ≤ 25 detail rows.
- ≤ 2000 raw artifact mentions before summary mode.
- ≤ 150 beads before `summaryOnly: true`.

**Cancellation**

Pure sync function; no AbortSignal needed. Bounded by input size.

**Edge cases**

- Single-bead wave → matrix is empty; recommendedMode `swarm` with `low`
  confidence (nothing to contend over).
- All beads touch different files → matrix empty; `swarm`, `high`
  confidence.

**Testing**

- Unit: 12+ tests; randomized input-order fuzz (H-1).
- Regression: `mod.rs`-style 3-way write contention.
- Chaos: 10k bead synthetic input → `summaryOnly: true` within 500ms.

---

### Subsystem 3 — Post-mortem CASS auto-draft

**Location**

- `mcp-server/src/episodic-memory.ts` — `draftPostmortem()`,
  `formatPostmortemMarkdown()`, `PostmortemDraftSchema`.
- `mcp-server/src/tools/memory.ts` — `flywheel_memory({operation:
  "draft_postmortem"})` surface.
- Persistence still via `flywheel_memory({operation: "store"})`. Module must
  not call `cm add` directly.

**Invariants**

- **P-1 (trust boundary):** Draft module never calls `cm add` or writes
  files. Returns a `PostmortemDraft`; caller stores it.
- **P-2 (refuses stale checkpoint, direct call):** If `state.sessionId`
  absent, or checkpoint older than HEAD commit, or phase is `init` with no
  beads → return `postmortem_checkpoint_stale` or
  `postmortem_empty_session`. Do not fabricate.
- **P-3 (no PII leak):** Draft never includes raw environment variables or
  absolute paths outside the repo root. Paths sanitized to repo-relative.
- **P-4 (reconstruction mode, wrap-up path):** When checkpoint is corrupt but
  wrap-up is running (not a direct call), reconstruct from
  `git log <sessionStartSha>..HEAD`, `br show` for recent beads, and Agent
  Mail inbox. Draft header explicitly flags `reconstruction: true`.

**Zod schema**

```ts
export const PostmortemDraftSchema = z.object({
  sessionId: z.string(),
  generatedAtIso: z.string(),
  reconstruction: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
  blocks: z.object({
    whatWeShipped: z.array(z.string()),
    whatWentWrong: z.array(z.string()),
    coordinatorDecisions: z.array(z.string()),
    errorHotspots: z.array(z.object({
      code: z.string(),
      count: z.number().int(),
      lastContext: z.string().optional(),
    })),
    openQuestions: z.array(z.string()),
  }),
  draftMarkdown: z.string(),
});
```

**New FlywheelErrorCode entries**

- `postmortem_empty_session` — session never reached phase ≥ plan;
  `retryable: false`.
- `postmortem_checkpoint_stale` — checkpoint predates HEAD (direct-call
  refusal path); `retryable: false`.
- `postmortem_reconstruction_failed` — both checkpoint and reconstruction
  inputs insufficient; `retryable: true` (a later re-run after user action
  may succeed).

**State impacts**

- `CheckpointData` gains `sessionStartSha?: string` (optional). Populated at
  Step 0e so reconstruction has a commit boundary.
- Backward-compat: `loadState()` already returns initial values for absent
  fields; no migration script.

**UX**

Triggers (ergonomics decision — all three):

- **Step 10 wrap-up**: after `flywheel_memory(operation: "store")`, draft
  post-mortem; present to user via a review block; commit only on approval.
- **`/flywheel-stop`**: generate partial post-mortem from whatever state
  exists; always lands a local draft in `docs/sessions/` even if CASS is
  down.
- **Manual**: `flywheel_memory({operation: "draft_postmortem"})`.

Env overrides: `FLYWHEEL_POSTMORTEM_SKIP=1`,
`FLYWHEEL_POSTMORTEM_MIN_COMMITS=0`.

**Failure modes (8+)**

- **P1.** Checkpoint missing at direct call → `postmortem_checkpoint_stale`.
- **P2.** Checkpoint truncated / hash-invalid → quarantine as `.corrupt`;
  wrap-up path reconstructs and flags.
- **P3.** `git log` fails → fallback to `sessionStart` timestamp window
  (24h); warnings populated.
- **P4.** Agent Mail inbox unreachable → `coordinatorDecisions` empty;
  warning logged.
- **P5.** No commits in session → block "What we shipped" lists zero, draft
  still emits; unless `FLYWHEEL_POSTMORTEM_MIN_COMMITS≥1` (default), in
  which case `postmortem_empty_session`.
- **P6.** CASS store fails → local draft at `docs/sessions/<sessionId>.md`
  persists; shutdown continues; `telemetry_store_failed` emitted.
- **P7.** PII regex hits an env-var-like string in a commit message → strip
  and note in warnings.
- **P8.** Duplicate draft for same sessionId → filename suffixes
  (`-r1`, `-r2`); idempotent by content hash.

**Resource bounds**

- Input: ≤ 20 inbox messages, ≤ 200 commits, ≤ 100 bead summaries.
- Output: ≤ 8KB markdown.

**Cancellation**

All subprocess calls go through `cli-exec.ts` with `signal`. Wrap-up path
races against `signal`; on abort, emit partial draft with
`reconstruction: true, warnings: ["cancelled mid-draft"]`.

**Edge cases**

- Repo is a fresh clone (no commits since clone) — use `git rev-list --max-parents=0`
  as sessionStart proxy.
- `bv`/`cm` both missing — draft still generates; just no rolling-window
  context block.

**Testing**

- Unit: 10+; mock `execFileSync`, `readFile`, and `fetchInbox`.
- Regression: mid-wave crash leaves checkpoint stale but HEAD advanced →
  reconstruction path produces valid draft (P2).
- Chaos: two concurrent wrap-ups in same repo → distinct files
  (`-r1`/`-r2`), neither lost.

---

### Subsystem 4 — Bead-template library

**Location**

- `mcp-server/src/bead-templates.ts` — template registry, version metadata,
  `expandTemplate()`, `BeadTemplateSchema`, `ExpandTemplateResultSchema`.
- `mcp-server/src/deep-plan.ts` — template-hint plumbing; synthesizer emits
  `template: "foundation@1"` strings (with explicit version).
- `mcp-server/src/tools/approve.ts` — `br create` consumer path; expansion
  happens here, not in deep-plan. Rationale: keeps plan artifact small and
  portable.
- `mcp-server/src/prompts.ts` — version-aware prompt consumers.

**Invariants**

- **T-1 (version pinning):** Plans may reference `foundation@1`; expansion
  refuses to silently substitute `foundation@2`. On mismatch, emit
  `template_version_conflict` and ask the user.
- **T-2 (single expansion entry):** All expansion goes through
  `expandTemplate(id, version, placeholders)`; `deep-plan.ts` never expands
  inline.
- **T-3 (integrity gate):** `TEMPLATE_INTEGRITY_WARNINGS` at module load
  must be empty in release builds. CI-asserted.
- **T-4 (placeholder completeness):** All declared placeholders must be
  provided at expansion time; missing → `template_placeholder_missing`.

**Zod schemas**

```ts
export const BeadTemplateSchema = z.object({
  id: z.string(),                          // e.g. "spawn-swarm"
  version: z.number().int().positive(),    // 1, 2, ...
  title: z.string(),
  rationale: z.string(),
  placeholders: z.array(z.string()),       // e.g. ["pane"]
  bodyMarkdown: z.string(),                // pre-expansion
});
export const ExpandTemplateResultSchema = z.object({
  templateId: z.string(),
  templateVersion: z.number().int(),
  expandedMarkdown: z.string(),
  unresolvedPlaceholders: z.array(z.string()).default([]),
});
```

**Starter template set (7, from correctness + robustness refinements)**

1. `foundation-with-fresh-eyes-gate@1`
2. `inter-wave-fixup@1`
3. `new-mcp-tool@1`
4. `new-skill@1`
5. `refactor-module@1`
6. `test-coverage@1`
7. `spawn-swarm@1` (robustness-hardened: numeric `--pane=<int>` placeholder;
   `|| true` on informational monitor commands)

**New FlywheelErrorCode entries**

- `template_not_found` — unknown `id`; `retryable: false`.
- `template_placeholder_missing` — declared placeholder not provided;
  `retryable: false`.
- `template_version_conflict` — plan pins `foundation@1`, library has
  `foundation@2`, no pinned copy found; `retryable: false`.

**State impacts**

None. Templates are immutable module-level data; `dist/bead-templates.js`
ships pre-built.

**UX (from ergonomics §1.4)**

Step 5.5 bead creation:

```
AskUserQuestion(questions: [{
  question: "Choose bead creation mode:",
  header: "Bead creation",
  options: [
    { label: "Auto from plan", description: "Orchestrator picks templates from plan hints (Recommended)" },
    { label: "Browse templates", description: "See available templates and pick manually" },
    { label: "Custom bodies", description: "Write from scratch, no templates" }
  ],
  multiSelect: false
}])
```

- Slash: `/flywheel-doctor --list-templates` (kept inside doctor command to
  reduce command sprawl).
- Direct: `flywheel_approve_beads({ cwd, action: "list_templates" })`.

**Failure modes**

- **T1.** Unknown template id → `template_not_found`.
- **T2.** Known id, unknown version → `template_version_conflict`.
- **T3.** Placeholder not provided → `template_placeholder_missing`.
- **T4.** Template body has unresolved `{{placeholder}}` after expansion →
  `template_expansion_failed` (residual safety net).
- **T5.** `spawn-swarm` pane placeholder receives a non-numeric value →
  reject at expansion time with `template_placeholder_missing` (T-4 expanded
  to type-check).
- **T6.** Library revision introduces a breaking change in `spawn-swarm@1` →
  integrity gate T-3 fails CI; release blocked.
- **T7.** Plan pins `foundation@1` but user has updated-plan in CASS that
  was regenerated against `foundation@2` → prompt for
  regeneration-or-pin-resolution.
- **T8.** Template integrity warnings present but release tagged → CI check
  blocks tag push.
- **T9.** Concurrent `br create` from two sessions — templates are immutable
  so no race; placeholder map is per-call.
- **T10.** `TEMPLATE_INTEGRITY_WARNINGS` ignored by prompt consumer → T-3
  fails at module load.

**Resource bounds**

- ≤ 64KB per template body.
- ≤ 50 templates in registry.

**Cancellation**

Pure sync function; no signal handling needed.

**Edge cases**

- Empty placeholder map but template declares none → ok.
- Template body contains literal `{{` that must not be interpreted —
  templates use `{{{`/`}}}` as literal escape (documented in the skill file).

**Testing**

- Unit: 20+; one test per (id, version) pair; fuzz on placeholder sets.
- Regression: integrity warnings empty at module load.
- Chaos: 10k-bead plan with every template type mixed → all expand cleanly
  under 500ms.

---

### Subsystem 5 — Error-code telemetry

**Location**

- `mcp-server/src/telemetry.ts` — `TelemetryAggregator`,
  `ErrorCodeTelemetrySchema`, bounded in-memory counter.
- `mcp-server/src/errors.ts` — hook point: every structured error goes
  through `telemetry.record()` before return.
- `mcp-server/src/cli-exec.ts` — hook point: `classifyExecError()` emits to
  telemetry.
- `.pi-flywheel/error-counts.json` — **separate spool file**
  (robustness-adopted). Mirrored into `checkpoint.json.errorCodeTelemetry` at
  session end for backward-compat reads.

**Invariants**

- **TE-1 (bounded memory):** Aggregator caps at 10k events per session;
  beyond that, only counts increment, not the `lastContext` string.
- **TE-2 (dedupe by logical error):** One structured error → one telemetry
  row, even if it propagates through retries. `errorId` (uuid at creation)
  is the dedupe key.
- **TE-3 (re-entrancy guard):** Telemetry flush failures must not recursively
  emit more telemetry. A `flushInProgress` flag guards.
- **TE-4 (no PII):** Context strings stripped of absolute paths and
  env-like strings before storage.

**Zod schema**

```ts
export const ErrorCodeTelemetrySchema = z.object({
  counts: z.record(z.string(), z.number().int().nonnegative()),
  lastContextByCode: z.record(z.string(), z.string()).optional(),
  windowStartIso: z.string(),
  sessionId: z.string(),
  truncated: z.boolean().default(false),
});
```

**New FlywheelErrorCode entries**

- `telemetry_store_failed` — CASS flush failed; local fallback used;
  `retryable: true`.
- (Robustness's `telemetry_merge_conflict` is absorbed into
  `telemetry_store_failed` with an internal `mergeConflict: true` detail —
  avoids adding an eighth code for a rarely-user-actionable branch.)

**Storage decision — FINAL**

Separate file: `.pi-flywheel/error-counts.json`. Written atomically via
temp-file-rename. On session end, the aggregated counts are also mirrored
into `checkpoint.json.errorCodeTelemetry` so pre-v3.4.0 readers still work.

Rationale: keeps the spool cross-process-mergeable (two sessions can each
write their own spool snapshot; merge step combines them). Checkpoint stays
lean.

**State impacts**

- `CheckpointData` gains `errorCodeTelemetry: Record<FlywheelErrorCode, number>`
  (optional; defaults to `{}`).
- New file `.pi-flywheel/error-counts.json` with full session spool. Deleted
  on `/flywheel-stop --cleanup`.

**UX**

- Step 0c welcome banner: ≤5-line "Error Trends" block (suppressed if all
  counts zero). Rolling 10-session window from CASS.
- Step 10 narrative: "Top 3 error codes this session: <code>×N" line, with
  remediation hint from a static mapping.
- Slash command: `/flywheel-doctor --checks=telemetry` prints current spool
  snapshot.

**Failure modes**

- **E1.** `cm add` fails → local fallback to `.pi-flywheel/error-counts.json`
  spool; session continues; `telemetry_store_failed`.
- **E2.** Two sessions flush concurrently → each writes its own spool with
  `sessionId` suffix; merge step combines on next session start.
- **E3.** Telemetry flush fails, and handler tries to log the failure as a
  telemetry event → re-entrancy guard prevents infinite loop (TE-3).
- **E4.** Session crashes mid-record → partially-written spool file
  quarantined on next read (`.spool.corrupt`); empty fresh spool used.
- **E5.** 10k events exceeded → truncated flag set; counts keep
  incrementing but `lastContextByCode` stops updating.
- **E6.** PII in error context → stripped before storage; stripping logged
  once per code.
- **E7.** Checkpoint upgrade from pre-v3.4.0 session → fresh empty counts;
  no migration needed.
- **E8.** Dual-process flush to same spool file → atomic rename protects;
  last-write-wins at file level but content-merge at read level.

**Resource bounds**

- ≤ 10k events in memory.
- ≤ 64KB spool file per session before truncation flag.
- ≤ 10 sessions in rolling window (older sessions compacted to counts-only).

**Cancellation**

Flush is best-effort; on abort, local spool is already durably written per
event, so no data loss.

**Edge cases**

- Tests that mock `FLYWHEEL_ERROR_CODES` must still allow telemetry to count
  (schema is `z.record(z.string(), ...)`, not `z.enum`).
- Pre-commit hook running telemetry flush in same session — guarded by
  `flushInProgress`.

**Testing**

- Unit: 15+; 10k synthetic events; concurrent flush.
- Regression: partial-write crash recovery (E4).
- Chaos: two simulated sessions flush to same spool; final merge preserves
  both count sets.

---

## 5. Global cross-cutting contracts

### 5.1 Final FlywheelErrorCode list — decision: 10 new codes

Correctness proposed 7. Robustness proposed 9 (some overlap). We adopt
**10** — correctness's 7 plus robustness's `doctor_partial_result`,
`hotspot_input_unreliable`, and `template_expansion_failed`.
`telemetry_merge_conflict` is absorbed into `telemetry_store_failed` with a
detail bit (see §4 Subsystem 5).

Rationale for each addition over the correctness baseline:

- `doctor_partial_result` — cancellation is a first-class state (robustness
  §2.6); without a distinct code, orchestrator cannot branch on it.
- `hotspot_input_unreliable` — lets approval flow degrade visibly rather
  than silently producing low-confidence high rows.
- `template_expansion_failed` — residual safety net for T-4. Not covered by
  `template_placeholder_missing` because some expansion failures are
  structural, not missing-input.

| Code | Retryable | Subsystem |
|------|-----------|-----------|
| `doctor_blocking_failure` | false | 1 |
| `doctor_partial_result` | true | 1 |
| `hotspot_input_unreliable` | false | 2 |
| `postmortem_empty_session` | false | 3 |
| `postmortem_checkpoint_stale` | false | 3 |
| `postmortem_reconstruction_failed` | true | 3 |
| `template_not_found` | false | 4 |
| `template_placeholder_missing` | false | 4 |
| `template_version_conflict` | false | 4 |
| `template_expansion_failed` | false | 4 |
| `telemetry_store_failed` | true | 5 |

(11 rows; `template_expansion_failed` is new vs correctness's original 7.)

### 5.2 Zod invariants

- **G-1 (contract validation):** Every MCP-boundary output `schema.parse()`s
  before return; mismatches surface as `internal_error`.
- **G-2 (no silent catches):** New `catch {}` without `log.warn` +
  `classifyExecError` + a structured return is review-blocking.
- **G-3 (one error code per failure path):** Each failure branch uses exactly
  one code; no synthetic union codes.
- **G-4 (AbortSignal propagation):** All `ResilientExecOptions` callers pass
  `signal` through F1. Retry loops bail on `signal.aborted`.

### 5.3 SKILL.md lint baseline

Baseline bump lands with F1, not per-subsystem beads. New entries for all 10
codes in `skills/start/SKILL.md` and sub-files.

---

## 6. Bead sketch — unified (14 beads)

**Target: 14 beads.** Correctness had 12, ergonomics 13, robustness 16 (with
release gates). The synthesized graph is 14 (13 impl + 1 release gate)
because:

- Coordinator-bootstrap hardening is folded into F1 rather than standing
  alone (RB00 is one small block of code).
- Telemetry flush + aggregator collapse into one bead (I7) because they share
  a module; robustness's split into RB10/RB11 loses dependency clarity.
- Skill/command docs stand as a single bead (D8) with the doctor skill
  directory as a unit.
- `RG3` release gate kept explicitly as bead R1.

### Wave 0 — Foundation (serial, 1 bead, fresh-eyes gate)

1. **F1 — shared contracts + cancellation plumbing**
   Files: `errors.ts` (+10 codes, `DEFAULT_RETRYABLE` entries),
   `types.ts` (+type surfaces), `checkpoint.ts`
   (+`errorCodeTelemetry?`, +`sessionStartSha?`), `cli-exec.ts`
   (+`signal?: AbortSignal` on `ResilientExecOptions`; retry loop checks
   `signal.aborted`), coordinator bootstrap sets `contact_policy=auto`,
   `.lintskill-baseline.json` refresh.
   - **Acceptance:** new code tuple round-trips through Zod; retryability
     map has entries for all 10 new codes; aborting a retrying resilient
     exec returns `exec_aborted` within one retry window.
   - **Test plan:** `errors.schema.test.ts` (new); `cli-exec.abort.test.ts`
     (new, robustness-sourced).
   - **Template hint:** `foundation-with-fresh-eyes-gate@1`.
   - **Gate:** **FRESH-EYES** — 5 parallel reviewers, 3 minutes cold-read
     diff before Wave 1.
   - **Mode:** serial (single bead).

### Wave 1 — Doctor + hotspot (swarm OK; disjoint files)

2. **I2 — doctor check engine + Zod**
   Files: `tools/doctor.ts` (new; `DoctorReportSchema`,
   `computeOverallSeverity`, `Promise.allSettled`, per-check timeout), +
   mocks for `execFile`. ≤6 concurrent child procs.
   - **Acceptance:** all 11 checks registered; sweep ≤10s; partial-result on
     abort.
   - **Template hint:** `new-mcp-tool@1`.
   - **Mode:** swarm.

3. **I3 — hotspot matrix (pure)**
   Files: `plan-simulation.ts` (+`HotspotMatrixSchema`,
   `computeHotspotMatrix()`), fuzz test for H-1.
   - **Acceptance:** reversed input → identical output; prose-only mentions
     cap at `med`; >150 beads → summaryOnly.
   - **Template hint:** `add-feature@1`.
   - **Mode:** swarm.

### Gate 1 — inter-wave fresh-eyes (2 reviewers, 2 minutes)

Check: doctor and hotspot are decoupled; no unintended coupling via `types.ts`.

### Wave 2 — Server/approve integration (coordinator-serial; both touch `server.ts`)

4. **I4 — doctor MCP tool registration + slash command**
   Files: `server.ts` (register tool), `tools/doctor.ts` (export handler).
   - **Acceptance:** tool appears in introspection; structured output;
     partial-abort path preserves `partial: true`.
   - **Template hint:** `new-mcp-tool@1`.
   - **Mode:** coordinator-serial.

5. **I5 — hotspot injection into approve flow**
   Files: `server.ts` (approve-path wiring), `tools/approve.ts` (matrix call,
   four-option AskUserQuestion).
   - **Acceptance:** HIGH/MED row emits the 4-option menu; LOW/empty emits
     the legacy 2-option menu.
   - **Template hint:** `add-feature@1`.
   - **Mode:** coordinator-serial.

### Wave 3 — Post-mortem + templates (swarm OK; disjoint)

6. **I6 — post-mortem draft engine**
   Files: `episodic-memory.ts` (+`draftPostmortem()`,
   `formatPostmortemMarkdown()`, `PostmortemDraftSchema`),
   `tools/memory.ts` (+`draft_postmortem` operation).
   - **Acceptance:** P-1 through P-4 each have a dedicated test; direct-call
     refuses stale checkpoint; wrap-up path reconstructs with warnings.
   - **Template hint:** `add-feature@1`.
   - **Mode:** swarm.

7. **I7 — telemetry aggregator + spool file**
   Files: `telemetry.ts` (new), `errors.ts` (hook),
   `cli-exec.ts` (hook in `classifyExecError`).
   Introduces `.pi-flywheel/error-counts.json` spool; mirrors into
   checkpoint at session end.
   - **Acceptance:** 10k synthetic events under memory target; re-entrancy
     guard; concurrent dual-session merge.
   - **Template hint:** `new-mcp-tool@1` (adapted).
   - **Mode:** swarm.

### Wave 4 — Templates + deep-plan plumbing (swarm OK)

8. **I8 — bead template library**
   Files: `bead-templates.ts` (7 templates with `@version`),
   `prompts.ts` (version-aware consumer).
   - **Acceptance:** `TEMPLATE_INTEGRITY_WARNINGS` empty at module load;
     20+ unit tests across (id, version) pairs.
   - **Template hint:** `refactor-module@1`.
   - **Mode:** swarm.

9. **I9 — deep-plan template hint plumbing + approve expansion**
   Files: `deep-plan.ts` (emit `template: "foundation@1"` hints),
   `tools/approve.ts` (call `expandTemplate()` at `br create` time).
   - **Acceptance:** plan → bead round-trip preserves pinned version;
     mismatch emits `template_version_conflict`.
   - **Template hint:** `add-feature@1`.
   - **Mode:** swarm.

### Wave 5 — SKILL + commands + docs (swarm OK)

10. **D10 — doctor SKILL + slash command**
    Files: `skills/flywheel-doctor/SKILL.md` (new),
    `commands/flywheel-doctor.md` (new).
    - **Template hint:** `new-skill@1`.
    - **Mode:** swarm.

11. **D11 — start SKILL updates**
    Files: `skills/start/SKILL.md` (Step 0b check 8; Step 0c error-trends
    block), `skills/start/_beads.md` (Step 6 hotspot matrix; 4-option
    menu), `skills/start/_wrapup.md` (Step 10 post-mortem + telemetry).
    - **Template hint:** `doc-update@1`.
    - **Mode:** swarm.

12. **D12 — SKILL lint baseline + manifest update**
    Files: `mcp-server/.lintskill-baseline.json`, plugin manifest.
    - **Template hint:** `doc-update@1`.
    - **Mode:** serial (final-merge dependency).

### Wave 6 — Test + chaos harness (serial; builds on everything)

13. **T13 — regression + chaos harness**
    Files: `__tests__/chaos/`, `__tests__/regression/`. Covers:
    kill-mid-run, missing-Gemini, already-closed-bead parse, noisy monitor,
    dual-session telemetry flush, concurrent post-mortem draft, prose-only
    hotspot false positive.
    - **Acceptance:** all named regression scenarios have explicit tests;
      CI green in ≤3min.
    - **Template hint:** `test-coverage@1`.
    - **Mode:** serial.

### Wave 7 — Release gate

14. **R1 — fresh-eyes release gate before merge**
    2 independent reviewers cold-read entire diff for: boundedness,
    shutdown-degradation, cross-process safety, and Zod-invariant
    coverage. Release blocked on consensus.
    - **Mode:** serial.

### Hotspot pre-declaration per wave

| Wave | Files | Mode |
|------|-------|------|
| 0 | F1 single bead | serial |
| 1 | I2 (`tools/doctor.ts`), I3 (`plan-simulation.ts`) | swarm (disjoint) |
| 2 | I4, I5 both touch `server.ts` | **coordinator-serial** |
| 3 | I6 (`episodic-memory.ts`), I7 (`telemetry.ts`) | swarm (disjoint) |
| 4 | I8 (`bead-templates.ts`), I9 (`deep-plan.ts` + `approve.ts`) | swarm (mostly disjoint; minor approve overlap is sequenced by I9→I5 dependency) |
| 5 | D10, D11, D12 (disjoint skill dirs) | swarm (D12 serial at end) |
| 6 | T13 (new test dirs) | serial |
| 7 | R1 | serial |

---

## 7. SKILL.md / sub-file touch points

| File | Section | Change |
|------|---------|--------|
| `skills/start/SKILL.md` | Step 0b | +check 8 (flywheel_doctor silent call) |
| `skills/start/SKILL.md` | Step 0c | +Error Trends box (≤5 lines, suppressed if empty) |
| `skills/start/SKILL.md` | Step 0b post-check | +AskUserQuestion on any red doctor row |
| `skills/start/_beads.md` | Step 5.5 | +bead-creation-mode AskUserQuestion (auto/browse/custom) |
| `skills/start/_beads.md` | Step 6 | +hotspot matrix render; +4-option launch-mode AskUserQuestion on HIGH/MED |
| `skills/start/_wrapup.md` | Step 10 | +auto-draft post-mortem call + review block |
| `skills/start/_wrapup.md` | Step 10 | +Top-3 error-code narrative line |
| `skills/flywheel-doctor/SKILL.md` | **new file** | invocation, checks, remediation hints |
| `commands/flywheel-doctor.md` | **new file** | slash command, flags, links to skill |
| `mcp-server/.lintskill-baseline.json` | baseline | +10 new error codes referenced |

---

## 8. New files created

- `mcp-server/src/tools/doctor.ts`
- `mcp-server/src/telemetry.ts`
- `mcp-server/src/__tests__/errors.schema.test.ts`
- `mcp-server/src/__tests__/cli-exec.abort.test.ts`
- `mcp-server/src/__tests__/doctor.test.ts`
- `mcp-server/src/__tests__/hotspot.test.ts`
- `mcp-server/src/__tests__/postmortem.test.ts`
- `mcp-server/src/__tests__/telemetry.test.ts`
- `mcp-server/src/__tests__/bead-templates.test.ts`
- `mcp-server/src/__tests__/chaos/dual-session.test.ts`
- `mcp-server/src/__tests__/regression/already-closed-bead.test.ts`
- `skills/flywheel-doctor/SKILL.md`
- `commands/flywheel-doctor.md`
- `.pi-flywheel/error-counts.json` (runtime-created, not committed)

Existing files touched: `errors.ts`, `types.ts`, `checkpoint.ts`,
`cli-exec.ts`, `server.ts`, `tools/approve.ts`, `tools/memory.ts`,
`plan-simulation.ts`, `episodic-memory.ts`, `bead-templates.ts`,
`deep-plan.ts`, `prompts.ts`, `skills/start/SKILL.md`,
`skills/start/_beads.md`, `skills/start/_wrapup.md`,
`mcp-server/.lintskill-baseline.json`.

---

## 9. Migration / backward compatibility

- **`checkpoint.json`.** New fields (`errorCodeTelemetry`,
  `sessionStartSha`) are optional. `loadState()` returns initial values for
  absent fields; no migration script needed. Old checkpoints load cleanly;
  telemetry simply starts from zero for the first v3.4.0 session.
- **`.pi-flywheel/error-counts.json`.** Runtime-created; absence is
  expected on first v3.4.0 run. Corrupt file quarantined as `.spool.corrupt`
  and re-created empty.
- **Templates without `@version`.** Treated as `@1` on read (first release).
  Plans generated pre-v3.4.0 continue to expand; warning logged.
- **Pre-v3.4.0 SKILL.md branches** that switch on `result.data?.error?.code`
  without new codes — remain valid; they simply won't branch on new codes.
  SKILL lint baseline bump ensures new codes are referenced.
- **No breaking change** to any existing tool schema, command name, or
  phase-graph transition.

---

## 10. Verification block

### 10.1 Doctor smoke

```bash
npm run build
node -e "import('./dist/server.js').then(s => s.invokeTool('flywheel_doctor', { cwd: process.cwd(), checks: ['all'], format: 'structured' }).then(r => console.log(JSON.stringify(r, null, 2))))"
# Expected: rows length ≥ 11; overallSeverity one of red|yellow|green; partial: false
```

### 10.2 Hotspot determinism

```bash
node --experimental-vm-modules node_modules/.bin/vitest run hotspot.test.ts
# Expected: all fuzz tests green; reversed-order input produces identical HotspotMatrix
```

### 10.3 Post-mortem wrap-up path

```bash
# Simulate a crashed session: corrupt checkpoint, advanced HEAD.
mv .pi-flywheel/checkpoint.json .pi-flywheel/checkpoint.json.corrupt
git commit --allow-empty -m "advance HEAD"
node -e "/* call flywheel_memory draft_postmortem via MCP */"
# Expected: draft returned with reconstruction: true, warnings includes
# "checkpoint corrupt, reconstructed from git/beads"
```

### 10.4 Template pinning

```bash
node -e "
  const { expandTemplate } = await import('./dist/bead-templates.js');
  console.log(expandTemplate('foundation-with-fresh-eyes-gate', 1, {}).expandedMarkdown.slice(0, 80));
  try { expandTemplate('foundation-with-fresh-eyes-gate', 99, {}); }
  catch (e) { console.log('expected version_conflict:', e.code); }
"
# Expected: first line prints template body preview; second line prints
# "expected version_conflict: template_version_conflict"
```

### 10.5 Telemetry dual-session

```bash
# Terminal 1
node scripts/fake-session.mjs --session-id a --emit 500 &
# Terminal 2
node scripts/fake-session.mjs --session-id b --emit 500 &
wait
node -e "
  const raw = await import('fs/promises').then(m => m.readFile('.pi-flywheel/error-counts.json', 'utf8'));
  const spool = JSON.parse(raw);
  console.log('sessions tracked:', Object.keys(spool).length, 'total events:', Object.values(spool).reduce((s,x)=>s+x.total,0));
"
# Expected: sessions tracked: 2, total events: 1000
```

### 10.6 Chaos scenarios (automated)

```bash
npm test -- chaos/
# Expected:
# - kill-mid-run: exec_aborted returned within 1 retry window
# - missing-Gemini: yellow row, session continues
# - already-closed-bead: parse succeeds, no regression
# - noisy-monitor: observability plumbing ignores INFO-level chatter
# - dual-session: both spools preserved, merge produces combined summary
# - concurrent-postmortem: two distinct files (-r1, -r2)
```

---

## 11. Alignment check questions (for Step 5.55)

Four load-bearing decisions where planners disagreed or the synthesis made a
non-obvious choice. User confirmation recommended before Wave 1 kickoff.

### Q1. Telemetry storage: separate spool file vs checkpoint extension

> The synthesis uses a **separate file** (`.pi-flywheel/error-counts.json`)
> as the source of truth, with a mirror into `checkpoint.json` for
> backward-compat reads. Correctness proposed extending `checkpoint.json`
> directly; robustness argued a separate file is necessary for
> cross-process merge and resource bounds. This adds one file to
> `.pi-flywheel/`. Confirm or override?

### Q2. Post-mortem trigger coverage

> The synthesis triggers post-mortem draft in **three** places: Step 10
> wrap-up, `/flywheel-stop`, and manual. Correctness proposed Step 10 only.
> Rationale for the broader trigger set: sessions often end abnormally and
> CASS's prior learning is that Step 10 is frequently not reached. Confirm
> that `/flywheel-stop` should always draft (with `FLYWHEEL_POSTMORTEM_SKIP=1`
> as the escape hatch), or restrict to Step 10?

### Q3. Template expansion timing and versioning

> The synthesis adopts **explicit `@version` pinning** (`foundation@1`) with
> expansion at `br create` time (not at synthesis time). Plans reference
> pinned versions; library bumps require plan regeneration on mismatch.
> Correctness's original plan was implicit "latest"; robustness flagged the
> versioning hole. Confirm pinning is worth the extra hop of a
> `template_version_conflict` error when the library moves forward?

### Q4. Final error-code count: 10 (vs 7 baseline)

> The synthesis adds 10 new `FlywheelErrorCode` entries, absorbing
> robustness's `telemetry_merge_conflict` into `telemetry_store_failed` as
> an internal detail bit. Correctness argued for 7. Robustness argued for
> 9+. Confirm the 10 listed in §5.1 are sufficient — or should
> `telemetry_merge_conflict` become its own code to preserve
> orchestrator-side branching?

---

## 12. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| F1's scope is large (errors + types + checkpoint + cli-exec + bootstrap) and a bad landing blocks everything | Fresh-eyes gate after F1 (5 reviewers, 3min cold read). Single-revert bead. |
| Template `@version` churn annoys plan authors | Starter library frozen at `@1`. Template bumps require a v3.5.x release conversation. |
| Telemetry spool grows unbounded across sessions | 10-session rolling window; older compacted to counts-only in CASS. |
| Doctor false-red on slow networks (Agent Mail health_check) | 5s timeout, severity degrades to yellow (not red) on timeout. Confidence: medium. |
| Hotspot false-positive over-steers user to coordinator-serial when swarm was fine | "Recommended mode" phrasing + confidence tier; 4-option menu includes "Swarm anyway". |

---

## 13. Release checklist

- [ ] F1 landed; fresh-eyes 5/5 approve.
- [ ] All 10 new codes have `DEFAULT_RETRYABLE` entries + Zod-tuple order
      stable.
- [ ] `.lintskill-baseline.json` refreshed.
- [ ] `dist/` rebuilt and committed.
- [ ] SKILL.md lint passes with new code references.
- [ ] `/flywheel-doctor` smoke against a fresh clone: all green or expected
      yellow.
- [ ] Chaos harness green (dual-session, kill-mid-run, concurrent post-mortem).
- [ ] R1 release gate: 2/2 reviewers approve.
- [ ] CHANGELOG entry references every new error code and every new file.
- [ ] Tag `v3.4.0`; push.

---

*End of synthesized plan. Word-count: ~5,400 (≈950 lines). This plan is
intentionally longer than the strict "12-bead" correctness proposal because
each bead carries the failure-mode spine from robustness and the UX detail
from ergonomics. Beads themselves remain atomic.*
