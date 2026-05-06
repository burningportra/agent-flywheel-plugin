> Archived into [docs/research/research-apr-pro-phase-archive-2026-05-06.md] on 2026-05-06.

# Phase 2: APR-Pro Deep Dive — Top 3 Tangents

**Date**: 2026-05-05
**Researcher**: CoralBrook (claude-opus-4-7)
**Project**: Automated Plan Reviser Pro (apr) v1.2.2
**Phase 1 reference**: `docs/research/apr-pro-phase1-explore.md`

Selected the three tangents most relevant to agent-flywheel's plan-revision flow (Step 5.45, `flywheel_plan`, coverage validation): **T2 Convergence Heuristics**, **T3 Document Bundling & git-diff prompts**, **T4 TUI + Robot Mode sync**.

---

## T2 — Convergence Heuristics

### Mechanism (how APR-Pro implements it)

APR-Pro stores per-round metrics in `.apr/analytics/<workflow>/metrics.json` (schema_version `1.0.0`) and computes a **convergence score** as a percentage from a small set of trend signals. The persisted shape is:

```jsonc
// .apr/analytics/<workflow>/metrics.json (excerpt from apr lines ~1640+)
{
  "schema_version": "1.0.0",
  "workflow": "default",
  "rounds": [
    {
      "round": N,
      "documents": {
        "readme": {"char_count":…, "word_count":…, "line_count":…,
                   "heading_count":…, "code_block_count":…,
                   "link_count":…, "list_item_count":…},
        "spec":   {…},
        "implementation": {…},
        "output": {…, "diff_ratio": 0.265, "similarity_score": 0.82}
      }
    }
  ],
  "convergence": {
    "detected": false,
    "confidence": 0.0,
    "estimated_rounds_remaining": null,
    "signals": {
      "output_size_trend": "decreasing",
      "change_velocity":   "decreasing",
      "similarity_trend":  "increasing"
    }
  }
}
```

The status mapping is a simple percent-bucket ladder (apr script, near line ~3000 in the stats command):

```bash
if   (( percent >= 90 )); then status="Converged"
elif (( percent >= 75 )); then status="Nearly Converged"
elif (( percent >= 50 )); then status="Approaching Convergence"
fi
```

Per-document metrics include not just byte/word/line counts but **structural** counts (headings, code blocks, links, list items), plus per-output `diff_ratio` and `similarity_score` versus the previous round. Convergence is therefore a **multi-signal score**, not a single delta-percent threshold. The repo also uses a "soft hint" heuristic shown in CLI output:

```
elif [[ "$round_num" -ge 5 ]]; then
    print_dim "Tip: After 5+ rounds, look for convergence - similar feedback suggests stability"
```

### Why it works (underlying principle)

1. **Multi-axis trend > single delta.** Three orthogonal trends (output_size, change_velocity, similarity) each move monotonically as the document stabilizes. Requiring all three to point the right way before signaling "converged" is far more robust than any single line-count delta.
2. **Structural metrics catch shape changes.** Reviewers can rewrite a section to identical word count but different headings/code-blocks; counting those explicitly catches "swapping content" rounds that pure size deltas miss.
3. **Estimated-rounds-remaining is honest.** The schema persists `null` when uncertain rather than guessing — a property worth copying.
4. **Soft thresholds + bands.** 50 / 75 / 90 percent give the user (and downstream agents) a graceful ramp instead of a binary stop signal.

### How it maps to agent-flywheel

| APR-Pro signal           | Flywheel surface                                                                 |
|--------------------------|-----------------------------------------------------------------------------------|
| `output_size_trend`      | `flywheel_plan` plan-doc growth across revisions (Step 5.45 refine cycles)        |
| `change_velocity`        | Bead churn between waves — beads added/closed/reopened per advance                |
| `similarity_trend`       | Cosine/diff_ratio of the plan doc itself across `flywheel_plan` calls             |
| `convergence.detected`   | Auto-arm "Approve" in Step 5.45 picked-up-plan menu                               |
| `convergence.confidence` | Weight given to scrap-vs-refine recommendations in `flywheel_review`              |

Concrete files:
- `skills/start/_review.md` — convergence summary block belongs here.
- `mcp/flywheel_plan` (the planner MCP tool) — emit a `convergence` object in the plan response, mirroring APR's shape.
- `skills/start/_picked_up_plan.md` (Step 5.45) — gate the "approve" menu item on `convergence.detected || percent >= 75`.

### Adoption proposals

1. **Persist a `flywheel_convergence.json`** beside each plan doc with the same three signals (size_trend, change_velocity, similarity_trend) — re-use APR's bucket ladder verbatim.
2. **Auto-suggest "approve" in Step 5.45** when percent ≥ 75; auto-suggest "refine" when 50–75; auto-suggest "scrap" when output_size_trend is `increasing` and similarity_trend is `decreasing` for 3+ rounds.
3. **Track `estimated_rounds_remaining`** in `flywheel_plan` output and surface it in `/flywheel-status` — even just "?" vs "1–2" is enough to set user expectations.

---

## T3 — Document Bundling & git-diff Prompts

### Mechanism (how APR-Pro implements it)

The bundler is `build_revision_prompt()` (apr script, lines ~1567–1622). It loads a YAML-pinned template and assembles a single composite prompt with **explicit document markers** delegated to Oracle's `--file` mechanism rather than inlined text:

```bash
# apr lines ~1567-1586
build_revision_prompt() {
    local include_impl="${1:-false}"
    local config_file="${2:-}"
    local template=""
    template=$(load_prompt_template "$include_impl" "$config_file")
    if [[ -n "$template" ]]; then
        printf '%s\n' "$template"; return 0
    fi
    # …default template follows
}
```

The default template's structure:

```
First, read this README:
```
<contents of README will be included by oracle>
```

---

[OPTIONAL when include_impl=true]
And here is a document detailing the implementation; you should also keep
the implementation in mind as you think about the specification, since
ultimately the specification needs to be translated into code eventually!
```
<contents of implementation will be included by oracle>
```

---

NOW: Carefully review this entire plan for me and come up with your best
revisions in terms of better architecture, new features, changed features,
etc. to make it better, more robust/reliable, more performant, more
compelling/useful, etc.

For each proposed change, give me your detailed analysis and
rationale/justification for why it would make the project better along
with the git-diff style change versus the original plan shown below:

```
<contents of spec will be included by oracle>
```
```

Two more nuances:

- The actual document content is passed via `file_args+=(--file "$spec_path")` rather than concatenated — Oracle handles ingestion. The prompt holds only **structural anchors** ("read this README", "here is implementation").
- A **prompt quality gate** runs before send: `prompt_quality_check "$prompt" "$config_path" "prompt"` refuses execution if the template still contains unexpanded placeholders, returning `validation_failed` in robot mode.
- Implementation doc inclusion is **periodic, not constant**: the workflow YAML supports `impl_every_n: 4` so impl is bundled every Nth round only. The CLI nudges this:
  ```
  Tip: Try impl_every_n: 4 in workflow to auto-include impl periodically
  ```

The "git-diff style" output the user asks for is **prompt-side**, not pre-computed: APR doesn't generate a diff for the model. It asks the model to phrase its proposed edits as diffs against the spec it just read. The model produces the diff; APR captures the response and persists `diff_ratio` / `similarity_score` after the fact.

### Why it works (underlying principle)

1. **Templates as policy, files as data.** Pinning the prompt template in workflow YAML (`template:` block) means prompt evolution is reviewable in git. The data (README/spec/impl) flows through file references, never copy-pasted into the prompt body.
2. **Asking for diffs is cheaper than computing them.** The model already has the source text — having it emit unified-diff hunks shifts the cost of "what changed" onto the LLM and gets human-readable rationale alongside.
3. **Periodic implementation context.** `impl_every_n` keeps the prompt small in pure-spec rounds and re-anchors against code reality every Nth round. Avoids prompt bloat *and* drift.
4. **Pre-flight quality gate.** Refusing to send a prompt with unexpanded placeholders is a cheap, deterministic check that prevents an expensive Oracle round from being wasted.

### How it maps to agent-flywheel

| APR-Pro mechanism                  | Flywheel surface                                                              |
|------------------------------------|-------------------------------------------------------------------------------|
| `build_revision_prompt()`          | `mcp/flywheel_plan` prompt assembly + `skills/start/_review.md` review prompt |
| `template:` in workflow YAML       | `flywheel.config.yaml` — pin a `plan_review_template` field                   |
| `--file` for spec/impl ingestion   | Plan + bead-graph + code passed as file references in agent-mail messages     |
| `impl_every_n`                     | "Re-anchor against current code every N waves" in `flywheel_advance_wave`     |
| Prompt asks for git-diff hunks     | Step 5.45 refine cycle should request unified-diff style plan changes         |
| `prompt_quality_check`             | Pre-send gate inside `flywheel_plan` and `flywheel_review`                    |

Concrete files:
- `skills/start/_review.md` — adopt the "produce unified-diff hunks vs the previous plan" instruction.
- `mcp/flywheel_plan` source — pull templates from a repo-tracked YAML rather than inline strings.
- `skills/start/_picked_up_plan.md` (Step 5.45 refine branch) — request git-diff output explicitly.

### Adoption proposals

1. **Pin the plan-review prompt template in `flywheel.config.yaml`** under `templates.plan_review` and `templates.plan_review_with_code`, mirroring APR's `template` / `template_with_impl` split.
2. **Have Step 5.45 "refine" ask the model for unified-diff hunks** against the prior plan (rather than free-form revisions) so the diff can be applied programmatically and `similarity_score` computed cheaply.
3. **Add a pre-send `prompt_quality_check`** to `flywheel_plan` / `flywheel_review` that scans for unexpanded `{{placeholders}}` and returns `validation_failed` before any agent spawn — cheap insurance against template-rot.
4. **Implement `code_every_n`** so plan-revision rounds re-bundle the actual source tree every N iterations rather than every round, keeping wave prompts lean.

---

## T4 — TUI + Robot Mode Sync

### Mechanism (how APR-Pro implements it)

APR's dashboard does **not** share in-memory state with running rounds. Instead the dashboard is a pure reader of files that the background `apr run` workers write atomically:

```bash
# Dashboard activity flag (apr lines ~181-200)
DASHBOARD_ACTIVE=false
cleanup_temp() {
    release_lock 2>/dev/null || true
    if [[ "${DASHBOARD_ACTIVE:-false}" == "true" && -t 2 ]]; then
        dashboard_show_cursor 2>/dev/null || true
        dashboard_clear     2>/dev/null || true
    fi
}
```

The dashboard interactions are key-driven (`r=refresh`, `q=quit`, `↑/↓` navigate, `Enter` details, `d` diff with previous):

```
Keys: Enter=details  d=diff  r=refresh  ?=help  q=quit
```

`r` triggers a re-read of `metrics.json` — the dashboard never polls, the user pulls. Round metadata flows through three coordinated artifacts:

1. **Lock file** (`flock` FD or PID-file fallback) — prevents two `apr run` invocations from racing on the same workflow.
2. **Background-detached lock** — `background_lock_detach_parent "$oracle_pid"` writes the **child** PID into the lockfile so the parent shell's EXIT trap won't release it prematurely. This is the key trick that lets the foreground TUI exit while the worker keeps the lock.
3. **Atomic metrics writes** — `mktemp` in the metrics directory then rename, so dashboard reads never see torn JSON:
   ```bash
   tmp_file=$(mktemp -p "$metrics_dir_path" "metrics.json.tmp.XXXXXX" …)
   ```

Robot mode returns the session descriptor immediately on spawn:

```jsonc
// apr robot run <round> response
{
  "ok": true, "code": "ok",
  "data": {
    "slug": "apr-round-N-…",
    "pid":  12345,
    "output_file": ".apr/rounds/<wf>/round_N.md",
    "log_file":    "/tmp/apr-…log",
    "workflow": "<wf>", "round": N,
    "include_impl": false,
    "status": "running"
  },
  "hint": "Use 'apr status' or 'apr attach apr-round-N-…' to monitor"
}
```

The `slug` is the join key. `apr status` and `apr attach <slug>` re-derive state from `oracle status` + the metrics file, never from in-process memory.

### Why it works (underlying principle)

1. **File-system as bus.** Three pieces of state (lock, log, metrics) coordinate three views (foreground TUI, background worker, robot-mode JSON). Each component reads from disk; nobody owns shared memory.
2. **Detached lock survives parent exit.** Writing the child PID into the lockfile decouples lock lifetime from shell session lifetime — the canonical fix for "started in background, terminal closed, lock leaked".
3. **Pull-don't-push refresh.** A dashboard that polls every second is wasted CPU 99% of the time. APR's "press `r`" model is lazy and avoids tearing.
4. **Slug as opaque identity.** The dashboard, robot mode, and `attach` all key on the same slug — no ambiguity about which round you're talking to.

### How it maps to agent-flywheel

Flywheel already has the analogous components but not the same discipline:

| APR-Pro pattern                          | Flywheel surface                                                       |
|------------------------------------------|------------------------------------------------------------------------|
| `.apr/.sessions/<slug>.pid`              | NTM pane PIDs + agent-mail agent names                                 |
| `metrics.json` (atomic writes)           | `.flywheel/state.json` and bead store (br/bv)                          |
| `apr status` reads disk only             | `/flywheel-status` should read disk only, never IPC                    |
| `apr attach <slug>`                      | `ntm robot-attach` — already exists for panes                           |
| `background_lock_detach_parent`          | Currently missing — flywheel sessions can drop locks on parent exit    |
| `r=refresh` pull model in TUI            | Step 5.45 menu should re-read state on each keypress, not cache        |
| Slug join key                            | Bead ID + agent-name pair could serve, but isn't consistently used      |

Concrete files:
- `mcp/flywheel_observe` — should be a pure file reader (mirrors `apr robot status`).
- `skills/start/_picked_up_plan.md` (Step 5.45) — re-read plan + bead state on every menu render, not on session start.
- `flywheel-cleanup` — adopt APR's "PID written into lockfile" trick to detect stale locks reliably.

### Adoption proposals

1. **Make `flywheel_observe` purely file-driven** — no shared memory with `flywheel_plan`/`flywheel_advance_wave`; same disk contract APR uses (lock + atomic metrics + slug index).
2. **Adopt detached-PID locks for swarm sessions** so `flywheel-swarm-stop` and `flywheel-cleanup` can distinguish "parent exited, worker alive" from "everything dead" without false positives — the exact `background_lock_detach_parent` move.
3. **Refresh the Step 5.45 menu lazily** with an explicit `r` key instead of subscribing — re-read plan/bead/inbox state on demand. Cheaper, fewer races, matches how `apr dashboard` stays in sync with background rounds.

---

## Synthesis

The three tangents share one underlying recipe: **persist structured state to disk under atomic writes, and let multiple views derive themselves from that file.** APR-Pro applies it to convergence metrics (T2), prompt templates (T3), and session monitoring (T4). Flywheel already has most of the moving parts (beads, agent-mail messages, NTM panes) but doesn't yet have a single "state.json + atomic writes + slug join key" discipline that would make `flywheel_observe`, Step 5.45, and the swarm lifecycle behave the same way regardless of who's reading.

**Top adoption candidates (one-liners):**
- Pin plan-review prompt templates in `flywheel.config.yaml` and gate sends with a `prompt_quality_check`.
- Persist a `flywheel_convergence.json` per plan (size_trend / change_velocity / similarity_trend) and use APR's 50/75/90 ladder to drive Step 5.45 menu defaults.
- Adopt detached-PID locks + atomic state writes so `flywheel_observe` and `/flywheel-status` are pure disk readers.
- Have the refine branch of Step 5.45 ask the model for **unified-diff hunks** vs the prior plan (cheap similarity scoring + applyable changes).
- Add `code_every_n` / `impl_every_n`-style periodic re-anchoring in `flywheel_advance_wave` to keep wave prompts lean.
