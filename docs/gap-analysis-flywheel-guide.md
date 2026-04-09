# Gap Analysis: Agent Flywheel Guide vs claude-orchestrator

Source: https://agent-flywheel.com/complete-guide  
Generated: 2026-04-08  
Method: Guide inventory (86 items) × codebase inventory (40+ modules)

---

## CRITICAL GAPS — Feature exists in guide, absent from codebase

### 1. UBS execution never runs
- **Guide**: UBS scanning is a mandatory gate — catches security vulns, supply chain issues, runtime stability
- **Codebase**: `detectUbs()` in `coordination.ts` checks if the binary exists; gate in `gates.ts` lists "UBS scan" as a step — but **no invocation code exists**
- **Impact**: The gate is a stub. UBS-capable users get no benefit.
- **Fix**: Add `ubsExec()` call in gates.ts that runs `ubs scan` and parses output; skip gracefully if binary absent (same pattern as CASS)

### 2. UI/UX Polish Phase entirely absent
- **Guide**: Separate named phase: Scrutiny pass (15-30 suggestions) → Human review → Bead conversion → Platform-specific polish (desktop + mobile) → De-slopification
- **Codebase**: Only the de-slopify gate exists. The scrutiny pass, human-curated suggestion pipeline, and platform-specific polish are all absent.
- **Impact**: Projects never get a dedicated UX improvement loop.
- **Fix**: Add `orchestrate-polish.md` command + `orch_polish` MCP tool that runs a scrutiny agent, presents suggestions, converts selected ones to beads

### 3. Convergence scoring for bead polishing
- **Guide**: "When weighted convergence reaches 0.75+, proceed to implementation" — specific metric based on response length, change velocity, content similarity
- **Codebase**: Polish rounds exist (approve_beads `action: "polish"`) but no convergence metric is computed or surfaced
- **Impact**: Users have no signal for when to stop polishing; often under- or over-polish
- **Fix**: After each polish round, compute and display a convergence score (compare bead content diff size, count unchanged beads, show trend)

### 4. Gemini and Grok excluded from planning model pool
- **Guide**: Deep planning calls for Gemini and Grok Heavy as competing perspectives alongside Claude Opus
- **Codebase**: Deep plan uses Opus (correctness), Sonnet (ergonomics), Codex (robustness) — no Gemini, no Grok
- **Impact**: Missing the "fresh perspective" that Gemini especially provides in adversarial planning
- **Note**: GPT Pro is also referenced but unavailable in CC ecosystem — expected gap. Gemini-CLI is available.
- **Fix**: Add Gemini-CLI as optional 4th planner when `gmi` binary detected; update `orchestrate.md` deep plan section

### 5. Random code exploration / adversarial reading gate absent
- **Guide**: "Agents sort through files tracing execution flows to find bugs through adversarial reading" — a distinct gate separate from self-review
- **Codebase**: Self-review gate and peer review gate exist, but no "adversarial reading" pass (random file selection, trace execution, look for hidden bugs)
- **Impact**: Bugs invisible to targeted self-review go uncaught
- **Fix**: Add an adversarial-read gate: randomly select N files, spawn agent to trace flows and look for bugs without being told what to look for

### 6. DCG (Destructive Command Guard) not integrated
- **Guide**: "DCG mechanically blocks dangerous commands" — a hard binary-level enforcer distinct from AGENTS.md rules
- **Codebase**: AGENTS.md lists prohibited commands; `agents-md.ts` scores for rule keywords — but no DCG binary integration; no actual mechanical block
- **Impact**: Agents can still run `git reset --hard` etc. — only social/prompt-level enforcement exists
- **Note**: This may be a CC hook rather than a CLI tool. Check if a pre-tool-call hook can implement this.
- **Fix**: Implement DCG as a Claude Code hook in `hooks/hooks.json` that blocks listed destructive commands

---

## PARTIAL GAPS — Feature partially implemented, missing pieces

### 7. bv prioritization in agent marching orders
- **Guide**: "Each agent... claims work using bv prioritization" — agents use PageRank/HITS scores to pick highest-value beads
- **Codebase**: `bv` is wired and used in drift checks / status reporting; `swarmMarchingOrders()` generates per-agent instructions — but it's **unclear if agents are instructed to run `bv` to pick their next bead**
- **Fix**: Verify marching orders include `bv --json | pick highest unclaimed bead` instruction

### 8. Cross-agent review cadence (every 30-60 min)
- **Guide**: "Cross-agent review every 30-60 minutes" — scheduled, cadenced, not just per-bead
- **Codebase**: Peer review gate exists post-bead. No scheduled/timed cadence in swarm operations.
- **Fix**: Add cadence check to `orchestrate-swarm-status.md` — if last cross-agent review was >45 min ago, prompt operator

### 9. Test bead generation not automated
- **Guide**: Beads include comprehensive unit + e2e test scripts; testing is a first-class bead requirement
- **Codebase**: Test criteria exist in bead templates; test coverage gate exists — but tests aren't auto-generated as sibling beads during plan-to-bead conversion
- **Fix**: During bead creation, if acceptance criteria include "test X", auto-generate a companion test bead

### 10. Pre-commit guard is social not mechanical
- **Guide**: "Pre-commit guard blocks commits to files reserved by other agents" — hard enforcement
- **Codebase**: Agent Mail file reservations are advisory; pre-commit guard referenced in agents-md.ts but not bundled as actual git hook
- **Fix**: Add git pre-commit hook installer to `orchestrate-setup.md` that reads Agent Mail reservation state and blocks commits to reserved files

---

## INTENTIONAL ARCHITECTURAL DIFFERENCES (not gaps, just substitutions)

| Guide prescribes | Codebase does instead | Assessment |
|---|---|---|
| `ntm` for swarm launch (tmux multiplexer) | CC native `Agent(run_in_background: true)` | ✅ Better — tighter integration, no tmux dependency |
| GPT Pro with Extended Reasoning for initial planning | Claude Opus | ✅ Expected — GPT not available in CC ecosystem |
| External file-reservation system | Agent Mail reservations | ✅ Same concept, different implementation |

---

## PROCESS / UX GAPS (not code, but missing from orchestrate skill)

### 11. Three Reasoning Spaces not surfaced to user
- **Guide**: Plan Space / Bead Space / Code Space with explicit rework cost ratios (1x / 5x / 25x)
- **Codebase**: Implemented implicitly but never explained to the user
- **Fix**: Add a one-time framing message in orchestrate Step 5 when user picks deep plan

### 12. Law of Rework Escalation not surfaced
- **Guide**: Core motivating principle — catching mistakes in Plan Space costs 1x vs 25x in Code Space
- **Codebase**: Not surfaced anywhere
- **Fix**: Include in planning mode selection prompt to explain why deep planning investment pays off

### 13. Rate limit / account switching guidance absent
- **Guide**: "Human manages rate limits via account switching" — explicit operator responsibility
- **Codebase**: No guidance, no detection of rate limit hits, no account-switching prompt
- **Fix**: Detect 429 errors in `cli-exec.ts` and surface a user prompt: "Rate limit hit. Switch account or wait N minutes."

### 14. Periodic commit cadence not tracked
- **Guide**: "Commit periodically every 1-2 hours"
- **Codebase**: Not tracked; no reminder; no automation
- **Fix**: Track last commit timestamp in swarm status; warn if >90 min since last commit

---

## SUMMARY

| Gap severity | Count | Items |
|---|---|---|
| **Critical** (absent) | 6 | UBS execution, UI/UX polish phase, convergence scoring, Gemini/Grok planning, adversarial reading gate, DCG hard enforcement |
| **Partial** (exists but incomplete) | 4 | bv prioritization in marching orders, cross-agent review cadence, test bead auto-generation, pre-commit guard mechanization |
| **Process/UX** (workflow missing) | 4 | Three Reasoning Spaces framing, Law of Rework Escalation, rate limit handling, commit cadence tracking |
| **Intentional substitution** | 3 | ntm→Agent(), GPT Pro→Opus, external reservations→Agent Mail |

**Total actionable gaps: 14**  
**Implementation coverage vs guide: ~78%**
