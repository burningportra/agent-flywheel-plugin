# Compound Engineering — What to Apply to agent-flywheel-plugin

**Phase 6a synthesis.** Distilled from Phases 1–5 (explore/deep/invert/blunders/workflow) and 6b (ergonomics). Each proposal is expressed as a shippable change against our tree. Scope: S (≤1 day), M (2–4 days), L (5+ days). Priority: P0 (ship now), P1 (next cycle), P2 (nice-to-have).

Our moat — the end-to-end `skills/start/SKILL.md` orchestrator that drives `scan → discover → plan → implement → review → wrap-up → CASS → refine` with mandatory gates — stays untouched. Everything below is additive or a surgical hardening.

---

## Proposal 1 — Durable `docs/solutions/` learning store alongside CASS

- **Source insight:** Phase 5 §3 idea 1 + Phase 1 skill map (`plugins/compound-engineering/skills/ce-compound/SKILL.md` writes `docs/solutions/<category>/<slug>-<date>.md` with YAML frontmatter keyed on `problem_type`, `component`, `tags`, `applies_when`).
- **Target change:** Extend `mcp-server/src/episodic-memory.ts` `draftPostmortem()` to additionally return a `solutionDoc` object (path + frontmatter + body). Insert **Step 10.55** in `skills/start/_wrapup.md` immediately after 10.5 (telemetry flush), writing the doc via Write tool. Add a new `operation: "draft_solution_doc"` branch to `flywheel_memory` in `mcp-server/src/state.ts` plumbing.
- **Scope:** M. **Priority:** P0.
- **Why:** CASS is currently opaque. A committed markdown file is greppable with `rg`, reviewable in PRs, portable across tools (Cursor, Codex, plain editors), and survives CASS database corruption or schema migration. It doubles as external documentation of our own fixes. Pairing it with the existing `draftPostmortem()` means we get both the structured memory (CASS) and the durable artifact (file) from one synthesis pass, so cost is near-zero.
- **What could go wrong:** Two sources of truth drift if one is updated without the other. Mitigations: (a) the frontmatter embeds the CASS `entry_id` so the markdown is reconcilable; (b) Proposal 2's refresh sweep re-syncs on a schedule; (c) `_wrapup.md` writes both in the same step so there is no partial-write window except on hard kill, where the next session's doctor check can detect orphan CASS entries missing a companion doc.

---

## Proposal 2 — `/flywheel-compound-refresh` sweep + `flywheel_refresh_learnings` MCP tool

- **Source insight:** Phase 1 (`ce-compound-refresh/SKILL.md`) + Phase 5 §3 idea 2 (their Phase 1.75 Document-Set Analysis scores overlap across 5 dimensions: problem, root cause, solution, files, prevention).
- **Target change:** New `commands/flywheel-compound-refresh.md`, new `skills/flywheel-compound-refresh/SKILL.md`, new tool `flywheel_refresh_learnings` in `mcp-server/src/state.ts` that reads `docs/solutions/`, cross-references against current code via ripgrep, and returns Keep/Update/Consolidate/Replace/Delete classifications. Consumes Proposal 1's frontmatter.
- **Scope:** L. **Priority:** P1 (depends on 1).
- **Why:** Without pruning, our memory monotonically accumulates and eventually produces contradictory learnings for a component that has since been rewritten. CE's `ce-compound-refresh` Phase 1.75 scoring rubric is directly portable — problem/root-cause/solution/files/prevention similarity gives a 5-vector overlap score that collapses "duplicate lesson under different phrasing" cases. We align the sweep with our scheduled-tasks skill so users can run it weekly.
- **What could go wrong:** Over-eager deletion loses context. Mitigation: make Delete require explicit user confirmation via `AskUserQuestion`, default the automated mode to Keep/Update/Consolidate only, and archive removed docs under `docs/solutions/_archive/` rather than `rm`. If ripgrep misses evidence (file moved, not deleted), the sweep would wrongly mark a lesson stale — mitigated by checking `git log --follow` for renames before classifying.

---

## Proposal 3 — Actual-modified-files collision detection in wave orchestration

- **Source insight:** Phase 5 §3 idea 4 + `plugins/compound-engineering/skills/ce-work/SKILL.md` Phase 2 cross-check ("compare actual files modified by all subagents in the batch, not just declared `Files:` lists").
- **Target change:** In `mcp-server/src/coordination.ts`, after each wave, run `git diff --name-only <base-sha>..HEAD` per worker (or per-worktree when swarm mode is active). Replace the current bead-template declared-`Files:` trust model with post-hoc reconciliation. If 2+ workers touched the same path, emit a `wave_collision_detected` `FlywheelErrorCode` (new) and force serial re-run of the colliding units on the already-committed branch.
- **Scope:** M. **Priority:** P1.
- **Why:** Our swarm's bead-level isolation assumes beads touch disjoint files, enforced at plan time via `bead-templates.ts`. But plans describe *what*, not *how* — a worker may create a new helper, touch a shared config, or hit an ambient dependency we didn't predict. Today the last writer wins silently. CE's reconciliation model is strictly tighter and composes cleanly with our existing wave boundaries: we already fence waves, so we just need to inspect after each.
- **What could go wrong:** False positives when two workers both touch an auto-generated file (lockfile, snapshot) that should be regenerated deterministically. Mitigation: a configurable ignore-glob (`.pi-flywheel/collision-ignore`) seeded with `package-lock.json`, `__snapshots__/**`, `*.generated.*`. False negatives if workers run against different bases — requires anchoring the diff against the wave-start SHA, not HEAD.

---

## Proposal 4 — Brainstorm step between discover and plan

- **Source insight:** Phase 5 §2 (gap) + `ce-brainstorm/SKILL.md` Phase 1.2 "Product Pressure Test" and Phase 1.3 "Collaborative Dialogue".
- **Target change:** Add a new Phase 0.5 inside `skills/start/_planning.md` before the existing Phase 1 (standard plan). It runs an AskUserQuestion-driven dialogue: three pressure-test questions ("what's the smallest version that ships?", "what's the 10x version?", "what have users asked for adjacent to this?") then emits `docs/brainstorms/<slug>-<date>.md` which `_planning.md` reads as input.
- **Scope:** S. **Priority:** P1.
- **Why:** We rush from `flywheel_discover` into planning with only a goal-confirmation AskUserQuestion. The "we planned the wrong thing" failure mode is our most expensive bug: beads ship but the goal was miscalibrated. A single structured dialogue catches this before we spend plan + implement budget. Keeping it inside `_planning.md` (not a new skill) avoids orchestrator fragmentation — compare CE which makes the user manually run `/ce-brainstorm`.
- **What could go wrong:** Dialogue fatigue. Users already answer one AskUserQuestion at discover; stacking a three-question brainstorm feels like interrogation. Mitigation: make Phase 0.5 skippable when `discover` returns `confidence >= 0.8` or when the user has already typed a detailed goal >100 chars in the initial prompt. Default to fast-path.

---

## Proposal 5 — Review-mode matrix on `flywheel_review`

- **Source insight:** Phase 1 + Phase 5 §2 (`ce-code-review/SKILL.md` has explicit autofix/report-only/headless/interactive matrix + parallel-safety flag on each reviewer agent).
- **Target change:** Extend `skills/start/_review.md` with a mode selector (AskUserQuestion default `autofix` on green doctor, `report-only` on yellow, `interactive` on red). Extend `flywheel_review` tool signature in `mcp-server/src/state.ts` to accept `mode` and `parallelSafe` flags; route accordingly. No new reviewer agents — just structured dispatch of existing ones.
- **Scope:** S. **Priority:** P2.
- **Why:** Today review is one-shape: sequential reviewer personas that emit suggestions the user must manually apply. CE's matrix lets the same reviewers run as fixup-PR generators (autofix), advisory reports (report-only), CI-friendly exit-code signals (headless), or conversational guides (interactive). Each mode maps to an existing human workflow.
- **What could go wrong:** Autofix on a shaky tree produces noisy diffs. Mitigation: gate autofix behind a green doctor and a clean git status. Headless mode misleads callers if exit codes are inconsistent — require a well-defined code table in `errors.ts` first.

---

## Proposal 6 — Line-ending normalization at every file read

- **Source insight:** Phase 4 Blunder #8 (`src/utils/frontmatter.ts:9` uses `raw.split(/\r?\n/)`; CRLF and lone `\r` slip through and poison downstream shell scripts).
- **Target change:** Add a `normalizeNewlines(raw)` helper in a new `mcp-server/src/utils/text.ts`. Call it at every disk read in `episodic-memory.ts`, `bead-templates.ts`, `deep-plan.ts`, and any future Proposal 1 solution-doc reader. Preflight with `git config core.autocrlf` detection in `flywheel_doctor`.
- **Scope:** S. **Priority:** P1.
- **Why:** Cheap, defensive, catches a real data-corruption hazard that CE shipped. Our CASS markdown is hand-edited and round-trips through editors — the same bug will bite us the first time a Windows user or web-pasted content enters the flow.
- **What could go wrong:** Normalizing too eagerly destroys intentional CRLF in user-authored fixtures (rare). Mitigation: normalize only at the application layer when parsing YAML/markdown; pass raw bytes through for file-copy operations.

---

## Proposal 7 — Ownership-guarded destructive I/O

- **Source insight:** Phase 4 Blunder #3 (`src/utils/symlink.ts:8-28` unlinks a real file with no ownership check; `backupFile` pattern from `src/utils/files.ts:4-15` exists elsewhere in CE but is skipped here).
- **Target change:** Audit `mcp-server/src` and `skills/` scripts for `fs.unlink`, `fs.rm`, `rm -rf`. Introduce a `deleteWithOwnership(path, owner)` helper that requires either (a) a symlink resolving to a managed root, (b) a `.pi-flywheel/manifest.json` entry claiming the path, or (c) an explicit `--i-mean-it` flag. Always `backupFile()` first. Main suspects: `/flywheel-cleanup` command, legacy-cleanup helpers, worktree teardown.
- **Scope:** M. **Priority:** P1.
- **Why:** `~/.claude/plugins/` and `.pi-flywheel/` are shared-tenant — other plugins or the user themselves can park files there. A silent unlink is a data-loss bug waiting for a bad bug report. CE showed us exactly how this goes wrong; we should not repeat it.
- **What could go wrong:** Ownership metadata drift — a manifest lists a path the user has since moved. Mitigation: fall back to "refuse and warn" rather than "delete and proceed"; require human confirmation when the manifest and filesystem disagree.

---

## Proposal 8 — Structured `hint` field on every `FlywheelErrorCode` throw

- **Source insight:** Phase 6b Idea 1 + Phase 2 ("colons-in-values" note on `src/utils/frontmatter.ts` ~L45–50).
- **Target change:** Add optional `hint: string` to `FlywheelError` class in `mcp-server/src/errors.ts`. Mechanical pass over all 26 `FlywheelErrorCode` construction sites; add one-sentence recovery actions. Update `_wrapup.md` Step 10.0 to surface `error.hint` inline when branching on error codes.
- **Scope:** S. **Priority:** P0.
- **Why:** We already branch correctly on codes in the orchestrator, but the human-readable message at throw sites is bare exception text. A co-located one-liner ("Run /flywheel-setup to install missing deps"; "Another agent holds the lock; wait or run /flywheel-cleanup") eliminates a user round-trip. Non-breaking because the Zod envelope already carries the error object.
- **What could go wrong:** Stale hints after refactors. Mitigation: add a lint rule that every `new FlywheelError(code, …)` must pass `hint`; failure fails CI. Keep hints under 80 chars so they never wrap uglily in the banner.

---

## Rejects

- **Pluggable converter/target registry (Phase 2 §1).** CE needs it because they ship to Cursor, Codex, and Claude Code from one source. We are single-target (Claude Code plugin); the bundle-between-steps pattern adds indirection without benefit.
- **Manual user-initiated `/compound` step (Phase 5 §1.4).** CE relies on `user-initiated discipline` because they have no orchestrator. Ours already automates learning capture at `_wrapup.md` Step 10. Forcing a manual slash-command hurts more than helps.
- **Temperature inference from agent name regex (Phase 3 §1.5).** Substring-bingo temperature assignment is an anti-pattern we should not import; any future model-parameter tuning should be explicit per-agent frontmatter.
- **Class-hierarchy writer refactor (Phase 2 §1 alternative).** CE rejected this and so do we; our functional `mcp-server/src/*.ts` modules are already tree-shakeable.
- **Skipping the brainstorm gate on repeat goals.** Tempting optimization, but users re-open the same goal with different constraints; a fresh pressure-test is cheap insurance.

---

## Sequencing

Ship in this order to keep each step independently valuable:

1. **P0 sprint (≤1 week):** Proposal 8 (hints) — trivial, immediate DX win. Proposal 1 (solutions store) — foundation for Proposal 2. Proposal 6 (line endings) — defensive.
2. **P1 cycle (2–3 weeks):** Proposal 2 (refresh sweep) lands once solutions docs exist. Proposal 3 (collision detection) and Proposal 7 (ownership guards) in parallel — different subsystems. Proposal 4 (brainstorm gate) as a flagged experiment.
3. **P2 backlog:** Proposal 5 (review modes) after we have telemetry on which modes users actually want.

Total: 7 shippable proposals + 5 rejects, all grounded in specific CE file:line citations.
