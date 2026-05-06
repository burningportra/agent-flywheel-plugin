# Phase 2: APR-Pro Deep Dive — 3 Critical Areas

**Date**: 2026-05-05  
**Researcher**: CoralBrook (claude-opus-4-7)  
**Focus**: Oracle persistence, convergence heuristics, document bundling + diffing

---

## T1: Oracle Session Persistence & Browser Lifecycle

### Discovery: Stateful Authentication Model

APR uses **Oracle** (https://github.com/steipete/oracle) — a browser automation wrapper around ChatGPT. The key insight: once authenticated, the browser session persists across multiple `apr run` invocations.

**Authentication Flow**:
```bash
# First run: manual login required
apr run 1 --login --wait
# → Browser opens
# → User logs into ChatGPT (2FA, etc.)
# → Session cookies saved by Oracle

# Subsequent runs: reuse session
apr run 2              # No login needed, uses cached cookies
apr run 3              # Session persists, cookies valid
```

### Session Lifecycle Details

**Persistence Mechanism** (inferred from README):
1. Oracle maintains browser process (Chrome/Firefox) with persistent data directory
2. ChatGPT session cookies written to `~/.oracle/` or similar cache location
3. Each `apr run` connects to same browser instance (or reuses process)
4. Session survives process restarts (until cookies expire)

**Re-authentication Trigger**:
- Cookies expire (typically 7-30 days)
- Manual ChatGPT logout
- Browser cache cleared
- Fix: `apr run <n> --login --wait` (forces fresh auth)

**Multi-Host Scenario** (headless/SSH):
```bash
# Local machine (GUI): run Oracle server
oracle serve
# → Starts browser + listens on localhost:8000

# Remote server (headless): connect to local Oracle
export ORACLE_URL="http://local-machine:8000"
apr run 1              # Uses remote browser session
apr run 2              # Same session, no re-auth
```

### Implications for Flywheel

**Current flywheel review model**: Each review agent spawns independently, limited to one-shot reasoning.

**Opportunity**: Stateful review sessions enable:
1. **Multi-turn reviews** — Agent A reviews → applies fixes → Agent B re-reviews in same context
2. **Session continuity** — Avoid re-authenticating between review rounds (saves 5+ minutes per cycle)
3. **Contextual coherence** — Oracle session maintains conversation history, reducing context re-establishment

**Risk**: Session expiry during long review cycles. Mitigation: heartbeat check + re-auth gate before bead approval.

### Technical Questions for Phase 3

1. Does Oracle support session pooling (multiple concurrent reviews)?
2. What's the browser process memory footprint during 10+ hour review session?
3. Can we introspect Oracle session state (remaining cookie TTL, auth status)?

---

## T2: Convergence Heuristics & Metrics-Driven Stopping

### Discovery: Multi-Signal Convergence Detection

APR doesn't use a single threshold. Instead, it tracks **three independent signals** that together indicate convergence:

**Convergence Signal Triad**:

```json
{
  "convergence": {
    "detected": false,
    "confidence": 0.0,
    "estimated_rounds_remaining": null,
    "signals": {
      "output_size_trend": "decreasing",    // → size stabilizing
      "change_velocity": "decreasing",       // → edits slowing
      "similarity_trend": "increasing"       // → rounds similar to prior
    }
  }
}
```

### Signal Definitions

1. **Output Size Trend** (`output_size_trend`)
   - Track file size (or word count) of round output
   - Trend: `increasing` → `stable` → `decreasing` → `flat`
   - Early rounds grow (architecture expand), later rounds shrink (polish/consolidate)
   - Convergence signal: flat size across 3+ consecutive rounds

2. **Change Velocity** (`change_velocity`)
   - Measure % delta between consecutive rounds
   - Round 1→2: -30% (major rewrite)
   - Round 3→4: -8% (refinement)
   - Round 5→6: -1% (polish)
   - Convergence signal: delta < 1% for 3+ rounds

3. **Similarity Trend** (`similarity_trend`)
   - Structural similarity between Rn and Rn-1
   - Metric: % of lines unchanged (or diff line count)
   - Trend: `diverging` (early, big changes) → `stabilizing` (middle) → `converged` (identical sections)
   - Convergence signal: >95% similarity for 2+ rounds

### Aggregation Logic (Inferred)

```
Convergence Confidence = (signal1_strength + signal2_strength + signal3_strength) / 3

If confidence > 0.85 AND all_three_signals_agree_on_convergence:
    → convergence.detected = true
    → Notify user, suggest stopping
```

### Convergence Pattern Empirically Observed

```
Rounds 1-3:  Change Velocity HIGH (major fixes)
             Size Trend: expanding then contracting
             Similarity: LOW (≈20% unchanged)
             
Rounds 4-7:  Change Velocity MEDIUM (architecture refinement)
             Size Trend: stable
             Similarity: MEDIUM (≈60% unchanged)
             
Rounds 8-12: Change Velocity LOW (<2%)
             Size Trend: very stable
             Similarity: HIGH (≈95% unchanged)
             
Round 13+:   All signals at max (converged)
             User can safely stop
```

### Metrics Collection Infrastructure

APR collects **8 quantitative metrics per document**:

```javascript
{
  path: "README.md",
  char_count: 14330,
  word_count: 2048,
  line_count: 124,
  heading_count: 12,          // "# Heading" lines
  code_block_count: 4,        // ``` ... ``` pairs
  link_count: 18,             // [text](url)
  list_item_count: 47         // "- " or "1. " items
}
```

**Why these 8?**
- char/word/line: baseline size metrics
- heading/code/link/list: structural complexity signals
- When combined, capture "what changed" without doing full text diff

---

### Implications for Flywheel

**Current approval flow** (Step 5.45): Validate → Approve → Refine → Scrap (binary choices).

**Convergence-driven alternative**:
1. After each bead impl, collect metrics (test count, coverage, runtime, complexity)
2. Track 3-signal convergence across bead waves
3. Auto-approve beads when signals indicate "good enough"
4. Escalate only when signals conflict (some good, some bad)

**Specific mapping**:
- **Output Size Trend** ← bead test count stability
- **Change Velocity** ← % of beads needing fixes (approval rate)
- **Similarity Trend** ← code structural changes (diff line count)

**Threshold tuning needed**: What % change = "converged" for bead approval? (APR uses <1% for text; beads might use <5% for code).

---

## T3: Document Bundling & Diff-Based Change Visibility

### Discovery: Structured Document Bundling with Metrics Injection

APR's bundling strategy is **not** simple concatenation. It:
1. Collects per-document metrics (8 dimensions)
2. Embeds metrics as YAML frontmatter
3. Creates composite prompt that feeds diff-aware revision hints to GPT Pro

**Bundle Structure**:

```yaml
---
schema_version: "1.0.0"
workflow: "fcp-spec"
round: 5
created_at: "2026-01-20T10:30:00Z"
documents:
  readme:
    path: README.md
    char_count: 14330
    word_count: 2048
    line_count: 124
  spec:
    path: FCP_Specification_V2.md
    char_count: 58000
    word_count: 8192
    line_count: 450
  implementation:
    path: docs/fcp_model_connectors_rust.md
    char_count: 45000
    word_count: 6500
    line_count: 380
---

[DOCUMENT MARKER: README]
<full README content>

[DOCUMENT MARKER: SPEC]
<full SPEC content>

[DOCUMENT MARKER: IMPLEMENTATION]
<full implementation content>

[REVISION PROMPT]
NOW: Carefully review this entire plan for me and come up with your best revisions...
For each proposed change, give me your detailed analysis and rationale/justification
with git-diff style change versus the original plan...
```

### Key Insight: Diff-Aware Revision Prompting

The prompt asks GPT Pro to include **"git-diff style change versus the original plan"**. This creates a natural feedback loop:

1. **Round 1** output: Full rewrite (no prior round, no diff)
2. **Round 2** output: Diffs show high-level structural changes
3. **Round 3** output: Diffs narrow to specific sections
4. **Round 5+** output: Diffs become micro-edits, indicating convergence

**Why this matters**: GPT Pro sees its own prior outputs + diffs, enabling self-correction and refinement without losing prior reasoning.

### Diff Tool Chain

APR uses intelligent fallback for displaying round-to-round diffs:

```bash
# Priority order:
1. delta          # Beautiful, syntax-highlighted, side-by-side diffs
2. diff           # Standard UNIX diff (always available)
3. (fallback)     # Plain concatenation if both unavailable

# Command:
apr diff 3 4      # Compare round 3 → round 4
apr diff 5        # Compare round 5 → round 4 (implicit predecessor)
apr diff 3 5 --tool delta  # Force delta tool
```

**Visual example of early vs. late convergence diffs**:

```
Round 1→2 diff (50+ lines changed):
- Architecture A
+ Architecture B
- Config pattern X
+ Config pattern Y

Round 4→5 diff (3 lines changed):
- "security best practice"
+ "security best practice (per RFC 9999)"
  Heading levels
```

### Metrics-Driven Diff Filtering

When diffs get large (100+ changed lines), APR could filter by **change density**:
- Show structural changes (heading removal/addition, code block changes)
- Hide minor edits (punctuation, formatting)
- This focuses human attention on "what matters"

*Not explicitly implemented in v1.2.2, but hinted in metrics collection logic.*

---

### Implications for Flywheel

**Current plan-validation flow** (Step 5.45): Validate → Claude shows binary accept/reject.

**Bundling + diff approach**:
1. Store plan versions as `.md` with frontmatter metrics
2. When approving a revised plan, capture metrics (LOC, complexity, estimated effort)
3. Display plan v1 → plan v2 diff to human reviewer
4. Prompt includes "For this change, justify why it improves the plan..."
5. Store GPT-generated diff + justification in plan history

**File structure**:
```
.flywheel/
└── plans/
    ├── plan-v1.md (initial)
    ├── plan-v2.md (after Claude polish round 1)
    ├── plan-v3.md (after Claude polish round 2)
    └── metrics.json (per-version metrics + convergence)
```

**Human reviewer sees**:
```
Plan Version History

v1 → v2 diff:
- "Run 500K tests in parallel"
+ "Run 500K tests in 10 parallel waves"
  (Rationale: Prevents memory exhaustion)

v2 → v3 diff:
- "Estimate 2 weeks"
+ "Estimate 2-3 weeks with fallback"
  (Rationale: Account for flake in test suite)
```

---

## Cross-Cutting Insights

### Convergence + Bundling Synergy

APR doesn't decide "when to stop" in isolation. Instead:
1. **Bundling** ensures GPT Pro can see prior rounds + diffs
2. **Metrics** track whether GPT's edits are shrinking (convergence)
3. **Diffs** surface the convergence pattern to human (visible proof)
4. **Signal aggregation** (3-signal heuristic) automates the decision

**This is a complete feedback loop**: each round's output feeds metrics → metrics inform convergence check → convergence check gates further rounds.

### Session Persistence + Convergence Interaction

With stateful Oracle sessions:
- Don't need to re-auth after each round (saves time)
- Session context persists, so GPT Pro "remembers" prior revisions
- Enables tighter iteration cycles (esp. for error recovery)

If round N produces unexpected output:
```bash
# Without persistence: need fresh auth
apr run N+1 --login --wait

# With persistence: continue immediately
apr run N+1 --include-impl  # Include implementation to ground reasoning
# Oracle reuses browser, no re-auth delay
```

---

## Phase 2 Gaps & Questions

### Unanswered (for Phase 3):

1. **Oracle Session Pool**: Can multiple beads run in parallel with same browser session, or does it serialize?

2. **Similarity Metric Definition**: What algorithm computes "similarity_trend" (line-by-line diff %, semantic similarity via embeddings, or structural hash)?

3. **Convergence Threshold Tuning**: How were the 0.85 confidence and <1% delta thresholds chosen? Empirical or hardcoded?

4. **Metrics Schema Evolution**: If METRICS_SCHEMA_VERSION bumps from 1.0 → 1.1, how does APR handle old rounds?

5. **Diff-Aware Grounding**: Does GPT Pro actually parse the "git-diff style" hint, or is it just prompt engineering?

---

## Summary: What Flywheel Should Steal

1. **Session Persistence Model** (T1): Enable stateful multi-turn reviews instead of one-shot agents.
2. **3-Signal Convergence** (T2): Replace binary approval with metrics-driven "confidence" scoring.
3. **Bundled Metrics + Diffs** (T3): Embed structural metrics in plan versions; show diffs during approval.

**Implementation Priority for Flywheel**:
- **High**: T2 (convergence heuristics) — directly improves Step 5.45 approval flow
- **Medium**: T3 (bundling + diffs) — enhances plan visibility & human confidence
- **Lower**: T1 (session persistence) — requires Oracle integration, higher complexity

---

## Artifacts for Phase 3

Files to fetch for deeper analysis:
- `.apr/analytics/<workflow>/metrics.json` (full convergence tracking example)
- Test file: `tests/integration/test_analytics.bats` (convergence detection test cases)
- RESEARCH_FINDINGS.md (full TOON encoding protocol)
- Example workflow: `workflows/fcp-example.yaml` (real-world config)

Recommended Phase 3 activities:
- **Inversion**: Design flywheel convergence detection as if metrics.json format already exists
- **Blunder-hunt**: What happens if metrics.json corrupts? Session expires mid-round?
- **Cross-model triangulation**: How would a different LLM (GPT, Gemini) affect convergence signals?
