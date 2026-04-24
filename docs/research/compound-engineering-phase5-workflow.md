# Compound Engineering — Phase 5: Workflow Deep-Dive

**Agent:** SilverForge
**Date:** 2026-04-23
**Focus:** How the brainstorm -> plan -> work -> review -> compound loop is actually implemented in `EveryInc/compound-engineering-plugin`, compared head-to-head with our `agent-flywheel-plugin` `/start` skill.

---

## Section 1 — How Their Loop Actually Works

### 1.1 Where the loop lives

The loop is implemented as **one skill per phase**, each at `plugins/compound-engineering/skills/ce-<phase>/SKILL.md`, plus a supporting fleet of 51 `*.agent.md` subagents under `plugins/compound-engineering/agents/`. There is **no umbrella orchestrator skill** that drives all five phases — the user (or Claude, via slash-command routing) picks the next phase themselves. The README lists the slash commands as the surface area:

| Slash command | Skill file | Role |
|---|---|---|
| `/ce-ideate` | `ce-ideate/SKILL.md` | Optional: rank big-picture ideas, emit `docs/ideation/*.md` |
| `/ce-brainstorm` | `ce-brainstorm/SKILL.md` | Interactive Q&A -> requirements doc |
| `/ce-plan` | `ce-plan/SKILL.md` | Requirements -> technical plan |
| `/ce-work` | `ce-work/SKILL.md` | Plan -> code + commits (worktrees + parallel subagents) |
| `/ce-code-review` | `ce-code-review/SKILL.md` | Tiered persona review with confidence gates |
| `/ce-compound` | `ce-compound/SKILL.md` | Capture the lesson into `docs/solutions/` |
| `/ce-compound-refresh` | `ce-compound-refresh/SKILL.md` | Sweep and refresh stale learning docs |

### 1.2 The five phases and their outputs

1. **Brainstorm** (`ce-brainstorm`) — Phase 0 resumes prior brainstorms, classifies task domain, assesses scope. Phases 1–3 run a **collaborative dialogue**: existing-context scan, product-pressure-test, explore approaches, capture requirements. **Output:** a right-sized requirements document.
2. **Plan** (`ce-plan`) — Finds upstream requirements, runs `ce-repo-research-analyst` and `ce-learnings-researcher` **in parallel** (institutional knowledge from `docs/solutions/` is piped into the plan), then assembles the plan. **Output:** `docs/plans/<date>-<slug>.md`.
3. **Work** (`ce-work`) — Phase 0 triages input (plan path vs. bare prompt, complexity routing trivial/small/large). Phase 1 does quick-start; Phase 2 dispatches subagents (serial or parallel batches) with a file-collision check: compares **actual files modified** across parallel units (not just declared `Files:` lists), commits non-colliders, reruns colliding units serially. **Output:** commits + updated plan checkboxes.
4. **Review** (`ce-code-review`) — Tiered persona agents with confidence scoring, merge/dedup pipeline, mode detection (autofix / report-only / headless / interactive). Report-only mode is explicitly **safe to run in parallel** with browser testing on the same checkout.
5. **Compound** (`ce-compound`) — Spawns four parallel subagents: **Context Analyzer** (classifies bug vs knowledge track via `references/schema.yaml`), **Solution Extractor**, **Related Docs Finder** (grep-first on `docs/solutions/` frontmatter, scores overlap on 5 dimensions), **Session Historian** (opt-in). Phase 2 assembles a doc from `assets/resolution-template.md`. Phase 2.5 **selectively invokes `ce-compound-refresh`** only when the new learning likely invalidates older docs. **Output:** `docs/solutions/<category>/<slug>-<date>.md` with strict YAML frontmatter.

### 1.3 What persists between phases

Everything persists as **plain markdown files on disk** — there is no database, no checkpoint JSON, no bead store:

- `docs/ideation/*.md` (ideate output)
- requirements docs (brainstorm output, location per user)
- `docs/plans/*.md` (plan output, consumed by `/ce-work`)
- git commits + plan checkboxes (work output)
- `docs/solutions/{bug,architecture,workflow,...}/*.md` (compound output)
- **Auto-memory** (Claude Code–injected block) is read as a supplementary signal by `ce-compound` and `ce-compound-refresh`.

### 1.4 What triggers compaction/learning capture

`/ce-compound` is **manually invoked** after work+review. The trigger heuristics live inside `ce-compound`'s own Phase 2.5 which decides whether to cascade into `/ce-compound-refresh`. There is no automatic post-PR hook; the compounding step is **user-initiated discipline**, supported by a strong description-match on phrases like "document this learning" that Claude picks up opportunistically.

---

## Section 2 — Head-to-Head Comparison

| Their phase | Our closest analog | Gap / observation |
|---|---|---|
| `/ce-ideate` (optional) | `flywheel_discover` + `/idea-wizard` | **Parity**: both rank ideas; ours adds market-validation (`/xf`) and multi-model triangulation |
| `/ce-brainstorm` | (missing) — we jump from discover -> plan | **Gap in ours**: we lack an explicit interactive requirements-dialogue step between goal-selection and planning |
| `/ce-plan` | `_planning.md` (standard + deep) | **We win**: parallel deep-plan perspectives via Agent Mail, plan-alignment check (5.55), empirical numeric verification |
| `/ce-work` | `_beads.md` + `_implement.md` | **We win on structure**: beads (bd) give dependency DAG, wave orchestration, coordinator; **they win on collision detection**: their "actual files vs declared Files:" reconciliation is tighter than ours |
| `/ce-code-review` | `_review.md` + `flywheel_review` | **Parity**; theirs has explicit mode-detection matrix (autofix/report-only/headless/interactive) + parallel-safety flag |
| `/ce-compound` | Step 10 CASS + `flywheel_memory draft_postmortem` | **Theirs wins on persistence shape**: durable `docs/solutions/*.md` with YAML frontmatter is greppable forever. **Ours wins on automation**: auto-drafted post-mortem from checkpoint + telemetry, versus their manual re-derive |
| `/ce-compound-refresh` | (missing) | **Gap in ours**: we have no scheduled sweep of old learnings against current code. CASS grows monotonically; theirs prunes/consolidates/replaces |
| — | `/flywheel-refine-skill` (Step 11) | **We win**: session evidence -> skill prompt edits is uniquely ours |

---

## Section 3 — Five Ideas to Borrow (and One to Reject)

1. **BORROW — `docs/solutions/` as a first-class greppable learning store with YAML frontmatter + schema enum.** Rationale: CASS is a black box from a developer's perspective; a committed markdown file with `problem_type:`, `component:`, `tags:`, `applies_when:` is searchable via `rg`, diffable in PRs, and portable across tools. Add a step in `_wrapup.md` (Step 10.5) that writes a durable `docs/solutions/<category>/<slug>-<date>.md` alongside the CASS entry.

2. **BORROW — A `compound-refresh` sweep to prune stale learnings.** Rationale: our CASS memory accumulates forever; no decay, no supersession. Add `/flywheel-compound-refresh` that reads `docs/solutions/`, cross-references against current code via `ce-learnings-researcher`-style grep, and classifies Keep/Update/Consolidate/Replace/Delete. Their Phase 1.75 Document-Set Analysis (overlap detection across 5 dimensions: problem, root cause, solution, files, prevention) is directly portable.

3. **BORROW — Explicit brainstorm step between discover and plan.** Rationale: we rush from `flywheel_discover` into `_planning.md` with only an AskUserQuestion goal confirmation. Their `ce-brainstorm` Phase 1.2 "Product Pressure Test" and Phase 1.3 "Collaborative Dialogue" de-risk the "we planned the wrong thing" failure mode. Could be a lightweight mode inside `_planning.md` Phase 0 rather than a whole new skill.

4. **BORROW — File-collision detection based on *actual* modified files, not declared `Files:` lists.** Rationale: our swarm's bead-level isolation assumes beads touch disjoint files. When two beads in the same wave modify the same file (which happens via discovered dependencies), the last-writer-wins silently. Their `ce-work` Phase 2's cross-check (compare `git diff --name-only` outputs across parallel subagents, commit non-colliders, serialize colliders) is stronger than our wave-level check.

5. **REJECT — Manual, user-initiated compound step.** Rationale: Their `/ce-compound` relies on developer discipline to invoke after every solved problem. Our Step 10 auto-prompts via `AskUserQuestion` at wrap-up with a draft already synthesized from telemetry. Keep ours — discipline degrades, automation doesn't.

---

**Our unique strength (don't lose):** the end-to-end orchestration in `skills/start/SKILL.md` that drives `scan -> discover -> plan -> implement -> review -> verify -> wrap-up -> CASS -> skill refinement` as one continuous workflow with mandatory gates. Compound Engineering leaves phase sequencing to the user; we automate it. That is the flywheel's compounding moat.

---

**Word count:** ~820
