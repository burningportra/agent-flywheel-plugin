# Phase 6a: APR-Pro → Agent-Flywheel Adoption Proposals

**Date**: 2026-05-05
**Author**: claude-opus-4-7 (Phase 6a — technical adoption half)
**Sibling**: `docs/research/apr-pro-ergonomics.md` (sonnet, dev-UX half)
**Inputs**: `apr-pro-phase1-explore.md`, `apr-pro-phase2-deep.md`, `apr-pro-phase3-invert.md`, `apr-pro-phase4-blunders.md`

---

## Executive Summary

1. **Adopt APR's "atomic state on disk + pull-don't-push readers" discipline** for the Step 5.45 menu, `flywheel_observe`, and swarm pane state. This is the single most-leveraged adoption — it dissolves a class of races we will otherwise hit as the swarm grows.
2. **Replace ad-hoc plan/review prompt strings with versioned templates** in `flywheel.config.yaml`, gated by a `prompt_quality_check` pre-send. APR's `build_revision_prompt()` shows the exact split (`template` vs `template_with_impl`) and the placeholder-scan gate is ~30 lines for a real win.
3. **Persist a `convergence.json` per plan** with three orthogonal signals (size_trend, change_velocity, similarity_trend) and a 50/75/90 ladder driving Step 5.45 menu defaults — but upgrade the detector to a ring-buffer + sign-flip oscillation check (B6 fix) instead of APR's average-only formula.
4. **Have Step 5.45 "refine" ask the model for unified-diff hunks** against the prior plan + current code tree (T3 pattern) so similarity scoring is cheap and changes are programmatically applyable. Pair with `code_every_n` periodic re-anchoring inside `flywheel_advance_wave` to keep wave prompts lean.
5. **Adopt detached-PID locks + ownership-stamped reservations** so `flywheel-cleanup`, `flywheel-swarm-stop`, and Agent Mail's `force_release_file_reservation` can distinguish "parent exited, worker alive" from "everything dead" without the 2-hour-TTL guesswork APR fell into (B3, anti-pattern #4).

---

## Adoption Proposals

### P1. Convergence as a multi-signal score driving Step 5.45 menu defaults

**Pattern.** APR-Pro persists three orthogonal trend signals (`output_size_trend`, `change_velocity`, `similarity_trend`) plus structural-metric counts (headings, code-blocks, links, list items) in `metrics.json`, then maps a weighted score onto a 50/75/90 percent ladder ("Approaching" / "Nearly" / "Converged").

**Why it works.** Three signals pointing the same direction is a much more robust stopping rule than a single line-count delta. Structural counts catch "swap content, same word count" rounds that pure size deltas miss. Soft thresholds give the user (and downstream automation) a graceful ramp instead of a binary stop signal.

**Flywheel surface.**
- New file: `.flywheel/plans/<plan-slug>/convergence.json` (atomic-write contract)
- MCP tool: `flywheel_plan` returns a `convergence` block in its response payload
- Skill: `skills/start/_picked_up_plan.md` (Step 5.45) reads the file to set menu defaults
- Skill: `skills/start/_review.md` surfaces the convergence summary block
- Helper: `polishConverged` (existing in flywheel) upgraded to read this signal instead of its current heuristic

**Implementation sketch.**
- Schema mirrors APR's: `{schema_version, signals: {output_size_trend, change_velocity, similarity_trend}, score: float, status: "...", confidence: float, estimated_rounds_remaining: int|null}`.
- Compute structural metrics (heading_count, code_block_count, link_count, list_item_count) per revision in addition to size — APR's `collect_metrics()` is the reference shape.
- Step 5.45 default-arm:
  - score ≥ 0.75 → "Approve" highlighted
  - 0.50 ≤ score < 0.75 → "Refine" highlighted
  - score declining for 3+ revisions with size growing → "Scrap" surfaced
- `estimated_rounds_remaining` must be `null` (not 0, not a guess) when oscillation is detected — APR's `(1 - score) * 5` linear estimate is exactly the gaslight pattern B6 calls out.

**Trap-avoidance.**
- **B6 (oscillation blindness).** APR averages first-half vs second-half — sign-flips are invisible. Our detector MUST count round-to-round delta sign-flips over a ring buffer of the last N revisions. If sign-flip count > floor(N/3), set `status: "oscillating"` and refuse to estimate `rounds_remaining`. See P3 for the ring-buffer mechanics.
- **B11 (silent zero-confidence on missing dep).** Any missing dependency in the convergence calculator must `exit dependency_missing` (or return a `code: "dependency_missing"` envelope), never a permissive `confidence: 0.0`.
- **Anti-pattern #3 (hardcoded round counts).** Score is the gate, round count is just a render label. Wave/round numbers stay opaque IDs in storage (existing flywheel ULID convention).

---

### P2. Versioned prompt templates in `flywheel.config.yaml` with a placeholder pre-send gate

**Pattern.** APR's `build_revision_prompt()` loads a YAML-pinned template, substitutes well-known placeholders, then runs `prompt_quality_check` which refuses to send if any unexpanded `{{placeholder}}` remains, returning `validation_failed` cheaply before any expensive LLM call.

**Why it works.** Templates-as-policy means prompt evolution is git-reviewable. The pre-send placeholder scan is ~30 lines that catches a whole class of expensive failures (template-rot, missing variable, typo in interpolation) at near-zero cost. Splitting `template` / `template_with_impl` lets you periodically re-anchor without bloating every round.

**Flywheel surface.**
- Config: `flywheel.config.yaml` gains a `templates:` block
  - `templates.plan_review` — base plan-revision prompt
  - `templates.plan_review_with_code` — variant including current source tree
  - `templates.bead_review` — Step 5.45 validate prompt
  - `templates.scope_drift` — drift-check prompt
- MCP tool: `flywheel_plan`, `flywheel_review`, `flywheel_advance_wave` all pull from `templates.*` instead of inline strings
- New helper: `lib/prompt-quality-check.ts` — single-pass `{{...}}` scanner returning `{ok: bool, unexpanded: string[]}`
- Skill: `skills/start/_picked_up_plan.md` refine branch wires this template in

**Implementation sketch.**
- Place templates as multi-line YAML strings; substitute via mustache-style `{{var}}` only (no logic in templates).
- `prompt_quality_check(prompt: string)` returns failure if any `/\{\{[^}]+\}\}/` remains; the MCP tool returns `{ok: false, code: "validation_failed", hint: "Unexpanded placeholders: ..."}` and skips the agent spawn.
- Add a `templates_schema_version` field at top of the templates block; bump on breaking changes; refuse to load mismatched versions instead of silently using stale shape.
- Step 5.45 refine branch: prompt asks the model for **unified-diff hunks** against the prior plan, not free-form revisions. Cheap to compute `similarity_score` from the resulting diff; produces programmatically applyable changes.

**Trap-avoidance.**
- **Anti-pattern #5 (NIH formats).** Templates stay plain Markdown; substitution stays mustache. Do NOT invent a flywheel-specific template DSL.
- **Anti-pattern #6 (schema leakage).** Users do not hand-author the templates block in normal use; it's plugin-shipped. Override via a `flywheel templates pin` command, never via a hand-edit ritual.
- **B5 (stacked workarounds).** When a provider channel (Codex attachment, Gemini file-ref) is flaky, instrument the failure mode before falling back to "inline everything in the template." Tagging the failure ensures we can detect when the upstream bug gets fixed.

---

### P3. Ring-buffer convergence with explicit oscillation detection

**Pattern (anti-pattern, inverted).** APR's `calculate_convergence` is `0.35*output_trend + 0.35*change_velocity + 0.30*similarity_trend` over first-half-vs-second-half averages. Oscillation is invisible: round 4 grows, 5 shrinks, 6 grows → low average diff, falsely "converged" (B6).

**Why our upgrade works.** A ring buffer of the last N revisions (N=6 is a reasonable default — APR's "5+ rounds" hint is roughly the same window) lets us count sign-flips of round-to-round deltas. Direction agreement across all three signals becomes a hard gate, not just a weighted average. This is a strict superset of APR's detector.

**Flywheel surface.**
- File: `lib/convergence.ts` — pure function, golden-tested
- Reads/writes: `.flywheel/plans/<plan-slug>/convergence.json` (P1)
- Consumer: `flywheel_plan` populates this on every revision; Step 5.45 reads it

**Implementation sketch.**
- Maintain a `revisions: [{round, output_size, diff_ratio, similarity_score, structural_counts}]` ring buffer of length N=6.
- Compute three signals as APR does (size_trend, change_velocity, similarity_trend), AND a fourth: `oscillation_count` = number of sign flips of round-to-round size delta in the buffer.
- Convergence rule:
  - If `oscillation_count > floor(N/3)` → `status: "oscillating"`, `estimated_rounds_remaining: null`, weighted score capped at 0.50.
  - Else apply APR's weighted score + 50/75/90 ladder.
- Refuse to set `detected: true` unless all three trends agree on direction (size decreasing, velocity decreasing, similarity increasing).
- Golden-file tests: a known-asymmetric oscillating fixture should produce `status: "oscillating"`, never `"converged"`.

**Trap-avoidance.**
- **B4 (diff direction reversed).** Name parameters explicitly (`baseline_round`, `candidate_round`), never positional. Golden-test the rendering layer with an asymmetric fixture so a reversal causes a snapshot diff.
- **B6 (oscillation).** This proposal is the explicit fix.
- **B11 (silent zero-confidence).** Missing `bc`/numeric helper → `exit dependency_missing`, not "score 0.0."

---

### P4. `flywheel_observe` as a pure disk reader; atomic state writes everywhere

**Pattern.** APR's dashboard never shares memory with the worker. Lock file + atomic `metrics.json` (mktemp + rename) + slug-keyed session descriptors form a "filesystem-as-bus." `apr status`, `apr attach`, dashboard-`r=refresh` all derive from the same on-disk state.

**Why it works.** Three views of the same state cannot drift, because there is exactly one source of truth. Atomic writes mean readers never see torn JSON. Pull-don't-push refresh saves CPU and avoids tearing. Slug as opaque join key removes ambiguity about which round/wave/bead anyone is talking to.

**Flywheel surface.**
- MCP tool: `flywheel_observe` (or `orch_observe`) — refactor to a pure file reader; no IPC with `flywheel_plan` / `flywheel_advance_wave`
- File: `.flywheel/state.json` — atomic-rename writes only (mktemp in same dir → fsync → rename)
- File: `.flywheel/swarm/<pane-slug>.json` — per-pane state, atomic-rename, owned by the pane process
- Consumers: `/flywheel-status` skill, Step 5.45 menu render, `flywheel-swarm-status`, `flywheel-doctor`

**Implementation sketch.**
- Add `lib/atomic-json.ts` with `writeAtomic(path, obj)` (mktemp in same dir, fsync, rename) and `readJson(path)` (with single retry on `ENOENT` mid-rename, transparent JSON parse error path).
- `flywheel_observe` refuses to take any "live" arguments — it only takes a project root and returns the on-disk state.
- Step 5.45 menu re-reads state on every render keypress (explicit `r=refresh`-style), not at session start. Cheap (state.json should be <50KB) and matches APR's pull-don't-push model.
- Pane-state atomic writes carry an `instance_uuid` so cleanup hooks can verify ownership before unlinking (see B3 fix in P5).

**Trap-avoidance.**
- **Anti-pattern #4 (`.apr/` ad-hoc state).** Schema-version every state file (`schema_version: "1.0.0"`), refuse to load mismatched versions, write a migrator before bumping.
- **B9 (mixed stdout/stderr in robot mode).** `flywheel_observe` emits machine-readable JSON on stdout only; any human-prose hint goes on stderr. Single-channel discipline.
- **Anti-pattern #5 (NIH formats).** State files are plain JSON. `jq` works.

---

### P5. Detached-PID locks + ownership-stamped reservations (Agent Mail audit)

**Pattern.** APR's `background_lock_detach_parent "$oracle_pid"` writes the **child** PID into the lockfile so the parent's EXIT trap is a no-op when the worker is still alive. APR also has `release_lock` regression-tested to never delete a lock it doesn't own (B3).

**Why it works.** Decouples lock lifetime from shell session lifetime — the canonical fix for "started in background, terminal closed, lock leaked." Ownership stamping (PID + instance UUID) means cleanup hooks can verify before unlinking; absent ownership proof, leak deliberately and let the next startup reap it.

**Flywheel surface.**
- Audit: `mcp/agent-mail/file_reservation.ts` (or wherever `acquire`/`renew`/`release` live)
- MCP tool: `force_release_file_reservation` — ensure it requires either matching `instance_uuid` or an explicit `--force` flag
- Skill: `flywheel-cleanup` adopts a "verify ownership, else leak-and-tag" policy
- Skill: `flywheel-swarm-stop` writes its own instance UUID into the reservation it's releasing

**Implementation sketch.**
- Every reservation/lock record carries `{owner_pid, instance_uuid, started_at, last_renewed_at}`.
- Renewal extends `last_renewed_at`; staleness is `now - last_renewed_at > renewal_interval * 3`, NOT a 2-hour wall clock.
- Cleanup logic:
  - `instance_uuid` matches caller → release.
  - `instance_uuid` differs but `last_renewed_at` is fresh → refuse, return "owned by another instance."
  - Lock stale (no renewal in 3× interval) AND owner_pid no longer in process table → reap, log the reap.
  - Otherwise → leak and tag with `.suspect` suffix; `flywheel-doctor` surfaces it.
- Step 5.45 reads plan files via reservation; if the previous session crashed, the doctor surfaces the suspect reservation rather than letting Step 5.45 silently load a half-written plan.

**Trap-avoidance.**
- **B3 (release_lock deletes others' locks).** Verify ownership before unlinking; trap handlers must clear the lock-path variable as soon as ownership is handed off, so the trap is a no-op.
- **Anti-pattern #4 (2-hour TTL).** Renewable leases, not wall-clock TTL. Agent Mail already has `renew_file_reservations`; the audit is to ensure all callers actually renew on their hot loops.
- **B7 (silently ship truncated output).** Any "recovery failed, proceed" path moves the bad artifact aside with a `.truncated` suffix and refuses to update derived metrics.

---

### P6. Plan-vs-code git-diff bundling for Step 5.45 "Validate against code"

**Pattern.** APR asks the model to emit unified-diff hunks against the spec it just read, rather than computing the diff itself. The model has source text in context; emitting diff hunks shifts "what changed" cost onto the LLM and yields human-readable rationale alongside applyable patches. APR also passes documents as Oracle file references (`--file`), keeping the prompt body to structural anchors.

**Why it works.** Two wins in one: (a) the diff is cheap because the model is already producing structured output, (b) the resulting hunks are programmatically applyable for `similarity_score` computation and partial application. Periodic implementation context (`impl_every_n`) keeps the prompt small in pure-spec rounds and re-anchors against code reality every Nth round.

**Flywheel surface.**
- Skill: `skills/start/_picked_up_plan.md` (Step 5.45) "Validate against code" branch
- Skill: `skills/start/_picked_up_plan.md` (Step 5.45) "Refine" branch
- Config: `flywheel.config.yaml` gains `code_every_n: 4` (mirrors APR's `impl_every_n`)
- Helper: `lib/diff-bundling.ts` — given a plan path and a project root, build the bundle (file refs + structural anchors)
- MCP tool: `flywheel_advance_wave` consults `code_every_n` to decide whether to re-bundle the source tree

**Implementation sketch.**
- Use the LLM provider's structured content blocks (Claude `messages` with file content blocks; OpenAI tool-call structured inputs) — never inline-paste concatenated documents (anti-pattern #8).
- Pre-flight token counting per provider; fail loudly with `code: "context_overflow"` instead of silently truncating in the model.
- Refine prompt explicitly requests unified-diff hunks against `<plan_baseline>`; capture them in `.flywheel/plans/<plan-slug>/revisions/<rev>.diff` for audit.
- `code_every_n: 4` (default) means revisions 1, 5, 9 re-bundle the current source tree; revisions 2, 3, 4 only re-read the plan + last diff. Configurable per project.
- `similarity_score` derived from diff size vs plan size — same shape as APR's `diff_ratio`.

**Trap-avoidance.**
- **Anti-pattern #8 (inline-paste DOM bundling).** Use API-level structured content blocks; pre-count tokens; use unguessable markers (UUIDs) when ASCII delimiters are unavoidable to avoid collision with user content.
- **B5 (stacked workarounds).** If a provider's file-attachment channel is unreliable, log the failure mode (which provider, which file, which round) before falling back to inline. The instrumentation prevents the workaround from silently becoming load-bearing.
- **Anti-pattern #3 (hardcoded round counts).** `code_every_n` is a sampling rate, not a stopping rule. Convergence (P1/P3) decides when to stop.

---

### P7. Semantic exit codes / structured error envelope across all flywheel MCP tools

**Pattern.** APR's robot mode returns `{ok, code, data, hint, meta}` with semantic codes (`"ok"`, `"config_error"`, `"oracle_timeout"`, `"validation_failed"`, etc.) and matching exit codes (0/2/4/8/12/16). Agents can route on `.code` without parsing stderr.

**Why it works.** Agents can build retry/fallback logic on a closed enum of error classes instead of stderr substring matching. Non-contiguous numeric exit codes leave room for future expansion. Single-channel discipline (machine-readable on stdout, human prose on stderr) makes the contract debuggable with `jq`.

**Flywheel surface.**
- Schema: `lib/error-envelope.ts` — `type ToolResult<T> = {ok: boolean; code: string; data?: T; hint?: string; meta: {v: string; ts: string}}`
- All MCP tools (`flywheel_plan`, `flywheel_review`, `flywheel_observe`, `flywheel_advance_wave`, `flywheel_approve_beads`, `flywheel_verify_beads`, `flywheel_calibrate`, `flywheel_remediate`, `flywheel_doctor`) return this envelope
- Add a registry of canonical error codes: `validation_failed`, `dependency_missing`, `context_overflow`, `convergence_oscillating`, `reservation_owned_elsewhere`, `provider_unreachable`, `template_rot`, etc.

**Implementation sketch.**
- Define the closed enum in one file; tools import and use it; no string literals scattered.
- Retry classifier: argument errors (`validation_failed`, `usage_error`) → no retry; transient errors (`provider_unreachable`, `oracle_timeout`-equivalent) → retry with backoff. Apply to NTM/Codex/Gemini auto-retry paths so we never burn three attempts on a deterministic flag-typo (B8).
- Document the envelope and code list in MCP tool descriptions so agents can discover them.

**Trap-avoidance.**
- **B8 (retrying argument errors).** Classifier explicitly refuses to retry argument-class codes.
- **B9 (mixed channels).** Stdout = JSON envelope; stderr = human prose only. Documented in the MCP tool description.
- **B11 (silent permissive default on missing dep).** `dependency_missing` is its own code; gating callers must fail-closed on it.

---

### P8. Distribution audit: tagged releases, signed checksums, no curl-pipe-bash from `main`

**Pattern (anti-pattern, inverted).** APR's `curl | bash` install fetches `apr` from `main` with a same-repo SHA-256 and no signature verification. Auto-checksum CI races the verification CI (B2). This combination is fragile in normal operation and offers no protection against repo compromise.

**Why our discipline works.** Tagged releases pin a known artifact. Out-of-band signatures (Sigstore, GPG, GitHub release signing) survive repo compromise. Verification runs after autosync, gated on the autosync's success, so the race is structurally impossible.

**Flywheel surface.**
- Audit: any `bv`/`br`/`dsr` install scripts (the user already has `dsr` skill pointing this direction)
- CI: ensure dist-drift checks (`flywheel_doctor` `dist drift`) are not racing release autobuilders. If both write to the same artifact on `main`, gate the verifier on the publisher's success status.
- Distribution: prefer npm/cargo/brew with proper signing; reserve curl-pipe-bash for first-touch convenience and default it to the **latest tagged release** (`/releases/latest/download/...`), not `main`.

**Implementation sketch.**
- Inventory: list every install script and update channel currently in flywheel and downstream tools.
- For each: confirm tag-based pinning, signature verification path, no same-repo race.
- CI flow check: `release.yml` and `flywheel_doctor`'s drift check — if they both run on push-to-main, the drift check must `needs:` the publisher and use its outputs, not redo the work in parallel.
- Document `--version` pinning prominently in any user-facing curl-pipe-bash.

**Trap-avoidance.**
- **Anti-pattern #7 (same-repo checksum, `main` install).** Use tagged releases; checksums verified out-of-band.
- **B2 (auto-checksum CI race).** Verifier must `needs:` the autosync; never run them in parallel on the same ref.
- **B1 (mutating sibling tool's installed files).** Document this as a hard rule for flywheel skills: never `sed -i` a file inside another package's install dir. If you need to change behavior, fork-and-vendor or expose the knob upstream and pin the dependency.

---

## Anti-patterns we already avoid

- **6,900-line bash monolith.** Flywheel's MCP layer is TypeScript; performance-critical tooling (br/bv) is Rust. Shell stays as thin invocation glue.
- **Browser-driven LLM transport.** Flywheel uses real Claude/Codex/Gemini API auth via NTM panes, not browser DOM scripting against ChatGPT.
- **TOON / NIH wire formats.** Flywheel speaks JSON for tool I/O and Markdown for agent messages.
- **Single-engine hardcoding (B10).** Provider abstraction already centralizes Codex/Opus/Gemini routing — keep it that way; reject any flag-construction that fans out to multiple call sites.
- **Recovery silently committing truncated output (B7).** Flywheel's bead-completion path requires explicit verification before close; partial output is not silently merged.

These confirmations should land in `flywheel.config.yaml` (or AGENTS.md) as explicit "non-goals" so future contributors see them.

---

## Open Questions (study before adopting)

1. **Where does `flywheel_observe` currently get its data?** If it already reads from disk, P4 is a documentation/discipline change. If it queries running services, it's a real refactor — bead it accordingly.
2. **Does Agent Mail's `file_reservation` already record `instance_uuid`?** P5 audit is straightforward if yes; otherwise it's a schema migration. Check `mcp/agent-mail/`.
3. **Plan storage layout.** Where do plans live today (`docs/plans/`? `.flywheel/plans/`?), and is the path stable enough to host `convergence.json` siblings? Settle this before P1.
4. **Token-counting libraries per provider.** P6's pre-flight overflow check needs reliable token counts for Claude, Codex, and Gemini. `@anthropic-ai/tokenizer` exists; verify Codex/Gemini equivalents.
5. **Existing `polishConverged` semantics.** P1 proposes upgrading it; need to read its current callers to ensure the new signal shape is backward-compatible or to plan the migration.
6. **Does any flywheel skill currently `sed -i` a sibling tool's install file?** B1's analog. Greppable audit before declaring "we already avoid this."
7. **Schema versioning policy.** P4 proposes `schema_version` on every state file. Is there an existing convention to align with, or do we set one now?
8. **Wave-numbering surface.** Are wave numbers already opaque ULIDs in storage, or do beads/checkpoints use human-readable `wave-N` as primary keys? Anti-pattern #3 needs this clarified.

---

## Cross-Reference: APR Phase Anchors → Proposals

| Cross-phase anchor (user priority) | Proposal |
|---|---|
| Convergence heuristics → Step 5.45 menu defaults + `polishConverged` upgrade | **P1** |
| Plan-vs-code git-diff bundling → Step 5.45 "Validate against code" prompt construction | **P6** |
| Detached-PID + atomic state → `flywheel_observe` as pure disk reader; swarm pane-state via mv-atomic JSON | **P4, P5** |
| Pinned prompt templates → `flywheel.config.yaml` namespace | **P2** |
| Oscillation blindness (B6) → upgrade convergence to ring-buffer comparison | **P3** |
| Lock-file ownership (B3) → audit Agent Mail file_reservation semantics | **P5** |
| Auto-checksum CI race (B2) → check our release CI flow | **P8** |
| Hardcoded round counts (anti-pattern #3) → keep flywheel metric-driven | **P1, P3** (round count is a render label, not a gate) |

---

## Suggested bead breakdown

A next-step planner could split this file into the following beads (rough sizing):

- **B-APR-1** (M): P1 + P3 — convergence schema, ring buffer, oscillation gate, golden tests. Single PR.
- **B-APR-2** (S): P2 — templates block in `flywheel.config.yaml` + `prompt_quality_check` helper. Thread through `flywheel_plan`/`flywheel_review` callers.
- **B-APR-3** (M): P4 — atomic-json helper, `flywheel_observe` refactor to pure reader, schema-version every state file.
- **B-APR-4** (M): P5 — Agent Mail reservation audit, ownership stamping, `flywheel-cleanup` policy update.
- **B-APR-5** (S): P6 — `code_every_n`, unified-diff prompt in Step 5.45 refine branch, structured content blocks.
- **B-APR-6** (S): P7 — error envelope, code registry, retry classifier (depends on B-APR-3).
- **B-APR-7** (S): P8 — distribution + CI audit checklist; mostly investigative.

Dependency edges: B-APR-3 blocks B-APR-1, B-APR-4, B-APR-6. B-APR-2 is independent. B-APR-5 depends on B-APR-2. B-APR-7 is independent.
