# Gap Analysis: Agent Flywheel Guide vs claude-orchestrator

Source: https://agent-flywheel.com/complete-guide  
Updated: 2026-04-09  
Method: Guide inventory x codebase inventory (skills/, mcp-server/src/, AGENTS.md, README.md)

---

## STATUS LEGEND

- **CLOSED** — Previously a gap, now implemented
- **CRITICAL** — Feature exists in guide, absent from codebase
- **PARTIAL** — Feature partially implemented, missing pieces
- **PROCESS** — Workflow/UX gap, not code
- **ARCHITECTURAL DIFFERENCE** — Intentional substitution, not a gap

---

## CLOSED GAPS (resolved since last analysis)

### C1. UI/UX Polish Phase — CLOSED
- **Was**: Entirely absent
- **Now**: `ui-ux-polish` skill implements full 5-phase flow: scrutiny (15-30 suggestions) -> human selection -> bead conversion -> implementation -> de-slopification
- **Closed by**: skills/ui-ux-polish/SKILL.md

### C2. Idea-Wizard — CLOSED
- **Was**: No feature ideation support
- **Now**: `ideation-funnel.ts` implements 3-phase winnowing (30 -> 5 -> 15) with model divergence for real winnowing, dedup against existing beads
- **Closed by**: mcp-server/src/ideation-funnel.ts

### C3. Staggered Agent Starts — CLOSED
- **Was**: No thundering herd prevention
- **Now**: `SWARM_STAGGER_DELAY_MS = 30_000` in prompts.ts, applied per-agent in swarm.ts
- **Closed by**: mcp-server/src/prompts.ts, mcp-server/src/swarm.ts

### C4. Post-Compaction AGENTS.md Re-read — CLOSED
- **Was**: Not handled
- **Now**: Proactive re-read instructions in prompts.ts, tender.ts nudges confused agents, swarmMarchingOrders includes explicit re-read
- **Closed by**: mcp-server/src/prompts.ts, mcp-server/src/tender.ts

### C5. Strategic Drift Detection — CLOSED
- **Was**: No drift checking
- **Now**: `orchestrate-drift-check` skill + `driftCheckInterval` config (default every 3 beads) + `beadsCompletedSinceDriftCheck` counter
- **Closed by**: skills/orchestrate-drift-check/SKILL.md, mcp-server/src/types.ts

### C6. Convergence Scoring for Bead Polishing — CLOSED
- **Was**: No convergence metric computed or surfaced
- **Now**: `computeConvergenceScore()` in shared.ts computes weighted score from polish change history and output size stability. Displayed in approve.ts with threshold guidance (75%+ = ready, 50-75% = converging, <50% = needs more). Polish round history tracked per-session.
- **Closed by**: mcp-server/src/tools/shared.ts, mcp-server/src/tools/approve.ts

### C7. Gemini in Deep Planning — CLOSED
- **Was**: Only Claude + Codex models in deep planning
- **Now**: `model-detection.ts` dynamically detects Google/Gemini models. When available, adds a 4th "fresh-perspective" planner. `plan.ts` conditionally spawns it via `dynamicModels.freshPerspective`.
- **Closed by**: mcp-server/src/model-detection.ts, mcp-server/src/tools/plan.ts

### C8. DCG (Destructive Command Guard) — CLOSED
- **Was**: Only social enforcement via AGENTS.md rules
- **Now**: `orchestrate-setup` step 7 installs a PreToolUse hook in `.claude/settings.json` that pattern-matches and blocks destructive commands (rm -rf, git reset --hard, git clean -f, git push --force, DROP TABLE) before execution.
- **Closed by**: skills/orchestrate-setup/SKILL.md

### C9. bv Prioritization in Marching Orders — CLOSED
- **Was**: Unclear if agents use bv to pick beads
- **Now**: `swarmMarchingOrders()` explicitly includes `bv --robot-triage` for swarms. `bv --robot-next` documented in agents-md.ts, swarm.ts, and prompts.ts for solo work.
- **Closed by**: mcp-server/src/prompts.ts, mcp-server/src/swarm.ts, mcp-server/src/agents-md.ts

### C10. Pre-commit Guard Auto-Install — CLOSED
- **Was**: Not auto-installed during setup
- **Now**: `orchestrate-setup` step 6 calls `install_precommit_guard` via Agent Mail MCP tool.
- **Closed by**: skills/orchestrate-setup/SKILL.md

### C11. Three Reasoning Spaces Framing — CLOSED
- **Was**: Not surfaced to user
- **Now**: Orchestrate Step 5 displays the Plan/Bead/Code reasoning spaces with 1x/5x/25x rework cost ratios before the planning mode choice.
- **Closed by**: skills/orchestrate/SKILL.md

### C12. Best-of-All-Worlds Synthesis Prompt — CLOSED
- **Was**: Generic "synthesize into one optimal plan" instruction
- **Now**: Synthesis agent prompt requires honestly acknowledging each plan's strengths before blending. Must state which plan's approach was adopted for each decision. Flags unresolved tensions. Both in plan.ts (synthesisPrompt field) and orchestrate SKILL.md (Step 5.7).
- **Closed by**: mcp-server/src/tools/plan.ts, skills/orchestrate/SKILL.md

### C13. UBS Execution — CLOSED
- **Was**: Listed as stub with no invocation code
- **Now**: Already implemented in gates.ts — UBS gate runs `ubs` on changed files, reports results, gates on failures. Skips gracefully if binary absent.
- **Closed by**: mcp-server/src/gates.ts (lines 185-212)

### C14. Adversarial Random Code Exploration — CLOSED
- **Was**: No adversarial reading pass
- **Now**: New "adversarial" gate in gates.ts randomly selects files, instructs agent to trace execution flows as an adversary hunting bugs without knowing what changed. Runs automatically between de-slopify and UBS gates.
- **Closed by**: mcp-server/src/gates.ts

### C15. Timed Cross-Agent Review Cadence — CLOSED
- **Was**: No timed cadence for cross-agent reviews
- **Now**: SwarmTender tracks `lastCrossReviewAt` with configurable `crossReviewIntervalMs` (default 45 min). Fires `onCrossReviewDue` callback when threshold exceeded. `recordCrossReview()` method resets timer.
- **Closed by**: mcp-server/src/tender.ts

### C16. Commit Cadence Tracking — CLOSED
- **Was**: No commit cadence warnings
- **Now**: SwarmTender tracks `lastCommitCheckAt` with configurable `commitCadenceMs` (default 90 min). Fires `onCommitOverdue` callback when exceeded. `recordCommit()` method resets timer.
- **Closed by**: mcp-server/src/tender.ts

### C17. Fungibility Principle in Marching Orders — CLOSED
- **Was**: Not explicitly stated
- **Now**: `swarmMarchingOrders()` includes explicit fungibility statement: generalist agents, no role specialization, any agent can resume any bead, no single point of failure.
- **Closed by**: mcp-server/src/prompts.ts

### C18. Test Bead Auto-Generation — CLOSED
- **Was**: Test tasks not auto-generated as companion beads
- **Now**: Orchestrate Step 5.5 includes explicit instruction to create companion test beads when acceptance criteria include testing requirements, with dependencies on impl beads.
- **Closed by**: skills/orchestrate/SKILL.md

### C19. Rate Limit / CAAM Guidance — CLOSED
- **Was**: Vague "switch account" guidance with no detection
- **Now**: Cadence checklist updated with actionable rate-limit detection (slow/degraded output) and specific options: `caam switch`, fresh agent on different account, or 5-min pause.
- **Closed by**: mcp-server/src/tender.ts

### C20. Fresh-Round Refinement (Anchoring Prevention) — CLOSED
- **Was**: No mechanism for sequential fresh-conversation rounds
- **Now**: Optional Step 5.9 "Iterative deepening" spawns 2-3 fresh agents in isolation, each reviewing the synthesized plan with no memory of prior rounds. Stop when changes are minor.
- **Closed by**: skills/orchestrate/SKILL.md

### C21. Major Feature Integration Workflow — CLOSED
- **Was**: `orchestrate-research` stopped at "extract insights"
- **Now**: Extended with Phases 8-12: integration proposal, iterative deepening, 5x blunder hunt, cross-model feedback, Best-of-All-Worlds final synthesis. Activated when goal is integration, not just research.
- **Closed by**: skills/orchestrate-research/SKILL.md

---

## ALL GAPS CLOSED

All critical, partial, and process/UX gaps have been resolved. See the CLOSED GAPS section above for implementation details on each item (C1-C21).

---

## ARCHITECTURAL DIFFERENCES (intentional substitutions, not gaps)

| Guide prescribes | Codebase does instead | Assessment |
|---|---|---|
| `ntm` for swarm launch (tmux multiplexer) | CC native `Agent(run_in_background: true)` + SwarmTender | Better — tighter integration, no tmux dependency, auto-monitoring |
| GPT Pro with Extended Reasoning for initial planning | Claude Opus | Expected — GPT not available in CC ecosystem |
| External file-reservation system | Agent Mail reservations (HTTP transport) | Same concept, integrated implementation |
| All agents on `main` branch | Worktree isolation (`isolation: "worktree"`) | Different tradeoff — worktrees prevent direct conflicts but add merge step |
| Manual ntm session management | SwarmTender auto-monitoring + escalation | Better — automated health checks, nudging, kill escalation |
| WezTerm/Zellij/Ghostty multiplexers | CC native agent spawning | Better — platform-independent, no terminal dependency |

---


---

## SUMMARY

| Status | Count |
|---|---|
| **Closed** | 21 |
| **Architectural difference** (intentional) | 6 |
| **Remaining actionable gaps** | 0 |

**Implementation coverage vs guide: 100%**

All 21 gaps identified across the complete flywheel guide have been resolved through code changes, skill updates, or documentation. The 6 architectural differences (ntm->Agent(), GPT->Opus, etc.) are intentional substitutions that improve on the original methodology for the Claude Code ecosystem.
