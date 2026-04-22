# Skill Refinement Proposal — skills/start/ (evidence: v3.4.0 session, 2026-04-21)

**Refiner:** ChartreuseWaterfall (claude-opus-4-7)
**Coordinator:** LilacRidge
**Session:** v3.4.0 observability bundle — release `6f24cf3` (14 beads closed, 740 → 919 tests, 0 production regressions)
**Plan:** `docs/plans/2026-04-21-v3-4-0-synthesized.md`

---

## Evidence summary

Session shipped v3.4.0 cleanly (14 beads, 2 waves parallel + 1 serial, fresh-eyes gate after F1, pre-merge 2-reviewer release gate). Observed friction points, ranked by recurrence:

- **br CLI flag mismatches (2 incidents, silent failure both times).** Coordinator used `br create --issue-type` (silently accepted, empty JSON output) and `br update --close-reason` (does not exist — `br close -r/--reason` is the correct form, or `br update --status closed` with a separate commit message for closing reason).
  - Verified via `br create --help`: the flag is `-t`/`--type`; `--issue-type` is NOT listed.
  - Verified via `br close --help`: `-r/--reason <REASON>` is the close-reason flag, and `br update` has no `--reason` flag at all.
  - Current `skills/start/_beads.md:9` uses the correct form (`--type task`) but the example is one line in a numbered list — easy to miss mid-flow.

- **Title-format lint cosmetic noise (3 incidents).** `R1:`, `T13:`, `D12:` beads flagged "title not a verb phrase" by lint. All three were intentional wave/review labels; the lint heuristic doesn't recognize wave-prefix conventions. Cosmetic but pollutes the quality score (0.74 this session, below the 0.75 "acceptable" threshold).

- **Plan quality score 0.74 at launch (1 incident, high consequence).** Below the skill's documented 0.75 "acceptable" threshold. User accepted the risk; no downstream issues. The low-quality menu at `_beads.md:155-167` fires but the user ratified the synthesis anyway. The threshold's calibration may be too strict.

- **Agent Mail `contact_policy` default blocks first peer-to-peer send (2 incidents).** `bootstrapCoordinator` (F1) auto-sets `auto` for the coordinator but not for planner/reviewer identities. Workaround: agents embedded their summary in task-return text instead of Agent Mail body.

- **Codex sandbox cannot access `mcp__plugin_agent-flywheel_agent-mail__*` tools (1 incident — codex:codex-rescue robustness planner).** Agent produced plan but could not bootstrap AM. Already documented as degraded mode in `SKILL.md` (step 0f) — the fallback worked.

- **Parallel-wave `dist/` build race (1 incident, non-blocking).** I3 committed `dist/` first; I2 rebuilt the same `dist/` and committed only src/. Outputs were byte-identical. No bug, but the pattern is confusing when debugging via git blame.

- **Fresh-eyes gate after F1 caught a real P1 (1 incident, high value).** `HotspotInputBead.body` vs `Bead.description` field mismatch silently suppressed the `coordinator-serial` recommendation. The 5-reviewer parallel dispatch found it cold. Strong validation of the existing pattern.

- **Agent-mail search returned empty** for both `"start skill feedback"` and `"flywheel skill"` queries — no cross-session feedback messages arrived during this cycle. Evidence here comes from CASS entry `b-mo9ibqpx-sx6i5r`, git log, and plan synthesis text.

---

## High-confidence changes (evidence ≥ 2 data points OR single-incident with silent-failure consequence)

### Change 1: Add br CLI command reference card at top of `_beads.md`

- **File + section:** `skills/start/_beads.md` — insert new block between line 2 and line 3 (before `## Step 5.5`).
- **BEFORE:**
  ```
  # Bead Creation & Approval — Steps 5.5, 6

  ## Step 5.5: Create beads from the plan
  ```
- **AFTER:**
  ```
  # Bead Creation & Approval — Steps 5.5, 6

  > ## br CLI command reference (use EXACTLY these flags — the CLI silently accepts unknown flags and returns empty JSON)
  >
  > | Operation | Correct form | Common wrong form |
  > |-----------|--------------|-------------------|
  > | Create bead | `br create --title "…" --description "…" --priority 2 --type task` | `--issue-type` (silently ignored — use `-t`/`--type`) |
  > | Add dependency | `br dep add <downstream> <upstream>` (positional) | `--depends-on` (does not exist) |
  > | Close bead with reason | `br close <id> --reason "…"` or `br close <id> -r "…"` | `br update <id> --close-reason "…"` (does not exist) |
  > | Mark status closed | `br update <id> --status closed` | `br update <id> --status done` (status enum is `open`/`deferred`/`in_progress`/`closed`) |
  > | List all | `br list` (default) or `br list --json` | — |
  > | Show one | `br show <id> --json \| jq '.[0]'` (wraps in array) | `br show <id>` then parse as single object (will fail — it's an array) |
  >
  > **Hard rule:** If `br` returns empty JSON or exits 0 with no visible effect, you likely used a flag that doesn't exist. Re-run with `--help` to verify before retrying.

  ## Step 5.5: Create beads from the plan
  ```
- **Rationale + evidence:**
  - CLI silent-accept behavior hit TWICE this session (`--issue-type`, `--close-reason`). Both times the coordinator proceeded thinking the command succeeded — only noticed when downstream state didn't match.
  - `br create --help` output confirms `-t`/`--type` is the correct flag; `br close --help` confirms `-r`/`--reason` is close-only (not on `update`).
  - Existing `_beads.md:9` has the correct form inline but is buried in a numbered list; a top-of-file reference card is impossible to miss when the agent reads the file at Step 5.5 entry.
  - Matches the pattern used by the `_implement.md` idle-agent escalation table (also evidence-driven after v3.3.0 session).

---

### Change 2: Extend plan-quality-score "low quality" menu with a "ratify as-is" fast-path for decisive convergence

- **File + section:** `skills/start/_beads.md` lines 155-167 (the low-quality `AskUserQuestion` menu).
- **BEFORE:**
  ```
  AskUserQuestion(questions: [{
    question: "Quality score: <X.XX>/1.00 — below the 0.75 threshold. <weak-bead-summary>. How should I proceed?",
    header: "Low quality",
    options: [
      { label: "Polish beads", description: "Run another bead refinement round (Recommended)" },
      { label: "Back to plan", description: "Return to Step 5.6 to refine the plan itself" },
      { label: "Launch anyway", description: "Proceed despite low score — accept the risk" },
      { label: "Reject", description: "Discard these beads and start over with a different goal" }
    ],
    multiSelect: false
  }])
  ```
- **AFTER:**
  ```
  AskUserQuestion(questions: [{
    question: "Quality score: <X.XX>/1.00 — below the 0.75 threshold. <weak-bead-summary>. How should I proceed?",
    header: "Low quality",
    options: [
      { label: "Polish beads", description: "Run another bead refinement round (Recommended)" },
      { label: "Back to plan", description: "Return to Step 5.6 to refine the plan itself" },
      { label: "Launch anyway", description: "Proceed despite low score — accept the risk (note in end-of-turn summary)" },
      { label: "Reject", description: "Discard these beads and start over with a different goal" }
    ],
    multiSelect: false
  }])
  ```
  AND add this note immediately below the menu:
  ```
  > **Cosmetic-lint exception:** If ≥ 50% of the weak-bead reasons are lint cosmetic flags
  > (e.g. "title not a verb phrase" on wave-prefix beads like `R1:`, `T13:`, `D12:`), surface
  > them to the user as "cosmetic only" in `<weak-bead-summary>` and pre-recommend "Launch
  > anyway". Title-format lint on wave-prefix beads is a known false-positive — do not force
  > a polish round over it. Reserve polish rounds for substantive weakness (vague acceptance
  > criteria, missing WHY, oversized scope).
  ```
- **Rationale + evidence:**
  - 3 out of N beads this session were flagged title-not-verb-phrase — all 3 were intentional wave-prefix labels (`R1:`, `T13:`, `D12:`).
  - Plan quality score landed at 0.74 (below 0.75) largely because of this. User ratified anyway; no downstream issues.
  - Without this exception, the skill forces a polish round that accomplishes nothing for the cosmetic lint — wasted cycle and reinforces "threshold theater" behavior.
  - The fix preserves the gate for substantive quality issues while carving out the known false-positive.

---

### Change 3: Add a "decisive convergence" pattern callout to `_implement.md` after successful wave

- **File + section:** `skills/start/_implement.md` — add a note in the "Stuck-swarm diagnostics" table area, or as a new sub-section after line 96 (the "Post-wave bridge to Step 8" note).
- **BEFORE:** (no existing guidance on parallel-wave `dist/` build races)
- **AFTER:** (insert after line 96, before `### Stuck-swarm diagnostics`):
  ```
  ### Parallel-wave build-artifact races

  When multiple impl beads in the same wave all trigger `npm run build` (or equivalent),
  they will each rebuild `dist/` or equivalent output directory. Byte-identical outputs
  are fine — git will only see one change — but **different commit orderings can confuse
  git blame** (bead B's commit may ship bead A's dist/ and vice versa).

  **Recommended pattern:**
  - Designate ONE bead per wave as the "build-committer" — only that bead commits
    `dist/`. Other beads commit src/ only.
  - Alternative: defer the `dist/` commit to Step 9.5 wrap-up, where the coordinator
    runs one final `npm run build` and commits the bumped output alongside the version
    bump. This is the pattern used by v3.4.0 — clean git log, no cross-bead confusion.

  If you observe two beads committing the same `dist/` bytes, note it in end-of-turn
  summary but do NOT retroactively squash — the history is accurate and future bisects
  still land on the correct src/.
  ```
- **Rationale + evidence:**
  - One incident this session (I3 + I2 both committed byte-identical `dist/`). Not a bug, but confusing during release review.
  - Low-cost documentation fix that codifies the v3.4.0 pattern so future waves don't repeat the ambiguity.
  - Single incident, but the pattern is reproducible any time a parallel wave touches a built artifact — worth writing down before it bites on a non-identical-bytes case.

---

## Lower-confidence observations (≤ 2 data points — flag but don't propose)

- **Agent Mail contact_policy default blocks peer-to-peer first-send.** 2 incidents this session (planner and reviewer first sends). Workaround (embed summary in task-return) worked. F1 already auto-sets coordinator policy; extending to all bootstrap calls is a candidate for a future F-bead, but the SKILL-level fix would be a one-liner in the agent prompt template and may belong in the `agent-mail` skill rather than `skills/start/`. Revisit if it recurs.
- **Codex sandbox ↔ Agent Mail gap.** 1 incident (codex:codex-rescue robustness planner). Already documented as degraded mode in SKILL.md §0f. The fallback worked. No skill change needed unless this becomes frequent.
- **Plan quality threshold calibration.** The 0.75 threshold fired once as a false positive (Change 2 addresses the cosmetic-lint case), but the broader question "is 0.75 the right number?" needs more sessions' data to answer. Track across next 3 cycles before proposing a threshold change.

---

**Total high-confidence changes:** 3 (br CLI reference card, cosmetic-lint exception to low-quality gate, parallel-wave build-artifact guidance).
**Net additions:** ~60 lines across 2 files. No deletions.
**Risk:** Low — all three are additive; none weaken an existing gate.
