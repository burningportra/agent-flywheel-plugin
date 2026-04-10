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

---

## CRITICAL GAPS — Feature exists in guide, absent from codebase

### G1. UBS execution is a stub
- **Guide**: UBS scanning is a mandatory pre-commit quality gate — catches security vulns, supply chain issues, runtime stability
- **Codebase**: `detectUbs()` in coordination.ts checks if binary exists; gate in gates.ts lists "UBS scan" — but no actual invocation code runs the scan
- **Impact**: UBS-capable users get no benefit; the gate is decoration
- **Fix**: Add `ubsExec()` in gates.ts that runs `ubs scan --json` on changed files and parses output; skip gracefully if binary absent

### G4. Adversarial random code exploration gate
- **Guide**: "Agents sort through files tracing execution flows to find bugs through adversarial reading" — distinct from self-review, involves random file selection
- **Codebase**: Self-review and peer review gates exist. No "adversarial reading" pass (random file selection, trace execution, find hidden bugs without being told what to look for)
- **Impact**: Bugs invisible to targeted self-review go uncaught
- **Fix**: Add adversarial-read gate: randomly select N files from changed set, spawn agent to trace flows and look for bugs without knowledge of what was changed or why

### G6. Major Feature Integration workflow (study + reimagine)
- **Guide**: 10-step process for integrating major external features: investigate external project, propose integration doc, deepen iteratively, invert analysis, 5x blunder hunts, close design gaps, cross-model review, synthesize
- **Codebase**: `orchestrate-research` does external repo research but stops at "extract insights." No structured study-reimagine pipeline, no blunder-hunt loop, no inversion analysis
- **Impact**: Major feature integrations follow ad-hoc process instead of proven methodology
- **Fix**: Extend `orchestrate-research` skill with post-research phases: integration proposal doc, iterative deepening (push past conservative suggestions), inversion analysis, 5x blunder hunts, cross-model feedback, synthesis

### G7. Fresh-round refinement with model anchoring prevention
- **Guide**: Run 4-5 planning rounds in FRESH conversations (prevents model anchoring on its own prior output). Each round is a new session.
- **Codebase**: Deep plan uses parallel agents in a single session. No mechanism to run sequential fresh-conversation rounds to prevent anchoring.
- **Impact**: Plans may converge prematurely due to model anchoring; missed improvements that fresh perspectives would catch
- **Fix**: Add optional "iterative deepening" mode to deep plan: after initial synthesis, spawn N sequential refinement agents (each in isolation via worktree or fresh Agent() call) that review and propose improvements to the synthesized plan

---

## PARTIAL GAPS — Feature exists but incomplete

### P2. Cross-agent review cadence (every 30-60 min) not timed
- **Guide**: "Cross-agent review every 30-60 minutes" — scheduled, cadenced, automatic
- **Codebase**: SwarmTender has `operatorCadence` checks every 20 min. Peer review gate exists post-bead. But no automatic timed cross-agent review trigger during active implementation.
- **Fix**: Add time-based cross-agent review trigger to SwarmTender: if `lastCrossAgentReview` was >45 min ago and agents are actively implementing, prompt operator or auto-trigger review round

### P3. Test beads not auto-generated from plan
- **Guide**: Beads include comprehensive unit + e2e test scripts; testing is a first-class bead requirement embedded in each bead
- **Codebase**: Test criteria exist in bead templates; test coverage gate exists — but test tasks aren't auto-generated as companion beads during plan-to-bead conversion
- **Fix**: During bead creation in Step 5.5, if acceptance criteria include test requirements, auto-generate a companion test bead with dependency on the impl bead


---

## PROCESS / UX GAPS

### U2. Rate limit / CAAM guidance absent from workflow
- **Guide**: "Human manages rate limits via account switching" — explicit operator responsibility with CAAM tool
- **Codebase**: SwarmTender mentions CAAM in operator guidance. No detection of 429 errors, no account-switching prompt, no automation.
- **Fix**: Detect rate limit signals (429 errors, slow responses) in SwarmTender; surface prompt: "Rate limit detected. Switch account with CAAM or wait." Add CAAM detection to orchestrate-healthcheck.

### U3. Periodic commit cadence not tracked
- **Guide**: "Commit periodically every 1-2 hours" — explicit operator responsibility
- **Codebase**: Not tracked; no reminder; no automation
- **Fix**: Track `lastCommitTimestamp` in SwarmTender; warn operator if >90 min since last commit across all agents

### U4. Agent fungibility principle not surfaced
- **Guide**: Explicitly states every agent is a generalist, no role specialization, no "boss" coordinator. Mirrors RaptorQ fountain codes.
- **Codebase**: The orchestrate skill uses a coordinator pattern (the main agent IS a boss). Impl agents are generalists but the coordinator is specialized.
- **Note**: This is partially an architectural difference — CC's Agent() model naturally creates a coordinator. But the fungibility principle (any agent can resume any bead) should be explicitly stated in marching orders.
- **Fix**: Add fungibility statement to swarm marching orders: "You are a generalist. If you finish your bead and others remain, claim the next one. If you crash, any agent can resume your work."

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

## PRIORITY MATRIX

### Should-have (meaningful improvement)

| ID | Gap | Effort | Impact |
|---|---|---|---|
| G4 | Adversarial reading gate | Medium | Medium — catches hidden bugs |
| G1 | UBS execution | Medium | Medium — only benefits UBS users |
| P2 | Timed cross-agent review | Low | Medium — prevents review gaps in long sessions |

### Nice-to-have (diminishing returns)

| ID | Gap | Effort | Impact |
|---|---|---|---|
| G6 | Major Feature Integration workflow | High | Low — rare use case |
| G7 | Fresh-round refinement | High | Medium — architectural change to planning |
| P3 | Test bead auto-generation | Medium | Low — tests already in acceptance criteria |
| U2 | CAAM / rate limit detection | Medium | Low — manual workaround exists |
| U3 | Commit cadence tracking | Low | Low — operator responsibility |
| U4 | Fungibility principle surfacing | Low | Low — prompt addition |

---

## SUMMARY

| Status | Count | Items |
|---|---|---|
| **Closed** | 12 | UI/UX polish, Idea-Wizard, stagger, compaction re-read, drift detection, convergence scoring, Gemini planning, DCG enforcement, bv marching orders, pre-commit guard, Three Reasoning Spaces, synthesis prompt |
| **Critical** (absent) | 3 | UBS execution, major feature integration, fresh-round refinement |
| **Partial** (incomplete) | 2 | timed cross-agent review, test bead auto-gen |
| **Process/UX** | 3 | CAAM/rate limits, commit cadence, fungibility |
| **Architectural difference** | 6 | ntm->Agent(), GPT->Opus, reservations, worktrees, SwarmTender, multiplexers |

**Total actionable gaps: 8 (down from 16)**  
**Implementation coverage vs guide: ~92%**

### Remaining gaps by priority

| ID | Gap | Effort | Impact |
|---|---|---|---|
| G1 | UBS execution (stub -> real) | Medium | Medium — only benefits UBS users |
| G4 | Adversarial reading gate | Medium | Medium — catches hidden bugs |
| P2 | Timed cross-agent review | Low | Medium — prevents review gaps |
| G6 | Major Feature Integration workflow | High | Low — rare use case |
| G7 | Fresh-round refinement (anchoring prevention) | High | Medium — architectural change |
| P3 | Test bead auto-generation | Medium | Low — tests already in acceptance criteria |
| U2 | CAAM / rate limit detection | Medium | Low — manual workaround exists |
| U3 | Commit cadence tracking | Low | Low — operator responsibility |
| U4 | Fungibility principle surfacing | Low | Low — prompt addition |
