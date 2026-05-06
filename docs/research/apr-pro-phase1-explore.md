# Phase 1: APR-Pro Architecture Exploration

**Date**: 2026-05-05  
**Researcher**: CoralBrook (claude-opus-4-7)  
**Project**: Automated Plan Reviser Pro (apr) v1.2.2

---

## Overview

APR-Pro is a bash-based CLI tool (~6,900 lines) that automates iterative specification refinement by feeding documents (README, spec, implementation) through GPT Pro Extended Reasoning via Oracle browser automation. It executes multiple revision rounds, tracks convergence metrics, and provides both human (TUI) and robot (JSON API) interfaces.

**Core value proposition**: Treat specification refinement like numerical optimization — each round builds on prior fixes, converging toward production-ready architecture without manual copy-paste tedium.

---

## Entry Points & Commands

### Primary Entry: `apr` (main script)

**Bash executable** (~6,900 lines) located at repository root. Self-contained, no external dependencies beyond Oracle, gum (TUI), and standard Unix tools.

### Human-Facing Commands
- `apr setup` — Interactive wizard to configure workflow (select documents, model preferences)
- `apr run <round>` — Execute revision round (e.g., `apr run 5`)
- `apr status` — Check Oracle session & workflow status
- `apr attach <session>` — Reattach to running/completed session
- `apr list` — List all configured workflows
- `apr history` — Show revision history for current workflow
- `apr dashboard` — TUI analytics dashboard
- `apr backfill` — Generate metrics from existing rounds

### Robot Mode API
```bash
apr robot init              # Initialize .apr structure
apr robot status            # System overview (JSON)
apr robot workflows         # List workflows (JSON)
apr robot validate          # Pre-run validation
apr robot run <round>       # Execute round, return JSON
apr robot show <round>      # View round content
apr robot diff <r1> <r2>    # Compare rounds
apr robot integrate         # Get Claude integration prompt
apr robot history           # Revision history
apr robot stats             # Analytics metrics
apr robot help              # API documentation
```

---

## Dataflow Architecture

### Round Execution Lifecycle

```
┌──────────────────────────────────────────────────────────────────────┐
│ 1. VALIDATE & PREPARE                                                │
│    ├── Load workflow config (.apr/workflows/<name>.yaml)             │
│    ├── Verify documents exist (readme, spec, optional impl)          │
│    ├── Collect metrics (line count, word count, character count)     │
│    └── Bundle documents into single prompt (with line-count markers) │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ 2. SEND TO GPT PRO (via Oracle)                                      │
│    ├── Oracle authenticates → ChatGPT session (browser automation)   │
│    ├── Paste bundled document + revision prompt                      │
│    ├── Monitor output stability (min 30s stable, 12 poll cycles)     │
│    └── Wait 10-60 min for Extended Thinking to complete             │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ 3. CAPTURE & PERSIST                                                 │
│    ├── Download GPT Pro response                                     │
│    ├── Save to .apr/rounds/<workflow>/round_N.md                     │
│    ├── Extract metrics (lines, changes, complexity)                  │
│    ├── Update analytics/metrics.json                                 │
│    └── Git commit round output                                       │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ 4. CONVERGENCE CHECK                                                 │
│    ├── Compare metrics across rounds                                 │
│    ├── Calculate delta (% change in key metrics)                     │
│    ├── Signal convergence if delta < threshold for N consecutive     │
│    └── Dashboard visualization of convergence trend                  │
└──────────────────────────────────────────────────────────────────────┘
```

### Document Bundling

**Bundler Logic** (implicit in main apr script):
1. Read three documents: README, SPEC, IMPLEMENTATION (opt)
2. Collect metrics per-document (word count, line count, char count, file size)
3. Create composite prompt with structure:
   ```
   [DOCUMENT MARKER: README]
   <readme content>
   
   [DOCUMENT MARKER: SPEC]
   <spec content>
   
   [DOCUMENT MARKER: IMPLEMENTATION]
   <impl content>
   
   [REVISION PROMPT]
   NOW: Carefully review this entire plan for me...
   ```
4. Bundle size tracked → metrics used for convergence detection

### Session & State Management

**Configuration Storage** (`.apr/` directory):
```
.apr/
├── config.yaml                    # Workflow list + global settings
├── workflows/
│   ├── <workflow-name>.yaml       # Individual workflow config
│   └── ...
├── analytics/
│   └── <workflow-name>/
│       └── metrics.json           # Round metrics, convergence data
├── rounds/
│   └── <workflow-name>/
│       ├── round_1.md
│       ├── round_2.md
│       └── ...
└── .sessions                      # Active session PID tracking (Oracle)
```

**Session Lifecycle**:
1. `apr run <round>` → spawn background process (unless `--wait` specified)
2. PID tracked in `.sessions` file
3. Oracle session persists across rounds (same browser, same ChatGPT session)
4. User can `apr attach <session>` to monitor running/completed round
5. Desktop notifications on completion (macOS/Linux)

---

## Key Abstractions & Data Structures

### Workflow Definition (YAML)

```yaml
name: fcp-spec
description: Flywheel Connector Protocol specification
readme: README.md
spec: FCP_Specification_V2.md
implementation: docs/fcp_model_connectors_rust.md
model: gpt-5.2-pro
```

### Metrics JSON Schema

```json
{
  "round": 1,
  "workflow": "fcp-spec",
  "timestamp": "2026-01-20T10:30:00Z",
  "documents": {
    "readme": {
      "lines": 124,
      "words": 2048,
      "characters": 14330,
      "size_bytes": 14330
    },
    "spec": {
      "lines": 450,
      "words": 8192,
      "characters": 58000,
      "size_bytes": 58000
    },
    "implementation": {
      "lines": 380,
      "words": 6500,
      "characters": 45000,
      "size_bytes": 45000
    },
    "output": {
      "lines": 320,
      "words": 5800,
      "characters": 40000,
      "size_bytes": 40000
    }
  },
  "convergence": {
    "delta_lines": -130,
    "delta_words": -2392,
    "delta_characters": -18000,
    "status": "converging"
  }
}
```

### Robot Mode Response Envelope

```json
{
  "ok": true,
  "code": "ok",
  "data": { /* command-specific payload */ },
  "hint": "Optional debug hint",
  "meta": {
    "v": "1.2.2",
    "ts": "2026-05-05T23:42:00Z"
  }
}
```

**Error codes** (semantic, non-contiguous for future expansion):
- `"ok"` (exit 0) — Success
- `"config_error"` (exit 4) — Config validation failed
- `"usage_error"` (exit 2) — Invalid command/args
- `"oracle_timeout"` (exit 8) — Browser automation timeout
- `"auth_required"` (exit 16) — ChatGPT login needed
- `"validation_failed"` (exit 12) — Pre-flight checks failed

---

## Testing Approach

### Framework: BATS (Bash Automated Testing System)

**Test Structure**:
```
tests/
├── unit/
│   ├── test_config.bats         # Config loading, validation
│   ├── test_robot.bats          # Robot mode JSON output
│   ├── test_exit_codes.bats     # Semantic exit codes
│   ├── test_lock.bats           # Session locking (PID mgmt)
│   ├── test_utils.bats          # Helper functions
│   └── ...
├── integration/
│   ├── test_setup.bats          # Full setup → first round flow
│   ├── test_run.bats            # Round execution
│   ├── test_robot.bats          # Robot mode end-to-end
│   ├── test_analytics.bats      # Metrics collection & convergence
│   └── ...
├── e2e/
│   └── test_full_workflow.bats  # Complete workflow (slow, Oracle required)
├── fixtures/
│   ├── configs/
│   │   ├── simple.yaml
│   │   └── with_template.yaml
│   └── documents/
│       ├── sample_readme.md
│       ├── sample_spec.md
│       ├── valid_impl.md
│       └── binary_file (invalid)
├── helpers/
│   ├── assertions.bash          # Custom assertions
│   ├── logging.bash             # Test logging
│   └── test_helper.bash         # Setup/teardown utils
└── run_tests.sh                 # Test runner
```

### Custom Assertions

```bash
assert_file_exists ".apr/config.yaml"
assert_exit_code 0
assert_valid_json "$output"
assert_json_value "$output" ".code" "ok"
capture_streams "$APR_SCRIPT" robot status
```

### CI/CD Integration

GitHub Actions workflows:
- **ci.yml** — Run unit + integration tests on PR
- **auto-checksum.yml** — Auto-update checksums on release
- **release.yml** — Build + sign releases

---

## Notable Implementation Techniques

### 1. **Graceful Degradation Stack**

```bash
# TUI framework: gum → ANSI colors → plain text
if command -v gum &>/dev/null; then
    use_gum=1
else
    use_gum=0  # Fallback to ANSI escape codes
fi

# Oracle integration: global → npx → error
if command -v oracle &>/dev/null; then
    oracle_method="global"
else
    oracle_method="npx"  # npm install -g @steipete/oracle
fi
```

**Why it matters for flywheel**: Allows robot mode to run in CI (no TUI) while preserving human experience locally.

### 2. **Oracle Stability Polling**

```bash
# Prevent truncation with GPT Pro Extended Thinking
# Wait until output is "stable" (unchanged for N polling cycles)

APR_ORACLE_MIN_STABLE_MS=30000      # 30s minimum stable
APR_ORACLE_SETTLE_WINDOW_MS=30000   # 30s settle period
APR_ORACLE_STABLE_CYCLES=12         # 12 stable polls required

# Pseudo-code:
while [[ $polled_cycles -lt 12 ]]; do
    current_output=$(fetch_oracle_output)
    if output_unchanged_for_30s; then
        ((polled_cycles++))
    else
        polled_cycles=0  # Reset on change
    fi
    sleep 5
done
```

**Why it matters**: GPT Pro Extended Thinking can take 10-60 minutes; stability detection prevents premature capture.

### 3. **Session PID Tracking & Reattachment**

```bash
# Background execution with reattachment capability
apr run 5 &          # Spawn background
bg_pid=$!
echo "$bg_pid" > .apr/.sessions/round-5.pid

# Later, check status:
apr status           # Queries running processes by PID
apr attach apr-round-5  # Reattach to monitor
```

**Why it matters**: Long-running reviews (60+ min) need monitoring without blocking the terminal.

### 4. **Document Metrics for Convergence Detection**

```bash
# Round 1-3: large deltas (major fixes)
# Round 4-7: smaller deltas (refinements)
# Round 8+: <1% delta (converged)

collect_metrics() {
    local doc="$1" type="$2"
    jq -nc \
        --arg lines "$(wc -l < "$doc")" \
        --arg words "$(wc -w < "$doc")" \
        --arg chars "$(wc -c < "$doc")" \
        '{ lines: $lines | tonumber, words: $words | tonumber, chars: $chars | tonumber }'
}

# Convergence signal:
delta_percent=$(( (prev_lines - curr_lines) * 100 / prev_lines ))
if [[ $delta_percent -lt 1 ]]; then
    # Converged: stop round sequence
fi
```

**Why it matters**: Automates the "when to stop iterating" decision without manual inspection.

### 5. **Robot Mode JSON API with Structured Error Codes**

```bash
# Enables agent automation (no string parsing needed)
# All commands return: { ok, code, data, hint, meta }
# Exit codes semantic (not just 0/1): 0, 2, 4, 8, 12, 16

apr robot run 5 --json  # Always JSON (no TUI color codes)
```

**Why it matters for flywheel**: Agents can parse `.code` field to decide on retry logic without heuristic stderr parsing.

### 6. **Workflow-First Architecture**

Each workflow is self-contained:
- Separate YAML config
- Dedicated metrics.json
- Separate rounds/ directory
- Isolated session state

Allows multiple simultaneous workflows without interference (unlike single-workflow tools).

---

## Tangents Worth Deepening

### T1: Oracle Browser Automation API

**Depth question**: How does Oracle handle ChatGPT authentication persistence across `apr run` invocations? Is the browser session truly shared, or does each round spawn a new browser?

**Why relevant**: Agent-flywheel might benefit from stateful browser sessions for multi-step review flows (e.g., review → agent applies fix → review again in same session).

**File to inspect**: RESEARCH_FINDINGS.md mentions Oracle serve mode for headless environments; the handshake protocol could inform how flywheel coordinates multi-agent reviews.

### T2: Convergence Heuristics

**Depth question**: The README describes a "convergence pattern" (rounds 1-3 major, 4-7 refinement, 8+ polish). Is this hardcoded or does apr infer it from metrics delta?

**Why relevant**: Flywheel's bead approval flow (validate/approve/polish cycle) resembles this pattern. Understanding the heuristics could guide how we weight early-stage vs. polish-stage feedback.

**File to inspect**: analytics/ directory in `.apr/rounds/` — likely contains convergence detection logic.

### T3: Document Bundling & Prompt Engineering

**Depth question**: The bundler adds "git-diff style change" sections to the revision prompt. How are those diffs generated? Are they automated or does apr infer structural changes from document deltas?

**Why relevant**: Flywheel's plan-revision cycle (Step 5.45) needs to show Claude what changed between plan v1 and code implementation. APR's approach might be a pattern to adopt.

**File to inspect**: The revision prompt template in apr script (lines ~1279-1298 in README); search for "git-diff" logic.

### T4: TUI Integration with Robot Mode

**Depth question**: How does apr's TUI (gum-based dashboard) stay in sync with background round execution? Is there a shared state file, or does it query `.sessions` + metrics.json?

**Why relevant**: Flywheel's Step 5.45 menu presents validate/approve/refine/scrap options. If a round is running in the background, how should the UI respond? APR's session monitoring model could be instructive.

### T5: TOON Encoding for Structured Output

**Depth question**: APR implements TOON (trusted output) encoding in robot mode (`robot_json_to_toon()`). What's the TOON protocol, and does it provide benefits over plain JSON for agent-to-agent communication?

**Why relevant**: If agent-mail or ntm use TOON for structured messaging, integrating APR's TOON support could reduce parsing errors.

---

## Architectural Patterns Applicable to Flywheel

| Pattern | APR Usage | Flywheel Analog |
|---------|-----------|-----------------|
| **Session persistence** | Oracle browser auth persists across rounds | Flywheel bead state persists across review waves |
| **Metrics-driven convergence** | Document deltas signal when to stop iterating | Approval convergence score signals when plan is ready |
| **Multi-workflow isolation** | Separate YAML configs, separate metrics.json | Separate bead graphs, separate agent lanes |
| **Robot JSON API** | Enables agent automation without TUI | `flywheel_plan`, `flywheel_review` emit structured JSON |
| **Graceful degradation** | gum → ANSI → plain; Oracle global → npx | Codex → Opus fallback; gpg-agent → plaintext fallback |
| **PID-tracked background execution** | `apr run 5 &` with reattachment | Bead implementation running in tmux pane; can detach/reattach |
| **Semantic exit codes** | 0, 2, 4, 8, 12, 16 for different errors | Flywheel already uses semantic exit codes per bead status |

---

## Summary

APR-Pro is a mature, single-purpose tool (iterative spec refinement) with strong separation of concerns:

1. **Document bundling** — predictable structure, enables metrics collection
2. **Oracle integration** — stateful browser automation with stability polling
3. **Metrics + convergence** — data-driven stopping criterion
4. **Robot mode** — JSON API for agent automation
5. **Workflow isolation** — multi-project support without cross-contamination

**Most relevant to flywheel**: The combination of structured metrics + convergence detection + stateful session management. Flywheel's plan-revision loop could adopt APR's metrics-driven heuristics to decide when a plan is "ready" for beads.

---

## Research Artifacts

- APR GitHub: https://github.com/Dicklesworthstone/automated_plan_reviser_pro
- APR script: ~6,900 lines (entry point)
- RESEARCH_FINDINGS.md: TOON integration, robot mode commands
- Test fixtures: 12+ unit/integration/e2e test suites (BATS framework)

**Next phases** should drill into Oracle protocol (T1), convergence heuristics (T2), and how TOON encoding might inform flywheel's structured messaging.
