# 1wg — `ntm assign --strategy=dependency` must see Pi/Cod panes (needs ntm upstream)

**Status:** wontfix-upstream-coordinate — lives in the `ntm` CLI repo, not here.
**Bead:** `claude-orchestrator-1wg` (P1 / P2.3)
**Date:** 2026-05-03

## What we observed

Spawning `ntm spawn $NTM_PROJECT --cc=2 --pi=4` produces 6 working tmux panes
(2 CC + 4 Pi), but `ntm assign --auto --strategy=dependency` reports
`Idle Agents: 2` — only the CC panes are recognized as assignable. The 4 Pi
panes still pick up work, but only via a self-claim path triggered by a
broadcast nudge ~60s later.

## Effect on the flywheel

Operator ran a 50-bead wave expecting "4 + 2" parallelism. Real dispatch was
"2 + 4 self-claim":

- CC panes: immediate dispatch via `--strategy=dependency`.
- Pi panes: ~60s of idle wall-time per bead, then self-claim via
  `bv --robot-triage` after a broadcast nudge.

Net effect: the swarm's true throughput on bead-bound work was effectively
halved during dispatch storms, and load skewed to the CC lane. The exposed
"4 + 2" topology was misleading.

## Where the fix lives

The pane-type filter inside `ntm assign --strategy=dependency`. Best guess
of the path that needs changing (verify against current ntm tree):

- The agent-discovery routine that powers `ntm assign --strategy=dependency`
  filters tmux pane env (`NTM_AGENT_TYPE`?) and only counts panes whose
  type matches a `cc`-only allowlist.
- Pi/Cod panes are already registered with NTM (they appear in
  `ntm --robot-snapshot` and `list_window_identities`), so the registration
  layer is correct — only the assign-strategy filter is too narrow.

## Proposed shape

Either:

1. **Default behavior changes** — `--strategy=dependency` includes ALL
   ready/idle panes (cc, pi, cod) in the candidate pool. Add an opt-in
   `--strategy=cc-only` flag for operators who genuinely want to restrict
   dispatch to a single agent type.
2. **New strategy alias** — keep `--strategy=dependency` as today's
   CC-only behavior (back-compat), and add `--strategy=all-panes` as the
   new default for swarms with mixed pane types.

Option (1) is the right default — the misleading count caused observable
operator surprise and ~60s of wasted wall-time per bead. Option (2) is a
softer rollout if back-compat with existing scripts matters.

## Telemetry the upstream issue should request

To make the fix verifiable, the ntm side should log:

```
ntm assign --auto --strategy=dependency
  candidates: 6 (cc=2, pi=4, cod=0)
  idle:       6
  filtered:   0 (was: 4 pi panes, removed by cc-only allowlist)
  assigned:   N
```

That makes it obvious from telemetry alone whether the regression has
returned in a future ntm release.

## Acceptance from the flywheel side

Once shipped:

- A `4pi + 2cc` swarm dispatches all 6 panes immediately on the first
  `ntm assign` call.
- `Idle Agents` count matches the actual idle pane count, not just
  `cc` panes.
- Tender-daemon's `pane_assigned` events show pi panes receiving direct
  assignments (not just self-claim events).

## Suggested coordination

Open an issue against the `ntm` CLI repo (the project that ships the
`ntm spawn` / `ntm assign` binaries — exact GitHub path not encoded here
because it varies by maintainer fork; the operator who triages this should
file against whichever ntm repo this host pulls from). Reference this doc
plus the original feedback bead `claude-orchestrator-1wg` and the
2026-05-03 operator post-mortem.
