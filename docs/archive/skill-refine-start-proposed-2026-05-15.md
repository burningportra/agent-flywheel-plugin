# skills/start refinement proposal — 2026-05-08

> **Status (archived 2026-05-15 by `claude-orchestrator-3ibw`)** — shipped during `reality-check-2026-05-15`. Item-by-item disposition:
>
> | # | Item | Status | Landed via |
> |---|------|--------|------------|
> | 1 | NTM `--robot-send` flag syntax (`--panes=N`, drop `--type=`) | ✓ shipped | already on disk before this cycle (`_planning.md` ~L361 / `_implement.md` ~L293) |
> | 2 | `codex_config_compat` pre-spawn gate | ✓ shipped | `claude-orchestrator-2wcd` (commit `bf48b86`) + `claude-orchestrator-3s58` (commit `1ad2d4d`, automated remediation handler) + `claude-orchestrator-37n6` (`gemini_model_compat` doctor check, commit `530a04c`) |
> | 3 | `br list` default-view excludes closed (`_beads.md` reference + tend-cycle note) | ✓ shipped | `_beads.md` L12 + L17 |
> | 4 | `cycleStartSha` bootstrap gap callout in `_wrapup.md` `postmortem_empty_session` branch | ✓ shipped | `_wrapup.md` L330 |
> | 5 | Step 5.55 "decisive convergence on synthesizer recommendations" note | follow-up beaded | `claude-orchestrator-2ekf` (`reality-check-2026-05-15-followup`, P3 task) |
> | 6 | Solution-doc category classifier `tooling`/`coordination` vs `test` | deferred per source doc | not in scope of this archive |
> | 7 | `mark_message_read()` integer-ID Zod validation | deferred per source doc (upstream agent-mail) | not in scope of this archive |
>
> **Disposition.** Items 1–4 are live in the skills as of `main@bf48b86..530a04c..1ad2d4d`. Item 5 is the only outstanding skill change; tracked in the follow-up bead above. Items 6–7 were already marked out-of-scope in the proposal itself. The doc is now historical reference — do not edit it; file new follow-ups against the relevant skill file directly.
>
> ---
>
> **Source evidence**: outcome-grading v3.13.0 cycle (60+ orchestrator turns, 3-pane deep-plan + 1-pane impl coordinator-serial)
> **Supersedes**: prior 2026-04-21 v3.4.0-evidence proposal (now stale).

## Priority 1 — fixes for live failures observed this cycle

### #1 — NTM `--robot-send` flag syntax

**Files**: `skills/start/_planning.md` lines 328-330, `skills/start/_implement.md` lines 237-239.

**Failure observed this cycle**: First dispatch with `ntm --robot-send=$SESSION --panes=1 --type=cc --msg=<correctness-prompt>` was rejected with `"No target panes matched the filter criteria"` because the AND of `--panes=1 AND --type=cc` matched zero panes at session-init time (pane-type metadata wasn't fully populated yet). Second attempt without `--type=cc` succeeded but unintentionally broadcasted to ALL 3 panes (because the leading test was `--pane=1` singular, which doesn't exist on `--robot-send` and got silently ignored). Result: cod and gmi panes got the correctness prompt; required override messages.

**Proposed change**:

In `_planning.md` § "Deep plan" dispatch (around line 326), replace the 3 example lines:

```bash
# BEFORE:
ntm --robot-send="$SESSION" --panes=1 --type=cc  --msg="<correctness planner prompt>"
ntm --robot-send="$SESSION" --panes=2 --type=cod --msg="<ergonomics  planner prompt>"
ntm --robot-send="$SESSION" --panes=3 --type=gmi --msg="<robustness  planner prompt>"

# AFTER:
ntm --robot-send="$SESSION" --panes=1 --msg="<correctness planner prompt>"
ntm --robot-send="$SESSION" --panes=2 --msg="<ergonomics  planner prompt>"
ntm --robot-send="$SESSION" --panes=3 --msg="<robustness  planner prompt>"
```

Add a note immediately after the bash block:

> **Flag note (verified 2026-05-08).** Use `--panes=N` (plural; indices are comma-separated). `--pane=N` (singular) is silently broadcast to ALL panes. Combining `--panes=N --type=cc` AND-restricts to zero matches at session-init time before pane-type metadata stabilizes — drop `--type=` when you already know the index. Test with `--msg="ping"` before dispatching the full prompt and verify `successful: ["N"]` returned, not `["0", "1", "2"]`.

Apply identical change to `_implement.md` line 237-239 (Step 7 implementation dispatch).

### #2 — `codex_config_compat` pre-spawn gate (missing)

**Files**: `skills/start/_planning.md` § Deep plan pre-flight (around line 295), `skills/start/_implement.md` § Pre-flight gate.

**Failure observed this cycle**: `codex_config_compat` was yellow at session start (doctor flagged `~/.codex/config.toml model = "gpt-5.5"` as ChatGPT-account-incompatible). The deep-plan swarm was spawned anyway. The cod pane crashed within seconds with `"'gpt-5.5-xhigh' model is not supported when using Codex with a ChatGPT account"`. Required mid-cycle user-confirmed `sed` fix + pane restart.

**Proposed change**: Add a new pre-flight sub-step BEFORE the swarm spawn, in both `_planning.md` (deep plan + duel) and `_implement.md` (impl dispatch):

> **Codex config compatibility pre-spawn gate.** If the swarm includes any `cod` pane AND `DOCTOR_REPORT.checks` shows `codex_config_compat` with severity `yellow` or `red`, surface this gate BEFORE spawning:
>
> ```
> AskUserQuestion(questions: [{
>   question: "Doctor flagged codex_config_compat (~/.codex/config.toml model='X' is rejected by ChatGPT-account auth). Apply the fix before spawning?",
>   header: "Codex config",
>   options: [
>     { label: "Apply fix and proceed (Recommended)", description: "Run: sed -i.bak -E 's/^([[:space:]]*model[[:space:]]*=)/# \\1/' ~/.codex/config.toml. Then spawn the swarm." },
>     { label: "Skip cod from swarm", description: "Spawn with --cc=N --gmi=M only (no cod panes). Loses Codex perspective" },
>     { label: "Continue anyway", description: "Spawn cod panes despite known incompatibility — they will likely crash within seconds. Pick this only if you have an alternative grader plan" }
>   ],
>   multiSelect: false
> }])
> ```
>
> **Apply fix and proceed** → `sed`, then continue to spawn step. **Skip cod** → re-shape the spawn args to omit `--cod=N`. **Continue anyway** → spawn as planned and surface the failure to the user when it occurs (don't silently fall back).

### #3 — `br list` default-view excludes closed beads

**File**: `skills/start/_beads.md` line 11 (the br CLI command reference table).

**Failure observed this cycle**: Tend cycles using `br list --json` filtered for `status === 'closed'` returned 0 results even when 9 commits clearly closed 9 beads. Default `br list` excludes closed. The skill's reference table had only "List open beads" → `br list (default) or br list --json` — no entry for closed beads.

**Proposed change**: Add a row to the reference table at line 11:

```
> | List closed beads | `br list --status closed --json` | `br list \| grep closed` (closed status not shown by default) |
```

Add a new caveat below the existing WARNING at line 66:

> **Tend-cycle note**: `br list` (no flags) shows only `open` and `in_progress`. To check this cycle's completion count, use `br list --status closed --json`. Common false-alarm pattern: orchestrator sees commits but `br list` shows 0 closed → assumes implementer is committing without closing → wastes a tend cycle on a phantom problem.

## Priority 2 — improvements for clarity (nice-to-have)

### #4 — `cycleStartSha` bootstrap gap callout in `_wrapup.md`

**File**: `skills/start/_wrapup.md` § Step 10.0 post-mortem error-code branches.

**Issue**: The `postmortem_empty_session` error-code branch says "still returns a terse draft; proceed with the AskUserQuestion" — but doesn't flag the common cause: features that capture state at session-boundary points (`flywheel_select`, `flywheel_plan`) don't kick in until the NEXT cycle. A cycle that SHIPS such a feature gets `empty_session` for its own postmortem.

**Proposed change**: Append to the `postmortem_empty_session` branch:

> **Common cause**: this cycle shipped a state-capture feature at a session-boundary point (e.g. `cycleStartSha` capture in `flywheel_select`), but the capture wasn't yet implemented when this cycle's `flywheel_select` was called. The auto-postmortem can't see this cycle's commits because there's no captured baseline. Hand-write the post-mortem from `git log --since="<session-start-time>" --oneline` instead. The next cycle will work correctly.

### #5 — Step 5.55 "decisive convergence on synthesizer recommendations" example

**File**: `skills/start/_planning.md` § Step 5.55 §3.

**Issue**: The skill says "**All answers confirm the plan** → proceed to Step 5.6" but the user's confirming answers may agree with the SYNTHESIZER's recommendations (not change them) — that's actually decisive convergence in disguise, not a "no-op" branch. Worth a one-line note.

**Proposed change**: Append to the "All answers confirm" branch in §3:

> Note: this branch fires when the user agrees with the synthesizer's recommendations on every question. The synthesizer already adopted those choices in the plan body; the user's confirmation just cross-validates. No refinement round is needed — proceed directly to Step 5.6.

### #6 — Solution-doc category classifier picks "test" for non-test cycles

**File**: `mcp-server/src/solution-doc-schema.ts` (NOT a skill, but caught during this cycle's wrap-up).

**Issue**: This cycle's solution doc was auto-categorized as `docs/solutions/test/...` because the goal text mentioned "test" (in the context of "rubric grader iteration loop, with test output"). Better category: `tooling` or `coordination`. Worth a follow-up bead, not a skill change.

**Recommended action**: file a follow-up bead in next cycle, not part of this refine.

### #7 — `mark_message_read()` validation rejects integer message IDs

**File**: agent-mail server-side Zod parsing (NOT a skill, observed mid-cycle).

**Issue**: Passing `message_id: 757` (integer) returns `expected type integer, got string` from validator. Workaround: skip clearing stale inbox messages.

**Recommended action**: file as upstream agent-mail issue, not part of this refine.

## What worked well this cycle (preserve, don't change)

- **Step 5.55 alignment-check loop is load-bearing.** Surfacing the 4 unresolved tensions BEFORE bead creation caught all the load-bearing decisions. Decisive-convergence skip rule worked smoothly.
- **Step 0c doctor smoke check is load-bearing.** It flagged `codex_config_compat` and `checkpoint_validity` at session start — both were real issues. The skill correctly surfaced them but the user (and orchestrator) didn't gate on them; that's the pre-spawn gate ask in #2.
- **Coordinator-serial launch mode + hotspot matrix routing** was correct for this cycle (3 beads modify same file). The 4-option launch menu correctly routed to single-pane impl.
- **flywheel_approve_beads(action: 'remediate')** as a Tension #3 resolution — clean addition without polluting other approve actions.
- **Per-bead completion-report.json discipline** — every closed bead has its evidence preserved on disk, queryable via `flywheel_verify_beads`.

## Files to modify (if proposal accepted)

- [ ] `skills/start/_planning.md` (Priority 1 #1, #2; Priority 2 #5)
- [ ] `skills/start/_implement.md` (Priority 1 #1, #2)
- [ ] `skills/start/_beads.md` (Priority 1 #3)
- [ ] `skills/start/_wrapup.md` (Priority 2 #4)

## Application order

1. Apply #1 (NTM flag syntax) — single-line edits, lowest risk
2. Apply #3 (br list reference table) — single-line additions
3. Apply #2 (codex_config_compat gate) — adds new sub-step, larger surface
4. Apply #4 (postmortem callout) — append-only
5. Apply #5 (decisive-convergence note) — append-only

After applying: rebuild bundle (`cd mcp-server && npm run build`) so the bundled skill body matches disk.
