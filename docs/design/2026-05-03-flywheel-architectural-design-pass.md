# agent-flywheel — architectural design pass (2026-05-03)

Three observations from the 2026-05-02/03 session that are too cross-cutting to bead-ify. Each needs a design pass — sketch + tradeoffs + decision — not a one-shot fix. Keep this doc as the seed for the next design discussion; do not turn into beads until each has a chosen direction.

Companion to the 9 implementation beads filed under tag `flywheel-feedback` (P1.1 → P3.2). Those are the surgical fixes; this is the structural side.

---

## A. Skill modularity is fighting the deferred-MCP overhead

### What was observed
Step 0 of the start skill spans `SKILL.md` + `_inflight_prompt.md` + `_deslop.md` + `_planning.md` + 7 more sub-files. The "load on demand to save context" pattern was introduced to keep the prompt under token limits, but every sub-file load now goes through `flywheel_get_skill` — which is itself deferred (per problem statement P2.1) and costs a `ToolSearch` round-trip. Net: token cost is plausibly higher than a flat skill would have been.

### The tension
Flat skill = predictable load cost, no gates, no hidden state. Modular skill = lower idle context, but every gate needs an MCP call to fetch and the operator pays both the catalog noise AND the load.

### Sketches to consider
1. **Inline the hot path back into SKILL.md.** Step 0 (banner + state detect + main menu + routing table) becomes one file. Phase bodies (`_planning`, `_implement`, `_review`, `_wrapup`) stay separated. Best-of-both: cold phases stay on disk, hot path stays in head.
2. **Eager-load the bundled body.** Build-time bundle already exists (`mcp-server/dist/skills.bundle.json`); ship it as part of the plugin manifest's eager-resource list. `flywheel_get_skill` becomes a free in-memory map lookup.
3. **Deprecate the modular pattern.** Embrace one big skill file (~3-5k LOC). Bet on Claude's context window growing faster than the file does.

### Decision needed
Which of (1)/(2)/(3) — or a hybrid — before any more skill-edit churn. Pair with P2.1 (eager-load) so the load cost is paid once, not per gate.

### What NOT to do
Do not split further. The current modularization already costs more than it saves; adding more sub-files compounds the problem.

---

## B. No real observability into the swarm itself

### What was observed
Every monitoring action in the session went through `br list` polling. The actual agent activity — which file is being edited, what test is running, why a bead got reassigned — is invisible. The tender-daemon was supposed to carry this signal but its parser is broken (problem statement P1.2). Worse: even if P1.2 lands, the daemon emits NDJSON to a log file the operator has to manually tail; there's no visualization, no aggregation, no "what's happening RIGHT NOW" pane.

### The tension
Real-time observability of N agents is hard — naive solutions either flood the operator with noise (every keystroke) or hide the wrong things (only show "stuck" agents, miss productive ones drifting off-spec). NTM's tmux-pane model gives you one view but only if you `attach`; the orchestrator never sees what the operator sees.

### Sketches to consider
1. **Per-pane activity summary.** Every 30s the tender-daemon snapshots each pane's last-edit-target + last-tool-call + agent-mail-status, writes to `.pi-flywheel/swarm-snapshot.json`. The orchestrator (or a `flywheel_swarm_status` MCP tool) renders this as a table on demand. Cheap, derivative.
2. **Live dashboard via web UI.** Spin up a localhost http server (port 7654) that subscribes to the tender-daemon's NDJSON stream + agent-mail inbox + git status, renders a 3-pane web UI: agents/beads/files. Heavy, more useful, more bugs.
3. **Treat agent-mail as the protocol.** Mandate every impl agent send a structured `[heartbeat]` message every N seconds (`{ pane, current_file, last_tool, in_progress_bead }`). Orchestrator consumes via `fetch_inbox`. Lightweight, requires every agent to comply (agents already skip half their bootstrapping — see CrimsonLake's "are there really workers running" pause this session).

### Decision needed
Which observability surface, and at what cost. Tied to P1.2 (parser fix) and P3.2 (auto-teardown) since both depend on accurate per-pane state.

### What NOT to do
Do not invent a new IPC mechanism. Use what's already there: agent-mail messaging, NDJSON event log, NTM snapshot API. Adding a fifth signal source compounds the problem rather than solving it.

---

## C. Slash-command-as-thin-pointer indirection costs more than it saves

### What was observed
`/agent-flywheel:start` is a thin pointer to the canonical body in `skills/start/SKILL.md`. The pattern was introduced in v3.6.3 (per the in-pointer notes) to fix multi-place-edit drift. But:
- When invoked, the `Skill` tool sometimes returns the pointer text instead of the canonical body. Operator falls back to `Read`.
- Same pattern applies to `_inflight_prompt.md` and other sub-files.
- The pointer-to-canonical-body indirection costs ~1500 tokens of read overhead per invocation vs. inline-loading the skill body.

### The tension
Single source of truth is good. But the indirection is paid by the model on every invocation, while the original drift bug only paid the cost on every release. Net: trades a low-frequency build-time tax for a high-frequency runtime tax.

### Sketches to consider
1. **Leave pointer, fix the Skill tool.** When `Skill` returns pointer text, it should auto-resolve and re-render the canonical body. Push this upstream into Claude Code.
2. **Replace pointer with build-time inline.** A pre-publish script copies SKILL.md content into the slash-command file, leaving the pointer body as a comment-only header. Drift is impossible because the inline content is regenerated on every release.
3. **Remove the slash command entirely.** Operators invoke the skill directly via `Skill(skill: "agent-flywheel:start")`. Lose discoverability via `/agent-flywheel:` autocomplete; gain a fully-loaded skill with no indirection.

### Decision needed
Most likely (2) — build-time inline, keep autocomplete, kill the runtime tax. But verify Claude Code's slash-command system tolerates large inlined files.

### What NOT to do
Do not add MORE pointer indirection (e.g., pointer → loader → canonical). Each layer doubles the runtime cost.

---

## Cross-cutting note

A, B, and C all share a root cause: **the system was designed assuming load-time costs are free**. Every additional skill file, deferred MCP tool, and pointer-indirection pays a runtime tax in tokens + latency that compounds across a multi-hour swarm session. The next design pass should explicitly budget for runtime cost as a first-class metric — not just "does this work" but "what does it cost to invoke 50 times per session".

When the 9 surgical beads (P1.1 → P3.2) land, re-measure. If session cost drops by ≥20%, the surgical fixes were sufficient. If not, A/B/C need to land too.
