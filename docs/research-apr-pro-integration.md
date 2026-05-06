# Integration Proposal — APR-Pro Convergence + Bundling + Atomic State Cluster

**Date.** 2026-05-05
**Pipeline.** Phase 8 (Major Feature Integration mode) → Phase 9 (iterative deepening) → Phase 10 (5x blunder hunt) → Phase 12 (final synthesis)
**Source research.** [`docs/research-automated_plan_reviser_pro-2026-05-05.md`](./research-automated_plan_reviser_pro-2026-05-05.md)
**Cluster scope (Phase 8 baseline).** A1 (multi-signal convergence) + A2 (plan-vs-code git-diff bundling) + A3 (atomic disk state).
**Excluded from Phase 8.** A4 (prompt templates) and A5 (structured envelope) — sequenced after.

> **Reader's guide.** This document is layered: Phase 8 framed a 3-cluster cluster; **Phase 9 (this rewrite) argues the cluster should be larger and more ambitious — fold in A4/A5 and re-base everything on a versioned event substrate**; Phase 10 then stress-tests Phase 9 from five adversarial angles; Phase 12 reconciles. The Phase 12 final verdict (at the bottom) lands closer to Phase 8 than to Phase 9 — but Phase 9's reframing remains the most-ambitious version of the design and is preserved here as the lever the project should pull *eventually*, just not in v3.12.

---

## Why these three together

A1, A2, and A3 share **one foundational assumption**: flywheel state lives on disk as mv-atomic JSON, and every consumer re-reads on demand. Each builds on it:

- **A1** writes `.flywheel/plans/<slug>/convergence.json` per revision — needs atomic-write contract.
- **A2** generates a unified-diff bundle that becomes part of the refine prompt — wants to be cacheable on disk so the TUI can show "what changed since last revision" without re-running git.
- **A3** is the disk-state discipline itself.

Implementing them as a single cluster means one schema decision, one migration cut, one set of tests for atomicity / recovery / readers. Implementing them piecemeal forces the schema decision twice and creates two migration paths.

---

## Capabilities adopted

### C1 — Multi-signal convergence detection

Compute per-revision metrics:

```typescript
type RevisionMetrics = {
  schema_version: "1.0.0";
  revision_id: string;            // ULID
  timestamp: string;              // ISO-8601
  size: { lines: number; words: number; chars: number };
  structural: {
    headings: number;
    code_blocks: number;
    links: number;
    list_items: number;
  };
  diff_vs_prior: {
    added_lines: number;
    removed_lines: number;
    similarity_score: number;     // 0.0-1.0, jaccard or cosine
  } | null;                       // null on first revision
};
```

Aggregate three trends across the ring buffer of last N revisions (N=5 default):

```typescript
type ConvergenceState = {
  schema_version: "1.0.0";
  plan_slug: string;
  revisions: RevisionMetrics[];   // capped at N
  signals: {
    output_size_trend: number;    // -1.0 to 1.0; >0 means growing
    change_velocity: number;      // 0.0-1.0; magnitude of recent deltas
    similarity_trend: number;     // 0.0-1.0; how similar recent revs are
  };
  oscillation: {
    sign_flips: number;
    detected: boolean;            // true if sign_flips > floor(N/3)
  };
  score: number;                  // 0.0-1.0 weighted composite
  status: "diverging" | "approaching" | "nearly_converged" | "converged" | "oscillating";
  estimated_rounds_remaining: number | null;  // null when oscillating
  computed_at: string;
};
```

Score thresholds (50/75/90 ladder from APR):

- score < 0.50 → `"diverging"`
- 0.50 ≤ score < 0.75 → `"approaching"`
- 0.75 ≤ score < 0.90 → `"nearly_converged"`
- score ≥ 0.90 → `"converged"`
- `oscillation.detected = true` overrides → `"oscillating"`

### C2 — Plan-vs-code git-diff bundling

The Step 5.45 "Refine" branch generates a bundle:

```
.flywheel/plans/<slug>/refine-bundle-<revision-id>.md
```

Containing:

1. The current plan markdown.
2. For each path the plan claims (extracted in Step 5.45's existing path-claim parser): `git log -p --since=<plan-mtime> -- <path>` formatted as unified diff.
3. A "structural changes summary" from `RevisionMetrics.diff_vs_prior`.
4. The previous revision's content (or last N up to a token budget).

The bundle file is the *canonical* refine input. The LLM never receives a freshly-constructed prompt — it receives the bundle path or content. This makes refine prompts deterministic, cacheable, and replayable.

Pair with `code_every_n`: every `n` beads (default 5, tunable in `flywheel.config.yaml`), `flywheel_advance_wave` re-anchors by including full source of recently-touched files in the next wave's marching orders.

### C3 — Atomic disk state contract

**Write contract.** Every state mutation:

```typescript
async function atomicWrite(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, path);  // atomic on POSIX
}
```

**Read contract.** Every reader is pull-only — re-opens file on each call, caches with mtime invalidation:

```typescript
class AtomicJsonReader<T> {
  private cache: { mtime: number; data: T } | null = null;
  async read(): Promise<T> {
    const stat = await fs.stat(this.path);
    if (this.cache && this.cache.mtime === stat.mtimeMs) return this.cache.data;
    const data = JSON.parse(await fs.readFile(this.path, "utf8"));
    this.cache = { mtime: stat.mtimeMs, data };
    return data;
  }
}
```

**Layout.** All flywheel disk state moves under `.flywheel/`:

```
.flywheel/
├── plans/<slug>/
│   ├── plan.md                       # canonical plan
│   ├── convergence.json              # C1 ring buffer
│   ├── refine-bundle-<rev-id>.md     # C2 bundles
│   └── revisions/<rev-id>.md         # historical revisions
├── swarm/
│   └── panes/<pane-id>.json          # per-pane state (mv-atomic)
├── checkpoint.json                   # existing — moved here
└── beads/...                         # bead artifacts
```

---

## Mapping to existing flywheel architecture

| Cluster | Existing surface | New surface | Migration |
|---------|------------------|-------------|-----------|
| C1 | `polishConverged` boolean in `state.ts` | `ConvergenceState` JSON | `polishConverged = (status === "converged" \|\| status === "nearly_converged")` shim during transition |
| C1 | Step 5.45 menu defaults (currently always "Validate against code") | Score-armed default | New helper: `defaultStep545Action(convergence)` |
| C2 | Step 5.45 "Refine" prompt (inline string in `skills/start/SKILL.md` lines 518-594) | Bundle file → prompt | Replace inline string with `readFileSync(bundlePath)` |
| C2 | `flywheel_advance_wave` marching-order generation | + `code_every_n` re-anchoring | Add config field; apply when `wave % n === 0` |
| C3 | `state.ts` Map-based in-memory state | Per-entity disk JSON | Migration script copies in-memory → disk on first start |
| C3 | `flywheel_observe` (probes 7 sources at call time) | Pure disk reader | Replace probes with `AtomicJsonReader` reads |

---

## What flywheel can do that APR cannot (inversion analysis)

These are advantages the cluster preserves or amplifies:

1. **Multi-agent swarm coordination.** APR is single-process, single-revision-at-a-time. Flywheel runs N agents in parallel via NTM panes. The atomic disk state is a *prerequisite* for safe parallel writes — APR doesn't need it because it's single-threaded.
2. **MCP-native, not Bash-native.** Convergence math is TS with types; APR uses `bc` (a 1976 calculator) and silently zeroes confidence when `bc` is missing (B11). Our types make this category of bug impossible.
3. **Bead graph as explicit work model.** APR has implicit work units (rounds). Flywheel has explicit beads with deps, status, durations. The convergence score augments the bead graph rather than replacing it — Step 5.45 picks bead targets *informed by* convergence, but the bead graph remains the source of truth for "what's left to do."
4. **API-only LLM transport.** No browser, no DOM polling, no ChatGPT auth fragility. Convergence math runs against responses we already have type-checked.
5. **Real test infrastructure.** Vitest + structured assertions vs APR's BATS. Migration of state shape is testable without browser automation.
6. **`flywheel_doctor` ecosystem.** APR's `apr doctor` is a 50-LOC sanity check. Ours is an 18-check report with severity grading and structured `data.error.code`. The doctor stays the system-health source of truth; convergence is plan-health, distinct concern.

---

## Effort estimate

| Capability | LOC est. | Risk | Wave |
|------------|----------|------|------|
| C3 atomic-write helper + reader | ~150 | low | 1 |
| C3 layout migration (`.pi-flywheel` → `.flywheel`) | ~200 | medium (back-compat for existing checkpoints) | 1 |
| C3 `flywheel_observe` rewrite as disk reader | ~300 | medium (probe-removal + cache invariants) | 2 |
| C1 `RevisionMetrics` computation | ~250 | low (pure functions) | 2 |
| C1 `ConvergenceState` ring buffer + score | ~200 | low | 2 |
| C1 oscillation detector (B6 fix) | ~100 | low (pure function with property tests) | 2 |
| C1 Step 5.45 default-arming | ~50 | low | 3 |
| C1 `flywheel_plan` returns convergence block | ~80 | low | 3 |
| C2 path-claim extractor (extend existing) | ~150 | low | 3 |
| C2 bundle generator + atomic write | ~200 | medium (token-budget logic) | 3 |
| C2 `code_every_n` in `flywheel_advance_wave` | ~100 | low | 4 |
| C2 Step 5.45 "Refine" → bundle path | ~50 | low | 4 |
| **Total** | **~1830** | | **4 waves** |

Wave shape (per `flywheel_advance_wave`'s tier model): 1 = foundation, 2 = math + state, 3 = wiring, 4 = final integration. Each wave 3–5 beads. Total ~14 beads.

---

## Risks

1. **Migration of existing `.pi-flywheel` state.** Two checkpoint generations exist in the wild (v3.11.1 wrote stale checkpoint detected this session). Migration must handle both, fall through gracefully if neither, and emit a clear error if the migration itself fails. Ship a one-shot migration command (`flywheel-migrate-state`) before the cluster lands.
2. **Convergence score gaslighting users.** A score is suggestive, not authoritative. Step 5.45's menu defaults must always be overridable; the score is a hint, not a decision. Match APR's discipline: show the score, show the trend, let the human pick.
3. **Bundle file size.** APR's bundles can hit 50KB+ — token-budget logic is critical. Implement N-revision retention with size cap; emit a warning when a bundle exceeds the LLM's effective context.
4. **Atomic-write on macOS APFS vs Linux ext4.** `rename(2)` is atomic on both, but macOS spotlight can briefly hold readers. Use `fsync` on the temp file before rename if cross-platform tests show drift.
5. **Concurrent revision generation.** If two operators call Step 5.45 "Refine" in parallel on the same plan, both write `convergence.json`. Use a lock-free CAS pattern: read mtime, generate revision, attempt rename; if mtime changed, retry. Document in `skills/start/SKILL.md` (Step 5.45) that concurrent refines are last-write-wins.

---

## Trap-avoidance checklist

The cluster MUST satisfy each of these before declaring done:

- [ ] **B6 fix.** Property test: feed oscillating revision sequence (1000 → 1200 → 800 → 1100 → 900); detector must return `"oscillating"` and `estimated_rounds_remaining: null`.
- [ ] **B3 fix.** Every `release` operation on disk state checks ownership stamp before deleting. Property test: agent A creates state, agent B's release call is no-op.
- [ ] **B11 fix.** No optional dependencies. All convergence math is pure TS — no shelling out to `bc` or any external binary.
- [ ] **Anti-pattern #3 fix.** No code path branches on `revision_count`; only on `score`.
- [ ] **Anti-pattern #4 fix.** No 2-hour-TTL guesswork on locks; locks have explicit owner PID + token; release verifies.
- [ ] **B2 fix.** Convergence score is computed in-process, not by a CI step. No GitHub Action ever auto-bumps `convergence.json` in main.
- [ ] **Recovery determinism.** After SIGKILL of orchestrator mid-revision, restart must read existing `convergence.json` and continue from last revision without recomputation.

---

## Acceptance signals

The cluster is "done enough to ship" when:

1. Step 5.45 menu shows convergence score in its question text: e.g. *"Plan registered: 'foo.md' (score 0.82, nearly_converged). What does this plan need?"*
2. `flywheel_observe` returns convergence block as part of its response without making any new probes — it's pure disk read.
3. Refine bundle generation completes in <500ms for a 50-file plan, end-to-end.
4. Migration from `.pi-flywheel` to `.flywheel` is a no-op for fresh installs and a one-shot for existing.
5. Property tests pass: oscillation detection, atomic-write atomicity, ownership-stamped releases.
6. `flywheel_doctor` reports the new `.flywheel/` layout as healthy.

---

## Phase 8 → 9 hand-off

Phase 9 (iterative deepening) should push past this proposal's conservative initial framing. Specifically:

1. **`code_every_n` is currently a single global tunable.** Should it be per-wave-tier? Per-bead-template? What's the most ambitious version that still has a clean implementation?
2. **The bundle file is opaque to the user.** Could it be human-editable? A "what to change" stage where the operator edits the bundle before send, à la APR's vim-edit-in-place pattern?
3. **Convergence score as feedback to the planner.** If a plan starts oscillating, should `flywheel_plan` regenerate from a different starting prompt? What's the auto-recovery story?
4. **Cross-plan convergence trends.** APR's metrics are per-workflow. Could we aggregate `convergence.json` across all plans in a project to detect "this codebase is structurally hard to plan against" signals?
5. **Atomic-state as an agent-mail handshake.** Could file reservations migrate to the same atomic JSON pattern, eliminating the SQL backend's degraded-mode failure we hit this session?

---

## Phase 10 — 5x Blunder Hunt

Five sequential passes from distinct angles. Each blunder: title, what could go wrong, mitigation. Goal is to stress the proposal *before* writing code, not after.

### Pass 1 — Operational

**1.1 `rename(2)` is atomic but not durable.**
`atomicWrite` writes a temp file and renames. On power loss between the rename and the next `fsync`, ext4 with default `data=ordered` can yield a zero-byte or stale-content file at the canonical path even though the rename succeeded. APFS exposes the same window. The proposal omits `fsync(tmp)` before rename and `fsync(parent_dir)` after, so a kernel panic mid-revision can leave `convergence.json` truncated and unrecoverable. The reader's `JSON.parse` will throw; the orchestrator currently has no "corrupt-on-read → quarantine + recompute" path.
**Mitigation.** `fsync` the temp fd before `rename`, `fsync` the parent directory after, and on read failure move the bad file to `<path>.corrupt-<ts>` and recompute from `revisions/`.

**1.2 Disk-full during temp write leaves orphaned `.tmp.*` files.**
`atomicWrite` uses `${path}.tmp.${pid}.${ts}`. If the partition fills mid-write, `writeFile` rejects but does not unlink the partial temp. After many such failures the `.flywheel/plans/<slug>/` directory accumulates `.tmp.*` cruft that no garbage collector reaps. `flywheel_doctor` doesn't currently scan for this.
**Mitigation.** `try/finally` around `writeFile` to unlink-on-error; add a doctor check that flags `.tmp.*` files older than 1h.

**1.3 SIGKILL between `convergence.json` write and `revisions/<rev-id>.md` write.**
The proposal treats each file as independently atomic, but a *revision* is two writes: the markdown body and the convergence ring-buffer entry referencing it. A crash between them yields one of two corrupt states: ring buffer references a missing revision file, or a revision file orphaned from any ring buffer. The "recovery determinism" trap-avoidance bullet hand-waves this — "continue from last revision without recomputation" is undefined when the two files disagree.
**Mitigation.** Define write order explicitly (revision body first, then ring-buffer entry); on read, if ring-buffer references a missing body, drop that entry and warn; if a body has no ring-buffer entry, recompute and re-add.

**1.4 `process.pid` collision after PID reuse.**
The temp filename uses `process.pid`. On a long-running host where PIDs wrap (32k on Linux default), two writes seconds apart can collide if the first crashed and left a temp behind. `Date.now()` mitigates partly but is millisecond-resolution; on fast hardware two writes in the same ms with same PID are possible.
**Mitigation.** Append `crypto.randomUUID().slice(0,8)` to the temp suffix.

**1.5 OOM on large bundles.**
Risk #3 mentions the 50KB bundle case but C2 generates the bundle in-memory: read N revisions, concat with git diffs, `JSON.stringify`, write. A 50-file plan with 5 retained revisions and 6-month git history can produce >100MB of unified diff in RAM. Node's V8 heap default is ~1.7GB but this allocates a large string + buffer simultaneously, and the orchestrator already holds the bead graph and checkpoint. OOM during bundle gen would lose in-flight state.
**Mitigation.** Stream bundle to disk via writable streams; cap per-file diff at e.g. 200KB and elide with `... <truncated, run git log -p -- <path> for full> ...`.

### Pass 2 — Concurrency

**2.1 The "CAS retry" pattern is unsound — `mtime` is not a generation counter.**
Risk #5 proposes "read mtime, generate revision, attempt rename; if mtime changed, retry." But `rename(2)` does not check mtime — it just clobbers. Two operators can both read mtime=T, both compute new revisions, both `rename` their temp files; the second wins silently. There is no atomic-compare-and-swap on POSIX `rename`. The "retry" never triggers because the racing writer's rename unconditionally succeeds.
**Mitigation.** Use `link(2)` + check link count, or `O_CREAT|O_EXCL` on a sentinel `.lock` file with PID+token (per the B3-fix discipline elsewhere in the proposal). Document that the discipline applies to `convergence.json` writes too.

**2.2 `AtomicJsonReader`'s mtime cache is poisoned by clock skew and rapid writes.**
`mtime === stat.mtimeMs` returns stale data when two writes happen within the filesystem's mtime resolution (1s on ext4 without `lazytime`, ~1µs on APFS but still discrete). On NFS/SMB volumes mtime can go *backwards* during clock sync. The reader will serve cached stale data without knowing.
**Mitigation.** Cache on `(mtime, size, inode)` tuple; or include a `revision_id` in the file body and invalidate cache on body-id change.

**2.3 Lost-update on the convergence ring buffer.**
Two swarm panes finish refines on the same plan in adjacent seconds. Both read the current `convergence.json` (with N=5 revisions, last entry rev-7), both append their new revision (rev-8a from pane A, rev-8b from pane B), both rename. The second writer wins; rev-8a is lost from the ring buffer even though `revisions/rev-8a.md` exists on disk. The score then reflects only one of the two refines, gaslighting the operator who did pane A's work.
**Mitigation.** Ring-buffer append must be a read-modify-write under a per-plan lock; or restructure as append-only `revisions.ndjson` where each line is one revision and the ring-buffer view is computed at read time.

**2.4 Reader sees a *valid but stale* file during the rename window.**
`rename(2)` is atomic for the *swap*, but a reader that already opened the old fd before the rename keeps reading the old inode. With the mtime-cached reader pattern, a pane that read just before a rename will keep its cache valid (mtime didn't change *for that fd's inode*, but the dentry now points to a new inode with a newer mtime). On next `fs.stat` the reader picks up the new file — but in the gap, score-armed defaults can be computed against stale data and presented to the operator as "current."
**Mitigation.** Treat the score in returned envelopes as `(score, computed_against_revision_id)` so the consumer can detect a generation mismatch downstream.

**2.5 Lock-starvation on the per-plan write lock.**
Once 2.1's CAS is upgraded to a real lock, a pane that crashes while holding the lock leaves a stale `.lock` file. The trap-avoidance checklist forbids 2-hour TTLs, but offers no replacement. With many panes (the swarm spawns 4–6+), the failure mode is "one crashed pane wedges all refines on plan X until manual intervention."
**Mitigation.** Lock file carries owner PID + ULID token + start-ts; any reader that sees a lock can `kill -0 <pid>` to check liveness, and if the PID is dead OR start-ts is >5× the median refine duration *for this plan*, atomically replace the lock with a new owner via `O_CREAT|O_EXCL` on a successor sentinel.

### Pass 3 — Semantic

**3.1 The convergence score conflates "stable" with "good".**
A plan can be stable (high similarity, low velocity) and *wrong* — locked into a misframing the LLM can't escape. APR's blunder B6 is about oscillation; this is the inverse: monotonic convergence to a bad attractor. The 50/75/90 ladder will arm "Approve" defaults at score ≥0.75 even when the plan is converging to a non-solution.
**Mitigation.** Score is necessary but not sufficient — Step 5.45's default-arming must also gate on a separate "validate-against-code" signal (does the plan's claimed paths still exist? do the claimed APIs still match?). Never auto-default to Approve from convergence alone.

**3.2 Structural metric counts gameable by markdown reformatting.**
`structural.{headings, code_blocks, links, list_items}` change when an LLM reformats the same content (turns a bulleted list into a table, splits one heading into three). The diff_vs_prior similarity score will drop, change_velocity will spike, and the detector will flip from "nearly_converged" to "diverging" — even though the *meaning* is unchanged. Operators learn this within a session and either ignore the score or, worse, force the LLM into rigid formatting to keep the score happy.
**Mitigation.** Compute similarity on a normalized form (strip markdown, lowercase, collapse whitespace) before scoring; surface raw-vs-normalized as separate signals so reformatting doesn't trigger false divergence.

**3.3 `estimated_rounds_remaining = (1-score)*5` is the same gaslight APR shipped (B6).**
The proposal inherits the linear-extrapolation formula without flagging it. The trap-avoidance checklist B6 fixes oscillation but doesn't address that even on a *non-oscillating* trajectory, "rounds remaining" is a non-linear estimate against a non-linear process. Showing "2 rounds remaining" repeatedly across 5 actual rounds erodes operator trust in every other flywheel signal.
**Mitigation.** Either drop `estimated_rounds_remaining` entirely or compute it from the empirical distribution of "rounds-from-this-score-to-converged" across past plans (requires history; bootstrap with `null` until N≥10 plans observed).

**3.4 Score discontinuity at threshold boundaries.**
A plan at score 0.749 vs 0.751 gets a *different menu default* (Refine vs Approve) for a 0.002 difference that's well below noise. Operators will see the menu change between adjacent revisions of the same plan and lose faith. APR's 50/75/90 ladder has the same issue.
**Mitigation.** Hysteresis — once a plan crosses 0.75 upward, it stays "nearly_converged" until it drops below 0.70; symmetric on the other thresholds. Document this as intentional.

**3.5 "Score" hides which signal drove it.**
Three signals collapse into one number. A plan with growing size + stable similarity scores ~0.6 (suggesting "approaching"). A plan with shrinking size + falling similarity also scores ~0.6 (suggesting "diverging"). The status enum can't distinguish these; the operator gets a single label.
**Mitigation.** Surface the dominant signal name ("size_growth_dominant", "velocity_high", "similarity_low") in the envelope alongside the composite score; Step 5.45's question text mentions it.

### Pass 4 — Migration

**4.1 `.pi-flywheel/` → `.flywheel/` rename breaks every doctor heuristic, hard-coded path, and grep in skills.**
`AGENTS.md` and `README.md` reference `.pi-flywheel/` extensively (checkpoint, completion attestations, calibration, error-counts, profile-cache, tender-events). Skills like `_implement.md` and `flywheel-swarm/SKILL.md` carry literal `.pi-flywheel/completion/<beadId>.json` paths in implementor prompts. A rename touches dozens of files and one missed string yields "doctor green but completion attestations not found."
**Mitigation.** Don't rename — keep `.pi-flywheel/` as the canonical root and add `plans/`, `swarm/` *under* it. Or if the rename is non-negotiable, ship a path-shim that resolves either name during a 2-version deprecation window, with `flywheel_doctor` warning on the old path.

**4.2 `flywheel_observe` rewrite changes its semantic contract silently.**
Today `flywheel_observe` actively probes 7 sources at call time (per `AGENTS.md` v3.11.0 description). The proposal says "Replace probes with `AtomicJsonReader` reads" — but probes for `agentMail.reachable`, `ntm.available`, `git.dirty`, etc. are *not* on-disk state. They are live system queries. A pure-disk reader can't return them without a separate probe path. If the rewrite drops these fields, every consumer (banner, doctor, hints) silently loses signal. If it keeps them as probes, the proposal's "pure disk reader" claim is false.
**Mitigation.** Split `flywheel_observe` into two tools: `flywheel_observe_state` (pure disk) and `flywheel_observe_live` (probes); current consumers call both. Don't claim `observe` becomes pure-disk when it can't.

**4.3 Half-finished sessions migrate to inconsistent state.**
A user with an in-progress wave (some beads closed, some open, completion attestations partially written under `.pi-flywheel/completion/`) runs the migration. The migration moves files but doesn't reconcile: `convergence.json` doesn't exist yet because the plan was made under the old layout. The next `/start` sees an unfamiliar layout *and* an in-progress checkpoint and may either declare drift or, worse, treat the missing convergence file as "score=0, diverging" and arm Refine defaults on a plan the user thinks is approved.
**Mitigation.** Migration is a no-op when `checkpoint.json.phase` is anything other than `idle`/`complete`; refuses to run mid-wave with a clear "finish current wave or rollback first" error.

**4.4 Forward/backward compat: two flywheel versions in two checkouts of the same repo.**
A developer runs flywheel on `main` (v3.12, post-migration) in one terminal and on a feature branch checked out at `v3.11.5` in another. The old version writes `.pi-flywheel/checkpoint.json`, the new version writes `.flywheel/...`. Each version "doesn't see" the other's state. Switching branches mid-session and resuming flywheel reads stale state from the wrong tree.
**Mitigation.** Pin the layout root via a `.flywheel-version` sentinel that contains the schema version; `flywheel_observe` refuses to run if the on-disk version is newer than the binary; older binary on newer state aborts with a clear "upgrade flywheel" error.

**4.5 "Doctor green but everything broken" — migration script ran, but `mcp-server/dist/` wasn't rebuilt.**
The migration touches paths in `mcp-server/src/` constants. The user (per `AGENTS.md`) must commit `dist/` updates in the same PR. If a contributor runs the migration on their working tree without rebuilding `dist/`, doctor still passes (it tests reachability, not consistency between src and dist), but the runtime serves the old paths. Bug presents as "completion attestations silently not validated."
**Mitigation.** Migration emits a post-run check: hash the old-path string in `dist/server.js`; if present, fail with "rebuild required." Add a `dist_drift_for_migration` doctor check.

### Pass 5 — Adversarial

**5.1 Conflicts with `AGENTS.md`'s "Never write directly to `.pi-flywheel/checkpoint.json`" rule.**
`AGENTS.md` Hard Constraint #6 says all state mutation goes through `flywheel_*` MCP tools. The proposal's `atomicWrite` helper is exposed at the module level and used by C1, C2, C3 — implying multiple tools call it directly. Reviewers will (rightly) flag this as expanding the surface that can corrupt state. The MCP tool boundary is the project's declared invariant.
**Mitigation.** `atomicWrite` lives behind a single `state-store.ts` module that the tools import; never exposed to skills, never callable from CLI. Document the discipline explicitly in `AGENTS.md` Hard Constraints.

**5.2 Conflicts with v3.11.0's existing completion-attestation ledger.**
v3.11.0 already shipped `.pi-flywheel/completion/<beadId>.json` with `CompletionReportSchemaV1` (Zod, "additive forever"). The proposal introduces *another* per-entity JSON ecosystem (`.flywheel/plans/<slug>/convergence.json`, `swarm/panes/<pane-id>.json`) with its own schema_version. Two parallel "atomic JSON ledger" systems with different ergonomics, different validators, different doctor checks.
**Mitigation.** Reuse the v3.11.0 conventions: Zod schemas, `version: 1` additive forever, same doctor probe pattern, same hint surface in `flywheel_observe`. Don't reinvent.

**5.3 The "score-armed default" pattern conflicts with Design Philosophy #3 (every decision is `AskUserQuestion`).**
README §"Design philosophy" #3: *"Every decision is a labeled question. AskUserQuestion is the only sanctioned way. No implicit 'shall I proceed?'"* Step 5.45 menu defaults arming based on score *is* an implicit choice — the operator may hit Enter without realizing the default flipped. APR's discipline (per `apr-pro-phase4-blunders.md` and the proposal's own Risk #2) is "score is a hint, human picks." The README's discipline is stricter still.
**Mitigation.** No menu *default* changes based on score. The score is shown in the question text only. Operator always picks explicitly. Match the project's stronger invariant, not APR's looser one.

**5.4 1830 LOC across 4 waves is unrealistic given v3.11.0's complexity budget.**
v3.11.0 shipped three composable features in one release with ~14 beads. Per `README.md`'s "Limitations" — "heavy dependency tree" — and the project's solo-author posture, a 4-wave 1830-LOC cluster is the largest single effort in the project's history. The "Phase 8 → 9" deepening section already lists 5 expansions. Reviewers familiar with the project will see this as scope creep masquerading as a "single cluster."
**Mitigation.** Break the cluster: ship C3 (atomic state contract + layout) alone first as a no-functional-change refactor; ship C1 (convergence) as a follow-on; ship C2 (bundling) only after C1's score is validated against real plan history. Each ships in a single release, not as one mega-PR.

**5.5 The "About Contributions" reality — `Dicklesworthstone` won't merge external PRs.**
`README.md`'s contributions note: *"I do not accept outside contributions… I'll have Claude or Codex review submissions via gh and independently decide whether and how to address them."* This proposal will be reviewed by an LLM operating under a strict scope mandate. The proposal's Phase 9 deepening agenda (cross-plan trends, bundle as human-editable, atomic-state for agent-mail) reads like scope creep. The cluster framing — "they share a foundation, ship together" — is exactly the kind of bundling the author's own scope-discipline rejects.
**Mitigation.** Frame the proposal as *one* concrete change with the smallest viable diff. Move "shared foundation" rationale to a separate design doc. Land C3-only, claim no convergence/bundling improvements until C3 has been in main for ≥1 release without regression.

---

## Phase 12 — Final Synthesis & Recommended Action

**Inputs.** Phase 10 5x blunder hunt (this doc, ~25 distinct findings) + Phase 11 sonnet feedback (`docs/research-apr-pro-feedback-sonnet.md`, ship-with-changes) + Phase 11 opus feedback (`docs/research-apr-pro-feedback-opus.md`, scope-down).

### 12.1 Convergent verdict

Both reviewers, working independently, landed on the same conclusion: **the cluster as drafted is too aggressive**. Phase 10 pass 5 (adversarial) confirms it from a third angle. The convergent recommendation:

> **Ship A1 only. On the existing `.pi-flywheel/` root. Riding existing flywheel infrastructure (`FlywheelObserveReport`, Zod schemas, RESERVE001 lock discipline, completion-attestation patterns). Defer A2 + A3 until A1 demonstrates the schema gaps are real.**

### 12.2 What to actually ship — the A1-only Minimum Viable Cluster

**One file, one MCP tool, one new skill block. Two beads. One wave. Days, not weeks.**

| Bead | Surface | LOC | Risk |
|------|---------|-----|------|
| **B-AC1** Convergence math + ring-buffer + B6 oscillation guard | new `mcp-server/src/convergence.ts` (Zod, `version: 1`, pure functions, property tests on `1000→1200→800→1100→900` golden fixture) | ~400 | low |
| **B-AC2** Wire `convergence?` block into `FlywheelObserveReport` + new `flywheel_convergence({planSlug})` MCP tool + Step 5.45 skill hint + `flywheel_advance_wave` gating w/ kill-switch | extend `mcp-server/src/tools/observe.ts`; register new tool in `mcp-server/src/server.ts`; edit `skills/start/SKILL.md` (Step 5.45 lines 518-594); add gating in `mcp-server/src/tools/verify-beads.ts`; new `flywheel.config.yaml` with `convergence.gate_advance_wave: bool` | ~200 | low |
| **Total** | | **~600** | |

Path: `.pi-flywheel/plans/<slug>/convergence.json` (new subdir, no rename).

### 12.3 What to drop from the original draft

- **`.pi-flywheel/` → `.flywheel/` rename.** Phase 10 4.1 + opus 4.1 + sonnet §6. Gratuitous breaking change. Cut.
- **`flywheel_observe` rewrite to "pure disk reader".** Phase 10 4.2 + opus §4.2 + sonnet §3. The current observe is a probe-aggregator and *should stay that way*. The convergence block is additive; observe doesn't need to change shape, just gain one optional field.
- **Bundle-as-canonical-prompt (C2).** Opus §4.3 + Phase 10 5.5. Major architectural commitment dressed as optimization. Defer; if A1's score is useful, revisit later as an audit-trail artifact (not a canonical prompt).
- **Atomic-write helper as new infrastructure.** Opus §4.2 + Phase 10 5.1, 5.2. Use existing `completion-report.ts` write helpers; if those are insufficient, propose extending them as a separate refactor PR.
- **`code_every_n` parameter.** Opus §4.4 + Phase 10's anti-pattern #3 critique. Reintroduces hardcoded round-counts. Cut entirely; if re-anchoring becomes a problem, design it adaptively.
- **Cross-plan convergence aggregation (Phase 8→9 Q4).** Sonnet §6 + opus §4.7. Speculative; needs a "plans registry" that doesn't exist. Cut.
- **Atomic-state-as-agent-mail-handshake (Phase 8→9 Q5).** Sonnet §6. Speculative; touches agent-mail internals. Cut.
- **Estimated rounds remaining as a linear `(1-score)*5`.** Phase 10 3.3. Inherits APR's gaslight (B6). Either drop entirely or compute from empirical history (defer to v2).
- **Score-armed menu defaults at thresholds.** Phase 10 5.3 + opus §8. Conflicts with project's `AskUserQuestion` invariant. Score appears in question text only; operator always picks explicitly.

### 12.4 Decisions (resolved 2026-05-05)

The reviewers surfaced two decisions A1's design hinges on. **Operator decision** (overrides reviewer recommendations):

1. **Score is for both human + orchestrator.** Score gates `flywheel_advance_wave`; auto-approve fires at score ≥0.90 threshold. Reviewers recommended human-only — overruled.
2. **Wave-level + Step-5.45 scope.** Convergence gates `flywheel_advance_wave` AND informs Step 5.45 menu hints.

**Implications of orchestrator-gating decision** (must address in B-AC1/B-AC2 beads):

- **Score-version pinning is now load-bearing.** Tag every score in `FlywheelObserveReport` with `score_version: 1` so algorithm changes become explicit behavioral migrations.
- **Auto-approve at ≥0.90 still routes through `AskUserQuestion`.** Per README §Design Philosophy #3 the *decision* is presented; convergence merely arms a "Recommended" label and pre-selects the option. No silent advancement.
- **Add `convergenceGated: boolean`** to `FlywheelObserveReport` top level so consumers can detect the new gating mode without inferring it from the score block.
- **Add a kill-switch:** `flywheel.config.yaml` field `convergence.gate_advance_wave: bool` (default `true`); operators can disable orchestrator-gating per-project if it gaslights them.
- **Regression test.** A plan that legitimately needs >5 waves of refinement must NOT be gated below 0.90 if its score is climbing — auto-approve fires on convergence, never on round-count budget.

### 12.5 Trap-avoidance checklist (post-scope-down)

After dropping A2 + A3, only these traps remain in scope and all are now properly addressed:

- [x] **B6 oscillation fix.** Property test on `1000 → 1200 → 800 → 1100 → 900`. ✅ adequate.
- [x] **B11 no optional deps.** Pure TS, no `bc`, no shell-out. ✅ adequate.
- [x] **B2 no CI auto-bump.** Convergence computed in-process. ✅ adequate.
- [x] **Anti-pattern #3 no hardcoded round counts.** Score is the gate; no `code_every_n`. ✅ adequate (since `code_every_n` cut).
- [x] **AGENTS.md Hard Constraint #6.** All writes go through the new `flywheel_convergence` MCP tool (not via free-floating `atomicWrite` helper).
- [x] **README §Design Philosophy #3 (every decision is `AskUserQuestion`).** Score never arms menu defaults; operator always picks.
- [x] **B3 lock-ownership** + **anti-pattern #4 lock-TTL guesswork.** Out of scope (no locks needed for additive single-file write under existing reservation discipline).

### 12.6 Acceptance signals (post-scope-down)

- A property test feeds `1000 → 1200 → 800 → 1100 → 900` to the detector; status MUST be `"oscillating"`, `estimated_rounds_remaining` MUST be `null`.
- A property test feeds a monotonically-converging sequence; status transitions through `diverging → approaching → nearly_converged → converged` without skipping.
- `flywheel_convergence({planSlug})` returns the same shape regardless of whether the plan has had 1 or 100 revisions (ring buffer caps at N=5 by design).
- `FlywheelObserveReport` schema parity: existing fields unchanged; new `convergence?` field is opt-in.
- `flywheel_doctor` reports the new `mcp-server/dist/` is current with src after build.
- Step 5.45's question text mentions the score when present, never changes its labeled-options set.

### 12.7 Phase 13+ (deferred)

Once A1 has been in main for ≥1 release without regression, revisit:

- A2 (bundle as audit artifact, not canonical prompt — opus §6 strawman B). +300 LOC.
- Empirical `estimated_rounds_remaining` from cross-plan history (Phase 10 3.3). Requires N≥10 plans observed.
- Hysteresis on threshold boundaries (Phase 10 3.4). Cosmetic; defer until operators report the menu-flip annoyance.
- Normalized similarity (strip markdown before scoring; Phase 10 3.2). Defer until reformatting-noise is observed in real plans.

A3 (atomic-state-as-discipline) doesn't get a phase 13 — it was a misread of existing flywheel infrastructure (per opus §2 first-principles re-derivation).

### 12.8 Recommended action

**Convert B-AC1 + B-AC2 to beads, run them through `/start`, ship as v3.12.0 "Convergence Hint."**

The full A1+A2+A3 cluster as originally drafted is **not** recommended for shipping. Reviewers + Phase 10 converged on this; the cluster framing was overreach.

---

## Appendix — Phase 9 deepening (the most-ambitious framing, preserved)

Phase 9 was instructed to push past Phase 8's conservative framing and surface the version of this cluster that's almost too ambitious to ship but transforms the product. Phase 12 ultimately scoped *down* to A1-only — and that's the right v3.12 ship. But the most-ambitious framing is itself a useful artifact: it's the eventual destination the project's stated vision is already heading toward, and it answers the Phase 8→9 hand-off questions concretely instead of pushing them downstream. This appendix preserves that framing as the lever the project should pull *eventually*, just not in v3.12.

### A.1 Reframing — "Flywheel Disk-State Substrate v1" (FDS-v1)

Phase 8 framed the cluster as "adopt convergence math + bundle git diffs + put state on disk." That framing under-sells what's actually possible. The most-ambitious reframing:

> **Make `.flywheel/` a versioned, append-only, mv-atomic event log that is the single source of truth for every flywheel surface — including swarm pane state, bead-graph metrics, agent-mail handshakes, and convergence — and re-target every reader (TUI, doctor, observe, dashboard, agent-mail, NTM, beads viewer) to read from it instead of from live processes.**

Once you commit to that, the convergence score and refine-bundle stop being plan-only features. They become the *first two consumers* of an event-sourced substrate that the rest of the project has been moving toward for the last six versions (v3.7 atomic checkpoint, v3.11 completion-evidence ledger, v3.11 lock-aware reservations, v3.11.5 observe report). Convergence + bundling is the user-visible payoff; the disk-state discipline is the architectural commitment that makes the next year of features cheap.

**The single most ambitious change** in this framing: fold A5 (structured envelope) into the same cluster, optionally retire `.pi-flywheel/` in favor of `.flywheel/` as a *user-facing* migration with a one-time interactive `flywheel-migrate-state` command, and treat the convergence ring buffer as a generic per-entity time-series substrate that bead-graph metrics, swarm-pane heartbeats, and agent-mail reservation health all reuse. That single substrate is the lever; everything else is downstream.

### A.2 Cluster boundary, reconsidered

**What Phase 8 said.** A1 + A2 + A3 share the mv-atomic disk-state assumption and unlock each other. A4 (templates) and A5 (envelope) are independent ergonomic wins sequenced after.

**Phase 9 verdict.** A4 and A5 are *not* independent. Look at the call graph:

1. **A1 (convergence) writes `convergence.json`.** Every consumer that reads it needs a *uniform shape* for "tool returned a state-derived value." That shape is exactly A5's `{ok, code, data, hint, meta}` envelope. Without A5, every consumer invents a slightly-different read pattern.
2. **A2 (refine bundle) is a prompt.** Replacing the inline string with a bundle file is half the win; the other half is making the *prompt template itself* live in `flywheel.config.yaml` (A4) so users can tune without forking. A2 without A4 means we ship a hardcoded bundle prompt that is just as un-tunable as the inline string we replaced.
3. **A3 (atomic state) is a write contract.** Without A5 envelopes, the diff between "this surface migrated to A3" and "this surface didn't" is invisible to callers. With A5, every read is a versioned `data.code = "ok" | "stale_schema" | "missing_state"` that callers can branch on — making the migration *observable*, not stealthy.

**What Phase 9 proposes instead.** Treat **A1 + A2 + A3 + A4 + A5 as one cluster with five capabilities**, scoped under a single migration umbrella. Total scope: ~14 → ~22 beads, ~1830 → ~3940 LOC. The expansion is leveraged: A4 and A5 are mostly *adapter* work that follows the schema decisions A1/A2/A3 force. Doing them later means re-touching the same files twice. Renamed cluster: "Flywheel Disk-State Substrate v1" (FDS-v1) — drop the APR association.

(Phase 12 ultimately rejected this expansion. The case for *eventually* doing it is the rest of this appendix.)

### A.3 Capability deepening (additions on top of Phase 8 C1/C2/C3)

**C1 deepening — convergence beyond plans.** The `RevisionMetrics` shape generalizes. Same ring buffer, same sign-flip detector, applies to:

- **Bead-graph health.** Track `{open_count, blocked_count, ready_count}` per `flywheel_advance_wave` call. A bead graph that's not draining (open count flat or growing across waves) is the swarm-level analog of an oscillating plan. Bead-graph oscillation arms the doctor's "swarm is thrashing" advisory — a check that does not exist today.
- **Swarm pane heartbeats.** Per-pane `last_heartbeat_ms_ago`, `messages_sent_per_minute`, `bead_close_rate`. A pane whose `bead_close_rate` is declining over the last N samples is *degrading* (a state between `alive` and `dead`); the doctor surfaces it for respawn before the user notices stalled output. Canonical fix for the "dead pane stalls bead in `in_progress` forever" failure mode (`apr-pro-ergonomics.md` §4.1).
- **Agent-mail reservation health.** Per-project `reservation_conflicts_per_hour`. When this trends upward, the project has slipped into the advisory-enforcement bug regime (AGENTS.md "Known issue") and `reserveOrFail` retries are masking real contention. Today this trend is invisible.

By packaging the ring buffer as a generic `lib/timeseries-ringbuffer.ts` with a uniform sign-flip oscillation detector, A1 lights up four product surfaces — not one. Marginal cost per additional surface: ~50 LOC. Default ring-buffer length should be N=6 (Phase 8 said N=5); +1 gives the oscillation detector a cleaner sign-flip count window — `> floor(N/3)` becomes `> 2` instead of awkward `> 1`.

**C2 deepening — bundles as a UX surface, not an opaque prompt.** A bundle is a markdown file. It can be:

1. **Diffed against the previous bundle** for visual plan-evolution.
2. **Edited by the operator before send** behind `bundle_edit_before_send: true` (default false). APR's vim-edit-in-place pattern, generalized.
3. **Replayed.** Bundle + frozen LLM response in `.flywheel/plans/<slug>/responses/<rev-id>.md` is a reproducible refine round. Useful for training data, regression tests of prompt-engineering changes, and forensics.
4. **Approved as a record.** When a plan converges, the *terminal bundle* + the prior N bundles form a complete decision provenance trail PR reviewers can scrub.
5. **Bead-attached.** When Step 5.45 routes from refine into bead creation, the bundle file path becomes a piece of bead provenance: `provenance.refine_bundle: "<path>"`. `bv` and the Cytoscape viewer can surface "this bead came from the 4th refine round of plan <slug>."

Bundle additions: **bead-graph delta block** (which beads were created/closed/blocked since plan generation, with provenance — duel/standard/scrutiny) and **convergence trace** (one-line history of last N revisions' score/status/oscillation). The LLM uses these to choose between wide rewrite vs targeted polish.

**C3 deepening — `fsync` is required, not optional; add a schema catalog.**

- **`fsync` on the temp fd before rename, and on the parent directory after.** Required for cross-platform durability. APFS, ext4 with `data=ordered`, and NFS all have failure modes where rename-without-fsync can lose data on crash. (Phase 10 §1.1 covered this.)
- **`.flywheel/schema.json` — a single catalog file** enumerating every entity type, its `schema_version`, on-disk path glob, and which MCP tools own writes. Doctor uses it to validate the layout. Migrator uses it to know what to copy. Future schema bumps update one file.
- **`fs.watch` for cheap "did any of my dependencies change since I last read?" semantics.** Step 5.45 menu and `flywheel-status` benefit: instead of polling on a timer, they sleep until a watcher fires. APR's "press `r` to refresh" generalized. Falls back to mtime-poll on platforms where `fs.watch` is unreliable.

**C4 — Pinned prompt templates + placeholder pre-send gate (folded in from A4).** `flywheel.config.yaml` gains a `templates:` block (`templates_schema_version: 1`, mustache-style `{{var}}` only, no logic). Pre-send gate scans for unexpanded `{{...}}` and refuses to send via `{ok: false, code: "validation_failed", data: {unexpanded_placeholders: [...]}}`. **Templates as the seam between user-tunable and plugin-shipped:** plugin ships defaults in `flywheel/templates-default.yaml`; user's `flywheel.config.yaml` is delta-only. Conflict resolution rule when plugin ships v2 and user has v1: doctor surfaces "templates schema bumped — review via `flywheel templates diff`, accept via `flywheel templates pin`." No `templates merge` command (anti-pattern: invented config DSLs); human always picks.

**C5 — Structured envelope (folded in from A5).** Every MCP tool returns `{ok, code, data, hint, meta}`. Closed enum lives in `mcp-server/src/codes.ts` (separate from `errors.ts` so it can be imported by code that doesn't throw). Beyond the existing 36-code FlywheelErrorCode set: `ok`, `no_pending_beads`, `wave_not_ready`, `plan_not_found`, `pane_dead`, `mail_unread`, `convergence_oscillating`, `convergence_stalled`, `stale_schema`, `reservation_owned_elsewhere`, `template_rot`, etc. **Retry classifier:** single function `isRetryable(code)` consulted by NTM/Codex/Gemini auto-retry paths. Argument-class codes (`validation_failed`, `usage_error`) → no retry. Transient codes (`provider_unreachable`, `mail_unread`) → retry with backoff. Codified once; every retry site imports it. Kills "burn 3 attempts on a deterministic flag-typo" (B8) at the source. **`meta.durationMs` becomes a calibration signal:** `flywheel_calibrate` reads `data.code = "ok"` envelopes from the tender event log and aggregates `meta.durationMs` per `tool_name`. p95 tool latency becomes a doctor advisory at zero new instrumentation cost.

### A.4 Updated layout

```
.flywheel/
├── plans/<slug>/
│   ├── plan.md                       # canonical plan
│   ├── convergence.json              # C1 ring buffer
│   ├── refine-bundle-<rev-id>.md     # C2 bundles
│   ├── responses/<rev-id>.md         # frozen LLM refine responses
│   └── revisions/<rev-id>.md         # historical revisions
├── swarm/
│   ├── panes/<pane-id>.json          # per-pane state (mv-atomic)
│   └── heartbeats/<pane-id>.json     # ring-buffer of heartbeats (C1-shaped)
├── beads/
│   ├── graph-snapshot.json           # ring-buffer of (open, blocked, ready) per wave
│   └── per-bead/<bead-id>.json       # provenance + refine_bundle pointer
├── agent-mail/
│   ├── reservations.json             # local mirror of held reservations
│   └── reservation-health.json       # ring-buffer of conflict rate
├── completion/<bead-id>.json         # CompletionReportSchemaV1, moves here
├── checkpoint.json                   # existing — moved here
├── error-counts.json                 # existing — moved here
├── profile-cache.json                # existing — moved here
├── tender-events.log                 # existing — moved here, becomes append-only
└── schema.json                       # FDS-v1 catalog
```

### A.5 Cross-cluster effects

The Phase 8 proposal listed "Mapping to existing flywheel architecture" as the only impact surface. That undersells the blast radius. Surfaces FDS-v1 *also* affects:

- **`flywheel-doctor`.** New checks: `flywheel_layout_v1`, `convergence_health` (any plan in `convergence_oscillating` >24h?), `bead_graph_oscillation`, `pane_degrading`, `templates_schema_drift`, `reservation_conflict_rate`. Doctor's own report becomes one of the entities written under `.flywheel/cache/doctor.json`. Total checks: 17 → ~23.
- **Swarm coordination (NTM panes).** Each pane writes a heartbeat to `.flywheel/swarm/heartbeats/<pane-id>.json` every 30s. Ring-buffer detects `degrading` state. `/flywheel-swarm-status` becomes a pure C3 reader. The tender daemon's looper consults `convergence.json`: if oscillating, the tender pauses bead spawn rather than continuing to push beads into a thrashing graph. `/flywheel-swarm --respawn <pane>` is unblocked: respawn becomes "kill PID, ack heartbeat ring buffer, mv-atomic write a fresh `panes/<pane-id>.json` with new instance UUID, re-spawn."
- **Agent-mail integration.** The advisory-enforcement bug is currently mitigated by `reserveOrFail`. FDS-v1 adds *visibility*: every reservation grant + conflict appended to `.flywheel/agent-mail/reservation-health.json` ring buffer. When the upstream bug is fixed, the ring buffer flatlines — clear evidence of the fix in production. File-reservation paths become C5-enveloped reads.
- **NTM pane state.** NTM owns pane lifecycle today; FDS-v1 mirrors pane state into `.flywheel/swarm/panes/<pane-id>.json` for *flywheel's* read-only consumption. NTM's pane registry remains the source of truth for tmux; mirror is one-directional.
- **Bead graph itself.** `br` CLI is the source of truth for beads. FDS-v1 adds `.flywheel/beads/graph-snapshot.json` — a per-wave snapshot of `(open, blocked, ready)` counts. `bv` doesn't need this; `flywheel-status` and the bead oscillation detector do. Per-bead provenance gains `refine_bundle` pointer. Cytoscape viewer gains a "show provenance" overlay tracing a bead back to its plan and refine round. Zero impact on existing `br create` / `br update` / `br dep` flows.
- **`flywheel-reality-check`.** Reads convergence state for the active plan. If oscillating, surfaces *"plan is unstable; gap analysis may be premature — consider scrap or refine first."* Prevents reality-check from being run against a thrashing plan and producing thrashing gaps. Duel-mode reality-check cross-scores convergence-aware advisories with non-aware ones.
- **Completion-evidence ledger (v3.11.0).** Already lives at `.pi-flywheel/completion/<bead-id>.json`. Migrates cleanly. `CompletionReportSchemaV1` is *unchanged* — its "additive forever" discipline is the model FDS-v1 generalizes. New additive field: `CompletionReport.beadProvenance.refineBundle?: string`.
- **`flywheel_emit_codex`.** C4 templates are now sourced from `flywheel.config.yaml` — emitter must inline resolved templates into emitted skills. Round-trip drift test (already exists) needs an extra assertion: emitted skill bodies match the rendered template, not the raw template-with-placeholders.
- **`flywheel_calibrate`.** `meta.durationMs` from C5 envelopes feeds a tool-latency histogram. Calibrate runs become richer at zero new instrumentation cost.
- **Bead-graph viewer (Cytoscape, `127.0.0.1`).** Reads `br list --json`. Phase 9 enhancement: also reads `.flywheel/beads/graph-snapshot.json` ring buffer to overlay "graph health trend" — a sparkline of `(open, blocked, ready)` over the last N waves, color-coded by oscillation state. Optional overlay; viewer remains read-only.
- **Banner / SessionStart hook.** Reads from `.flywheel/checkpoint.json`. New banner field: convergence score for active plan ("Plan: foo.md — score 0.82, nearly_converged").
- **`/flywheel-stop` and `/flywheel-cleanup`.** Cleanup gains awareness of `.flywheel/swarm/heartbeats/` and `.flywheel/agent-mail/reservation-health.json`. Stale entries (no PID alive, heartbeat older than 24h) are reaped on cleanup. Stop writes a final `convergence.json` snapshot if a plan is active, so the next `/start` can resume the convergence trail without recomputing.
- **`flywheel-tool-feedback`.** Feedback events become entries in `.flywheel/feedback/<ulid>.json`, each carrying the `meta.durationMs` and `data.code` of the call being criticized. Aggregable by code, by tool, by timestamp. `/flywheel-refine-skill` consumes this aggregate as the primary input — feedback becomes data, not just prose.

### A.6 Long-term-vision alignment

**Read of AGENTS.md and README.md.** The project's stated design philosophy:

1. State lives on disk; the server is stateless.
2. One lever per commit.
3. Every decision is a labeled question.
4. Multi-agent fan-out is mandatory through NTM.
5. Structured errors over string matching.
6. Adversarial review at risky seams.
7. Completion is evidence-backed, not narrative.

FDS-v1 directly amplifies #1, #5, #7. Neutral on #2, #3, #4, #6.

**Direct alignment.**

- **#1 — State on disk.** FDS-v1 is the most explicit possible expression of this. A `flywheel_doctor` check enumerates in-memory state and asserts it's all derivable from disk. The principle becomes *testable*.
- **#5 — Structured errors.** C5 generalizes the existing 36-code FlywheelErrorCode pattern: every *success* return also carries a code, not just errors. SKILL.md branches on `data.code` for both `"ok"` and `"validation_failed"` symmetrically.
- **#7 — Evidence-backed completion.** CompletionReportSchemaV1 is the prior art FDS-v1 builds on. Convergence (C1) does for *plans* what completion attestation does for *beads*: durable, schema-versioned, ledger-style evidence at every phase boundary.

**Where FDS-v1 *deepens* the project's vision beyond what's stated today.** The current vision is **about-the-process** ("scan → discover → plan → implement → review with checkpoints between every step"). It's strong on *workflow* and weak on *event substrate*. FDS-v1 adds the missing layer: **every workflow event is a versioned, append-only record on disk that any future tool can consume.** This is event sourcing at the file-system level, applied to coding agents.

Cheap capabilities the substrate buys:

1. **Cross-session learning.** Every refine bundle + LLM response is a (prompt, response) pair durably on disk. `/flywheel-refine-skill` can mine these to detect "skill X's prompt has produced 12 oscillation events in the last month" — actionable evidence, no LLM-as-judge.
2. **Replay-based debugging.** "Why did the wave-3 plan refine produce that recommendation?" is answerable: the bundle file plus the response file fully reproduces the decision.
3. **Cross-project benchmarking.** Convergence ring buffers and bead-graph snapshots are uniformly shaped. Two flywheel projects can compare convergence velocity, oscillation frequency, bead-graph drain rate.
4. **Time-travel doctor.** `flywheel-doctor --as-of <ts>` reads the on-disk state at a past point and reproduces what doctor would have said.

**Where FDS-v1 has *friction* with the current vision.**

- **The `.pi-flywheel/` → `.flywheel/` rename is user-visible.** README mentions `.pi-flywheel/` six times in user-facing tables. Highest-friction part of the migration. (Phase 10 §4.1 flagged this as a kill-switch and Phase 12 cut it.)
- **The "stateless server" principle is *aspirational* today.** Some flywheel tools do hold in-memory state (`polishConverged` in `state.ts`). FDS-v1 makes the principle binding by making it a doctor check. Alignment in *spirit* but a *behavioral change* in practice.
- **Templates in `flywheel.config.yaml` cross a boundary.** Current model: skill `.md` files plugin-shipped, `flywheel.config.yaml` user-tunable. C4 partially blurs this. New boundary: "skill *flow logic* is plugin-shipped; skill *prompts* are user-tunable." Net positive — but requires a prominent docs change.

**Net verdict.** FDS-v1 is **the natural next major version of the project's stated philosophy.** Friction surfaces are migration-shaped (one-time costs), not architecture-shaped (recurring costs). The deepening of #1/#5/#7 is the version of those principles the project would write if it were writing them in 2026 instead of 2024.

(Phase 12 disagreed on *timing* — A1-only is the right v3.12 ship — but the most-ambitious framing remains the destination v3.13+ should head toward.)

### A.7 Phase 8 → 9 hand-off questions, answered

#### Q1. `code_every_n` per-wave-tier? Per-bead-template?

**Answer: per-wave-tier, with bead-template override.**

| Wave tier | Default `code_every_n` | Rationale |
|-----------|------------------------|-----------|
| Foundation (wave 1) | 1 | Re-anchor every wave. Foundations need maximum grounding; cheap because waves are small. |
| Math/State (wave 2) | 3 | Pure-logic beads tolerate sparser code context. |
| Wiring (wave 3) | 2 | Wiring beads cross many files; need fresh tree. |
| Final integration (wave 4) | 1 | Integration is where stale code-context bites hardest. |

Bead templates can override:

```yaml
bead_templates:
  refactor:
    code_every_n: 1   # always re-anchor for refactors
  docs_only:
    code_every_n: 0   # never re-anchor; pure prose
```

Implementation cost: trivial (~30 LOC) since `flywheel_advance_wave` already knows wave tier and bead template at marching-orders time. Tier *informs* defaults; never *gates*. Users can set `code_every_n: 5` globally and ignore tiers. (Phase 12 cut `code_every_n` entirely as anti-pattern #3 reintroduction; this answer documents what the most-ambitious shape would be when re-introduced post-v3.13.)

#### Q2. Bundle file as a UX surface — human-editable?

**Answer: yes, behind `flywheel.config.yaml: bundle_edit_before_send: true` (default false).** When enabled, Step 5.45 "Refine" pauses after bundle generation:

```
Bundle written to .flywheel/plans/foo/refine-bundle-01H...md (43 KB, ~12k tokens)
Open for editing? [y/N/d=show diff vs prior bundle]
```

`y` opens `$EDITOR`. User prunes/augments. Saving + closing sends the bundle. Cancelling is `code: "user_cancelled"` and no LLM spawn. Power-user feature; default off.

#### Q3. Convergence score as feedback to the planner — auto-recovery?

**Answer: route through `/flywheel-duel`, not auto-recover.** When oscillation is detected:

1. Step 5.45 menu shows: *"Plan is oscillating (sign-flips: 4 in last 6 revisions). Recommended action: scrap or duel."*
2. Selecting "duel" triggers `/flywheel-duel --mode=plan-rescue` — two agents independently produce *new* plans seeded by the *first* of the oscillating revisions (the most stable base) and reading the *most recent* refine bundle as evidence.
3. The synthesized duel plan is a fresh `.flywheel/plans/<new-slug>/plan.md` — not an in-place rewrite. The original is archived under `.flywheel/plans/<old-slug>/`.

Auto-regenerating without human acknowledgment violates principle #3 (every decision is a labeled question). The duel route is the auto-recovery — but user-initiated.

#### Q4. Cross-plan convergence trends — codebase-level signal?

**Answer: yes, via a new MCP tool `flywheel_codebase_convergence_history`.** Reads every `.flywheel/plans/*/convergence.json` and returns:

- Aggregate sign-flip rate across all plans.
- Median revisions-to-converge.
- Distribution of `oscillating` outcomes by plan size.
- Flag: "this project's plans oscillate at >2x the multi-project median."

Doctor consumes this as a *yellow* advisory: *"Plans here oscillate frequently — consider whether prompt templates need tuning, or whether the codebase has architectural tension that planning is exposing."* Anonymized opt-in aggregation across users (`telemetry: convergence_aggregate: true`) gives the project authors a real signal on which prompt templates need rewrites.

#### Q5. Atomic-state as agent-mail handshake?

**Answer: partial — mirror, not replace.** Agent-mail's reservation backend is upstream; replacing it would fork the upstream tool, which the project explicitly avoids. But: flywheel can *mirror* held reservations into `.flywheel/agent-mail/reservations.json` on every successful `reserveOrFail` call. Mirror is read-only; SQL backend remains source of truth. When agent-mail is in degraded read-only mode (as it was during this Phase 9 session), the local mirror lets `flywheel-status` and `flywheel-swarm-status` display *which* reservations the local pane holds, even when the server can't answer queries. Doesn't restore *granting* new reservations — but restores read-side visibility.

Bonus catch: if local mirror says "I hold reservation X" and a fresh `file_reservation_paths` returns "X is granted to someone else," that's a server-state divergence the doctor can flag. Today this divergence is invisible.

#### Bonus answers

- **Schema-version consistency.** CompletionReportSchemaV1's discipline (`version: 1`, additive forever) becomes the global FDS-v1 rule. Every schema in `.flywheel/schema.json` follows it.
- **Plan storage.** `docs/plans/` for canonical plan markdown; `.flywheel/plans/<slug>/` for everything FDS-v1 produces. They're linked by `.flywheel/plans/<slug>/plan.md` being a symlink (or copy, if symlinks fail) of `docs/plans/<plan-name>.md`. Doctor's `plan_layout_v1` check verifies the linkage.
- **Token-counting libraries per provider.** Phase 1: `@anthropic-ai/tokenizer` for Claude only. Codex and Gemini get conservative byte-count fallbacks (multiply byte count by 0.25 for an upper-bound estimate). Phase 2 (post-FDS-v1) integrates per-provider tokenizers.

### A.8 Migration story

Phase 8 said "ship a one-shot migration command." That's 5% of the migration story.

**Forward compatibility.** Every `.flywheel/` file carries `schema_version`. Readers refuse to load mismatched versions; refusal returns `{ok: false, code: "stale_schema", data: {found: "1.0.0", expected: "1.1.0"}, hint: "Run flywheel-migrate-state --from=1.0.0 --to=1.1.0"}`. No silent shape coercion. New fields are *optional and additive*; CompletionReportSchemaV1's "additive forever" discipline generalizes.

**Backward compatibility.** For one minor version after FDS-v1 ships:

1. **Symlink `.pi-flywheel/` → `.flywheel/`** at the OS level (created by `flywheel-migrate-state` after the copy). Tools still hardcoded to `.pi-flywheel/` continue working.
2. **Old paths in skill bodies are kept as fallbacks.** Once doctor confirms the new layout is healthy, fall-back paths are deletable.
3. **The `orch_*` MCP tool aliases are unchanged.** FDS-v1 doesn't touch this axis; can ship in parallel with v3.x → v4.0 alias-removal work.

In v4.0, symlink and fallbacks are removed. `flywheel-migrate-state` becomes a no-op for already-migrated projects.

**The interactive migration command.**

```
$ /flywheel-migrate-state

FLYWHEEL STATE MIGRATION  →  FDS-v1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Current state: .pi-flywheel/ (legacy)
Target state:  .flywheel/   (FDS-v1)

Items to migrate:
  ✓ checkpoint.json                  (3 KB)
  ✓ error-counts.json                (1 KB)
  ✓ profile-cache.json               (12 KB)
  ✓ tender-events.log                (450 KB → splitting into shards)
  ✓ completion/<31 files>            (45 KB total)
  • plans/                           (does not exist; will be created)
  • swarm/heartbeats/                (does not exist; will be created)
  • beads/graph-snapshot.json        (will be initialized from current br state)
  • agent-mail/reservation-health.json (will be initialized empty)
  • schema.json                      (will be created — FDS-v1 catalog)

A symlink .pi-flywheel/ → .flywheel/ will be created for back-compat.
This symlink is removed in v4.0; use this minor for testing.

Estimated time: <5 seconds
Reversible: yes (rerun with --rollback)

Proceed?  [Y/n]
```

The command writes a per-step ledger to `.flywheel/migration-log.json`. Each step is mv-atomic; mid-migration crash is recoverable by rerunning.

**Telemetry.** Migrator increments `error-counts.json` for `migration_skipped_<reason>`, `migration_partial`, `migration_rollback_invoked`, `migration_v1_to_v1_1`. Aggregate is anonymous.

**Rollback.** `/flywheel-migrate-state --rollback` reads `.flywheel/migration-log.json` and reverses each step. If `.flywheel/` has gained content the legacy layout doesn't represent (e.g., `convergence.json`, `swarm/heartbeats/`), those are *preserved in a quarantine directory* `.flywheel-quarantine-<ts>/` rather than deleted.

**Cross-version drift detection.** Doctor check `flywheel_layout_v1` runs at every `/start`:

- `green`: `.flywheel/` exists, all schema versions match catalog.
- `yellow`: `.flywheel/` exists but a subset of files is at older `schema_version` — surface migration prompt.
- `red`: `.pi-flywheel/` exists, `.flywheel/` does not — surface migration prompt as the first thing the user sees.

Migration is never applied silently. Every state mutation is user-acknowledged.

(Phase 10 §4 surfaced concrete migration risks, particularly §4.3 "half-finished sessions migrate to inconsistent state." That risk is real and is why Phase 12 cut the rename. The most-ambitious framing requires the migration to be gated behind `checkpoint.json.phase` being `idle`/`complete` — refusing to run mid-wave with a clear "finish current wave or rollback first" error.)

### A.9 Effort estimate (deepened)

| Capability | LOC | Risk | Wave |
|------------|-----|------|------|
| C3 atomic-write helper + reader | ~150 | low | 1 |
| C3 layout migration + interactive `flywheel-migrate-state` | ~350 | medium-high | 1 |
| C3 `.flywheel/schema.json` catalog | ~80 | low | 1 |
| C3 `flywheel_observe` rewrite as disk reader | ~300 | medium | 2 |
| C5 envelope shape + closed-enum codes file | ~120 | low | 2 |
| C5 retry classifier + integration | ~180 | medium | 2 |
| C1 generic `lib/timeseries-ringbuffer.ts` | ~200 | low | 2 |
| C1 `RevisionMetrics` computation | ~250 | low | 2 |
| C1 `ConvergenceState` ring buffer + score | ~200 | low | 2 |
| C1 oscillation detector (B6 fix) | ~100 | low | 2 |
| C1 Step 5.45 default-arming | ~50 | low | 3 |
| C1 `flywheel_plan` returns convergence block | ~80 | low | 3 |
| C1 bead-graph snapshot ring buffer + doctor check | ~180 | low | 3 |
| C1 swarm-pane heartbeat ring buffer + `degrading` advisory | ~200 | medium | 3 |
| C1 agent-mail reservation-health ring buffer | ~120 | low | 3 |
| C2 path-claim extractor (extend existing) | ~150 | low | 3 |
| C2 bundle generator + atomic write + responses freezing | ~300 | medium | 3 |
| C2 `code_every_n` in `flywheel_advance_wave` | ~100 | low | 4 |
| C2 Step 5.45 "Refine" → bundle path | ~50 | low | 4 |
| C2 bead provenance.refine_bundle | ~60 | low | 4 |
| C2 bundle editable-by-operator hook | ~100 | low | 4 |
| C4 `flywheel.config.yaml` templates block + loader | ~150 | low | 4 |
| C4 `prompt_quality_check` helper | ~50 | low | 4 |
| C4 every skill → template lookup migration | ~200 | medium | 4 |
| C4 `flywheel templates pin` / `templates diff` commands | ~120 | low | 4 |
| Doctor checks expansion (6 new checks) | ~300 | low | 4 |
| **Total** | **~3940** | | **4 waves** |

Phase 8 figure was ~1830 LOC / 14 beads. Phase 9 expansion is ~3940 LOC / 22 beads (+115% LOC, +57% bead count). Marginal LOC per added capability is favorable — 100–200 LOC per new doctor check / new ring-buffer surface — because the substrate amortizes.

### A.10 Suggested bead breakdown (deepened)

22 beads organized in 4 waves:

- **Wave 1 (foundation)**: B-FDS-1 (atomic-write helper + ring buffer lib), B-FDS-2 (migration command + schema catalog).
- **Wave 2 (math + envelope)**: B-FDS-3 (C5 envelope + retry classifier), B-FDS-4 (convergence math + oscillation), B-FDS-5 (`flywheel_observe` rewrite).
- **Wave 3 (wiring + ring buffers)**: B-FDS-6 (bundle generator), B-FDS-7 (`code_every_n`), B-FDS-9 (templates loader), B-FDS-11 (pane heartbeats), B-FDS-12 (bead-graph snapshot), B-FDS-13 (reservation-health), B-FDS-14 (envelope conformance test), B-FDS-17 (Codex emit drift test), B-FDS-18 (banner update).
- **Wave 4 (polish + final)**: B-FDS-8 (bundle-edit-before-send), B-FDS-10 (templates pin/diff), B-FDS-15 (doctor expansion), B-FDS-16 (`flywheel_codebase_convergence_history`), B-FDS-19 (Cytoscape overlay), B-FDS-20 (feedback aggregation), B-FDS-21 (cleanup awareness), B-FDS-22 (CHANGELOG + AGENTS.md + README docs update).

Dependency edges: B-FDS-1 blocks 2/4/5/6/11/12/13. B-FDS-2 blocks every consumer of `.flywheel/` paths. B-FDS-3 blocks 14/15. B-FDS-4 blocks 7/18/19. B-FDS-9 blocks 10/17. B-FDS-15 blocks 22.

### A.11 Phase 9 → 10 hand-off (the questions Phase 10 ended up answering)

Phase 9 explicitly handed Phase 10 a list of areas to stress-test:

1. Race conditions in the `.flywheel/` migration when run on an active session. (→ Phase 10 §4.3 confirmed.)
2. Memory leaks in the `fs.watch` fallback path.
3. Per-provider tokenizer drift.
4. The "stateless server" doctor check producing false positives.
5. Symlink fallout on Windows. (→ Phase 10 §4.1 partial; treated as a deal-breaker for the rename.)
6. CompletionReportSchemaV1 + FDS-v1 schema interaction.
7. C5 envelope retro-fit on `orch_*` aliases.
8. Concurrent refine-bundle generation across panes. (→ Phase 10 §2 confirmed; the CAS pattern was unsound.)

Phase 10's blunder hunt confirmed several of these (notably §1.x atomic-write durability, §2.1 the unsound CAS, §4.1 the rename's grep-blast-radius, §5.1 conflict with AGENTS.md Hard Constraint #6, §5.3 conflict with `AskUserQuestion` invariant, §5.4 LOC budget realism). Phase 12 then weighted those findings against the additive value of FDS-v1 and chose the scope-down path.

### A.12 Phase 9 net summary

The most ambitious framing: A1 + A2 + A3 + A4 + A5 as one cluster, ~22 beads, ~3940 LOC, ushers in `.flywheel/` as a versioned event substrate that re-bases every flywheel surface. Direct alignment with project principles #1/#5/#7. Cross-cluster effects light up doctor (+6 checks), swarm coordination (heartbeat ring buffer + `degrading` advisory), agent-mail visibility (reservation-health ring buffer + local mirror), bead graph (per-wave snapshot + Cytoscape overlay), reality-check (oscillation-aware), `flywheel_emit_codex` (template resolution), `flywheel_calibrate` (tool-latency histogram from `meta.durationMs`), and every skill that consumes prompts (template-driven).

Why Phase 12 didn't ship it: the migration friction (§4.x) and the AGENTS.md/README invariant conflicts (§5.x) make this a 2-3-release lift, not a single-cluster ship. The right shape is **A1 in v3.12 (per Phase 12), A4 + C5 generalization in v3.13 (templates + envelope, no rename), A2 + bundle-as-audit-artifact in v3.14, A3 substrate + rename in v4.0** — each under a single cluster framing, but four clusters not one.

Phase 9's contribution: showing that the destination is real, the cross-cluster leverage is real, and the project's stated principles already point that direction. The conservative ship Phase 12 chose is consistent with the destination, not in tension with it.

---

