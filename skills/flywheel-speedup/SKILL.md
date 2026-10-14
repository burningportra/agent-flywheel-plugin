---
name: flywheel-speedup
description: Make a slow endpoint, flow, job, or service fast. Baselines and profiles it, freezes behavior with real-data e2e tests, then either optimizes in place or, when the slowness is structural, plans a same-API re-architecture, swarms it through the flywheel, gauntlets it under load, and cuts over behind a canary with automatic rollback. Use when "speed this up", "make this fast", "too slow", "p99", "latency", "throughput", "rewrite for performance", or a KPI like "10s to under 500ms".
---

# /flywheel-speedup — make it fast, then prove it

This is Jeffrey Emanuel's speedup recipe as a flywheel track (source: his 2026-09-14 post, where it took one user's main bottleneck from 32.6 s to 3.3 ms in about a week). The premise: computers are unbelievably fast when the data is laid out correctly, so most "slow" systems are slow because of their architecture and data model, not their language or hardware.

The track has two lanes and picks one automatically from measurements:

- **In-place:** profile-driven optimization of the existing code, one proven change at a time.
- **Re-architecture:** a new system with the **same API surface** and a **radically different architecture and data model**, built by the flywheel's swarm, run in parallel with the old one, then cut over gradually with automatic rollback.

Everything lands in `docs/speedup/<slug>/`. Each phase writes its artifact before the next phase starts, so a run can resume from the last artifact on disk.

## Companion skills

The phases call these skills when they're installed and fall back to the inline steps here when they aren't (most are separately installed jeffreys-skills.md skills). Try the slash skill first; if it reports "not installed" or "unknown skill", follow the fallback without stopping.

| Phase | Skill | Inline fallback |
|---|---|---|
| 1 Baseline | `/profiling-software-performance` | Phase 1 fallback below |
| 2 Freeze behavior | `/testing-golden-artifacts`, `/testing-conformance-harnesses`, `/testing-metamorphic` | Phase 2 fallback below |
| 4 In-place | `/extreme-software-optimization` | Phase 4 fallback below |
| 5 Plan to beads | `/beads-workflow` (via the flywheel's `_beads.md`) | built into the flywheel |
| 5 Swarm | `/ntm`, `/vibing-with-ntm` (via `_implement.md`) | built into the flywheel |
| 6 Gauntlet | `/running-the-gauntlet-on-your-rust-port` (Rust targets only) | Phase 6 fallback below |
| any Rust async work | `/asupersync-mega-skill` | none needed |

## Phase 0: Intake

Infer as much as possible from `$ARGUMENTS`, the repo, and the user's message before asking anything. You need:

1. **Target** — the endpoint, user flow, job, or query that's slow, with the entry point in code.
2. **KPI** — metric, current value, target value, and percentile. Default to p99 latency of the target when the user only says "faster". Example: `p99 /api/inbox 10s -> <500ms`.
3. **Traffic constraint** — does it serve live or paying users? If so, phases 6–7 are mandatory before anything replaces it.
4. **API surface to preserve** — routes, request and response schemas, error shapes, CLI flags, or library signatures that callers depend on.
5. **Real-data source** — a production snapshot, replayable logs, or a fixture generator that matches production volumes. Synthetic toy data is not enough; the recipe depends on real data shapes and sizes.

Ask with one `AskUserQuestion` call for whatever you can't infer (at most four questions). Then write `docs/speedup/<slug>/brief.md` with the five items and the date.

## Phase 1: Baseline and profile

Invoke `/profiling-software-performance` on the target with the brief as context, and tell it not to modify code.

**Fallback:**

1. Record a machine fingerprint (CPU, cores, RAM, OS, runtime versions, build profile) in `baseline.md`.
2. Run the target at least 20 times on the real-data snapshot with a warmup, using the stack's load or bench tool (`hyperfine` for commands, `oha`/`wrk`/`k6`/`vegeta` for HTTP, the language's bench harness for functions). Record p50, p95, p99, throughput, peak memory, and the coefficient of variation.
3. Capture one CPU profile of a representative run (`perf`/`samply`/`cargo flamegraph` for native, `py-spy` for Python, `clinic flame` or `--cpu-prof` for Node, `pprof` for Go, `async-profiler` for the JVM) plus I/O and query counts when a database is involved.
4. Write a ranked hotspot table to `baseline.md`: function or query, share of wall time, evidence file.

No baseline means no speedup claim later. If you can't run the target, stop and say exactly what's missing.

## Phase 2: Freeze behavior on real data

Before changing anything, build the oracle both lanes are judged against: one e2e test per major user flow that touches the target, fed by the real-data snapshot.

- Exact outputs → `/testing-golden-artifacts` (freeze, canonicalize, review once, then diff in CI).
- Old-vs-new comparison → `/testing-conformance-harnesses` (differential runs, discrepancy log, compliance matrix). The re-architecture lane needs this.
- No exact oracle (ranking, floating-point aggregation, sampling) → `/testing-metamorphic` relations.

**Fallback:** for each flow, record the request and response pairs from the real-data run into `tests/golden/speedup/<slug>/`, canonicalize them (sort unordered collections, scrub timestamps and IDs, fix float precision explicitly), and add a test that replays the requests and diffs the responses. Commit the goldens only after you've looked at a sample by eye.

Write `docs/speedup/<slug>/oracle.md` listing each flow, its test, and the data snapshot it uses.

## Phase 3: Triage

Decide the lane from the numbers and print the reasoning. Don't ask the user; they can override after reading it.

1. **Gap** = baseline KPI ÷ target KPI.
2. **Amdahl bound** = the best KPI you could reach if the top hotspots that are local fixes went to zero time. Local fixes are N+1 queries, missing indexes, quadratic loops, repeated pure computation, needless serialization, and unbatched I/O.
3. Pick **in-place** when the Amdahl bound reaches the target and those hotspots really are local.
4. Pick **re-architecture** when the bound misses the target, or when the time is spread across the design: recomputing over the whole dataset per request, a storage model that fights the access pattern, row-at-a-time processing of millions of records, fan-out across services, or a gap of about 20× or more with no dominant hotspot.

Write `triage.md` with the gap, the bound, the top hotspots, the lane, and one paragraph of reasoning.

## Phase 4: In-place lane

Invoke `/extreme-software-optimization` with `baseline.md`, `triage.md`, and the Phase 2 oracle.

**Fallback:** for each hotspot in score order, write down the hypothesis and the behavior-preservation argument, make one change, rerun the oracle and the benchmark, keep it only if the oracle passes and the KPI moves beyond run-to-run noise, and commit it alone so it can be reverted alone. Add a ratchet benchmark that fails CI if the KPI regresses past the new value.

When there are many independent hotspots, turn them into beads with the `improve-performance@1` template and hand them to the normal flywheel swarm instead of working them serially.

If the loop converges (two rounds with no kept change) and the KPI still misses the target, escalate to Phase 5 and carry `baseline.md` and the in-place results forward as evidence.

## Phase 5: Re-architecture lane

### 5a. Design brief

Write `docs/speedup/<slug>/design-brief.md` containing:

- The extracted **API contract**: every route, schema, status code, error shape, ordering guarantee, and side effect that callers observe, with file references.
- The **workload model**: data volumes, growth, update rate, read/write mix, request mix, and the latency distribution from `baseline.md`.
- The **KPI and cost targets**: the latency percentile target and the cost to serve per request or per thousand requests.
- The **constraints**: live traffic, data retention, deployment platform, team skills.
- The **instruction**: design a new system that is compatible with the same API surface but uses a radically different architecture and data model, with extreme performance and the cheapest possible serving as the objectives and the best achievable p99. Start from data layout (what is precomputed or incrementally maintained, what lives in memory, how it's indexed, how records are laid out for the hot access pattern) before choosing services or frameworks. The language is open; choose whatever hits the targets. When the design lands on Rust, consider the Franken stack as candidates: asupersync (cancel-correct async runtime), fastapi_rust (typed HTTP framework on asupersync), and frankenredis (in-process Redis-compatible store).

### 5b. Plan

Author `docs/speedup/<slug>/plan.md` at maximum reasoning effort. Model its depth and rigor on Jeffrey's exemplar plan, <https://github.com/Dicklesworthstone/frankengit/blob/main/COMPREHENSIVE_PLAN_FOR_THE_DESIGN_OF_FRANKENGIT.md>. Read it for shape and level of detail, but don't copy its text, since it carries no license. The plan must have these sections:

1. Executive conclusion: the architecture in one page and why it hits the KPI.
2. API compatibility matrix: every contract item from the brief, mapped to how the new system satisfies it.
3. Workload model and scale envelope.
4. Data layout and state model: the core of the design.
5. Topology and request path, with a **p99 latency budget per hop**.
6. Cost model: cost to serve at today's load and at 10× load.
7. Correctness plan: how the Phase 2 oracle and a differential harness gate every change.
8. Parallel-run and gauntlet plan (Phase 6).
9. Shadow, canary, and rollback design (Phase 7).
10. Risk register and open decisions.
11. Work breakdown sized for beads, with dependencies.
12. Definition of done, phrased as measurable gates.

### 5c. Cross-model review

Have a second, different frontier model review and improve the plan against the particulars of this codebase, not just the plan's internal logic. Use the flywheel's existing reviewers: the `planning-workflow` Codex review rounds in `skills/start/_planning.md` (NTM `cod` panes) or `/multi-model-triangulation`. Fold the accepted changes into `plan.md` and log the rejected ones with reasons at the end of the file.

### 5d. Hand off to the flywheel

Register the plan and let the normal pipeline build it:

1. `flywheel_select({ cwd, goal: "Speedup: <target> <KPI>" })`
2. `flywheel_plan({ cwd, planFile: "docs/speedup/<slug>/plan.md", source: "picked-up-existing-plan" })`
3. Continue at Step 5.45 of `/agent-flywheel:start`: validate, then bead creation (`_beads.md`), then the NTM swarm (`_implement.md`).

Make sure the bead graph includes beads for the Phase 2 oracle (if not done), the differential harness, the load harness, the traffic splitter, and the rollback automation. Those are part of the deliverable, not follow-ups.

## Phase 6: Parallel run and gauntlet

Run the new system beside the old one on the same real data.

- **Differential:** replay captured real traffic to both systems and diff every response through the Phase 2 oracle. Any mismatch blocks the cutover.
- **Load:** drive both at today's peak and at 3–10× peak, and record p50, p95, p99, error rate, and resource cost per request.
- **Optimize under load:** profile the new system under load and keep optimizing until the KPI holds at peak with margin.

For Rust targets, invoke `/running-the-gauntlet-on-your-rust-port`.

**Fallback:** repeat rounds of differential, load, profile, and one fix, until three consecutive rounds are clean (zero diffs, KPI met at peak, coefficient of variation ≤ 5%). Record each round in `gauntlet.md`.

## Phase 7: Cutover with automatic rollback

Build the cutover as code, matched to how the service is deployed: weighted upstreams at the load balancer or proxy, an application-level flag that hashes a stable user or tenant key into a bucket, or the platform's percentage feature flags.

Stages:

1. **Shadow:** mirror real traffic to the new system, serve 0% of responses from it, and diff continuously.
2. **Canary:** 1%, then 5%, 25%, 50%, and 100% of users.

The **automatic rollback** routes 100% back to the old system without human action when any trigger fires during a stage: error rate above the old system's error rate plus a set margin, p99 above the old p99 or the SLO, or any response-diff mismatch in shadow or canary. Test the rollback path itself in staging before the first canary.

Before each ramp step past shadow, show the stage's measurements and get explicit approval with `AskUserQuestion` (options: ramp to the next stage, hold at this stage, roll back). Never ramp real traffic without that approval.

Write the runbook, triggers, and per-stage results to `docs/speedup/<slug>/cutover.md`. Keep the old system deployable until the new one has run at 100% for an agreed soak period.

## Phase 8: Report

Write `docs/speedup/<slug>/report.md` with a before-and-after table (p50, p95, p99, throughput, and cost per request, baseline machine versus the same machine afterwards), the lane taken and why, and links to every artifact. Wire the ratchet benchmark into CI so the gain can't silently regress. Store the outcome with `flywheel_memory({ operation: "store" })` so future speedup runs can reuse what worked.

## Rules

- Every speedup claim cites a measurement from the same machine and data as its baseline. A microbenchmark doesn't prove an end-to-end claim.
- The Phase 2 oracle passes on every kept change. Faster and wrong is a regression.
- Nothing replaces a system that serves live users without the Phase 6 differential and the Phase 7 rollback in place.
- Spawned implementation work goes through NTM like every other flywheel swarm (see AGENTS.md).
