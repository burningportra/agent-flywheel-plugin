# Beads-Compliance Integration into the Agent-Flywheel — Design Spec

**Status:** Draft (brainstormed 2026-05-08)
**Authors:** session-author
**Target:** agent-flywheel v3.14.0 (next minor release)
**Source skill:** `~/.claude/skills/beads-compliance-and-completion-verification/SKILL.md`
**Decision-shaping doc:** This file. Implementation plan to follow via `/superpowers:writing-plans`.

## 1. Problem

The flywheel's existing wave-completion gate (`flywheel_verify_beads`) checks that closed beads have **status attestation** (the bead is closed in `br` and a matching commit exists, optionally with a `.pi-flywheel/completion/<id>.json` evidence file). It does NOT check whether the bead's **acceptance criteria were actually met**.

False-closed beads — where status flipped to `closed` but the work was incomplete — currently slip through to wrap-up undetected. They re-surface days later as "wait, this never shipped" bugs. The standalone `/beads-compliance-and-completion-verification` skill audits closed beads against their literal acceptance criteria using real test runs, evidence packs, and an 8-dimensional rubric (0–1000 scale), but it lives outside the flywheel and runs only on demand.

This integration makes compliance verification the new wave-completion default.

## 2. Decisions (locked during brainstorming)

| Question | Decision |
|---|---|
| Where to integrate first? | **Step 9 wave-completion gate**, before Step 9.5 wrap-up |
| What happens on failure? | **Hard block + reopen failed beads.** Auto-run `br update --status open`, attach scorecard via `br comment`, present failure menu |
| Default-on or opt-in? | **Default-on, single-bead parallel mode** (~5–10 min for a wave of 5). Skip option always available in the failure menu |
| How is it wired? | **New MCP tool `flywheel_compliance_audit`.** Wraps the standalone skill behind a structured contract. Existing `flywheel_verify_beads` is unchanged |
| Telemetry? | **Yes** (B1) — bump `compliance_false_closed` counter on every failure. Surfaces in welcome-banner trends |
| Score persistence? | **Yes** (B2) — persist per-bead scores as CASS `compliance_score` records so future "low-score-N-sessions-in-a-row" signals are queryable |
| Skill changes? | **Yes** — add `--mode flywheel-gate` shorthand (C1) and tighten JSON output contract via new `passes/<UTC>/result.json` (C2) |

## 3. Architecture

Two repos cooperate over a single MCP tool boundary.

```
┌─────────────────────────────── agent-flywheel repo ────────────────────────────┐
│                                                                                │
│  skills/start/_review.md  Step 9 ──┐                                           │
│                                    ▼                                           │
│  mcp-server/src/tools/compliance-audit.ts ◄── new tool                         │
│   • exec: spawn skill via execa subprocess                                     │
│   • parse: structured JSON contract (C2)                                       │
│   • side effects: br update --status open, br comment, telemetry bump          │
│                                    │                                           │
│  mcp-server/src/telemetry.ts ──────┤  bumps compliance_false_closed_total (B1) │
│  flywheel_memory(operation:store) ─┘  per-bead score persistence (B2)          │
└────────────────────────────────────┬───────────────────────────────────────────┘
                                     │  spawn
                                     ▼
┌──────────── ~/.claude/skills/beads-compliance-and-completion-verification ─────┐
│                                                                                │
│  SKILL.md  ◄── add `--mode flywheel-gate` shorthand (C1)                       │
│  output/   ◄── emit structured passed/failed/scores JSON (C2)                  │
└────────────────────────────────────────────────────────────────────────────────┘
```

The MCP tool is the only contract between repos. Everything flywheel-side imports from `compliance-audit.ts`. Everything skill-side reads from CLI args and writes `passes/<UTC>/result.json`.

## 4. Components

### 4.1 New MCP tool — `flywheel_compliance_audit`

**Location:** `mcp-server/src/tools/compliance-audit.ts`
**Registered in:** `mcp-server/src/server.ts` alongside other `flywheel_*` tools.

**Input schema** (Zod, mirrors `verify-beads.ts` style):
```ts
{
  cwd: string,
  beadIds: string[],                          // wave to audit, length >= 1
  mode?: "single-bead" | "standard",          // default "single-bead"
  threshold?: number,                          // default 700, range 0-1000
  parallelism?: number,                        // default 5, max 5 (skill cap)
  skipEnv?: string,                            // optional FW_COMPLIANCE_OVERRIDE bead-id list
}
```

**Output schema:**
```ts
{
  status: "ok" | "skipped" | "error",
  passed: Array<{ beadId: string; score: number; reportPath: string }>,
  failed: Array<{
    beadId: string;
    score: number;
    reportPath: string;
    reasons: string[];                         // top 3 rubric dimensions that failed
  }>,
  passUtc: string,                             // <project>/beads_compliance_audit/passes/<UTC>
  errors: Record<string, string>,              // beadId → error msg if audit itself failed
  durationMs: number,
}
```

**Side effects** (in execution order):
1. Spawn the standalone skill as a subprocess via `execa` (matches existing tools' pattern in `mcp-server/src/exec.ts`). Command: `claude --skill beads-compliance-and-completion-verification -- --mode flywheel-gate --beads <ids> --threshold <n> --parallelism <p>`. Cwd of the spawn is the target project. Stdout/stderr captured for diagnostics; the contract is the JSON file the skill writes, not its console output.
2. After the spawn exits, parse `<project>/beads_compliance_audit/passes/<UTC>/result.json`. Locate the latest `passes/*/` dir by mtime if multiple exist (skill is idempotent across passes).
3. For each `failed[]`: `br update <id> --status open` + `br comment <id> "Compliance audit reopened — score <N>/1000. See <reportPath>"`.
4. Bump telemetry: call the internal `bumpErrorCount(cwd, "compliance_false_closed", failed.length)` helper from `mcp-server/src/telemetry.ts` directly (not via MCP). Schema is the existing `error-counts.json`; no new file format.
5. For every result (passed AND failed): persist score via the internal `storeComplianceScore` helper in `mcp-server/src/cass-helpers.ts` (NEW file — see 4.5). This writes a CASS `compliance_score` record directly and avoids reentering MCP from inside the compliance-audit MCP tool.

### 4.2 Standalone skill changes (C1 + C2)

**`~/.claude/skills/beads-compliance-and-completion-verification/SKILL.md`** — add:
- `--mode flywheel-gate` documented as shorthand for `--mode single-bead --parallelism 5 --remediation report-only --threshold 700`. Note `remediation=report-only` because the MCP tool owns the reopens, not the skill (avoids double-reopen).
- New section "Structured output for programmatic callers" referencing the JSON schema in 4.2.1.

**`~/.claude/skills/beads-compliance-and-completion-verification/subagents/scorer.md`** — extend to write `passes/<UTC>/result.json` alongside the existing markdown artifacts. The data is identical to REPORT.md, just persisted as JSON for the MCP tool to consume without scraping markdown.

#### 4.2.1 result.json schema

```json
{
  "schema_version": 1,
  "pass_utc": "2026-05-08T19:14:22Z",
  "mode": "flywheel-gate",
  "threshold": 700,
  "beads": [
    {
      "id": "agent-flywheel-XXX",
      "score": 850,
      "passed": true,
      "scorecard_path": "beads/agent-flywheel-XXX/scorecard.md",
      "rubric_breakdown": {
        "impl_completeness": "260/300",
        "tests_meaningful": "230/250",
        "anti_theater": "150/150",
        "test_depth": "120/150",
        "docs_telemetry_migrations": "70/100",
        "cross_bead_integration": "20/50"
      }
    },
    {
      "id": "agent-flywheel-YYY",
      "score": 420,
      "passed": false,
      "scorecard_path": "beads/agent-flywheel-YYY/scorecard.md",
      "top_failures": [
        "impl_completeness:120/300",
        "test_depth:60/150",
        "anti_theater:30/150"
      ]
    }
  ],
  "session_id": "<flywheel-session-id from FW_SESSION_ID env, optional>"
}
```

### 4.3 Flywheel `_review.md` Step 9 changes

Existing flow:
```
verify_beads → result menu (Looks good / Self review / Manual closure)
```

New flow:
```
verify_beads → compliance_audit → result menu
                                      ├── all passed? → existing menu
                                      └── any failed? → new failure menu
```

**New failure menu** (replaces existing menu when `failed.length > 0`):
```
AskUserQuestion({
  question: "Compliance audit found <N> false-closed bead(s). What now?",
  header: "Compliance",
  options: [
    { label: "Re-implement failed (Recommended)", description: "Reopened beads <ids> — route back to Step 7 with these as the new wave" },
    { label: "Show evidence", description: "Open <passUtc>/REPORT.md, then re-show this menu" },
    { label: "Override + proceed", description: "Stamp `Compliance-Override: <ids>` in wrap-up commit trailer. Beads stay reopened but session continues" },
    { label: "Skip and continue (advisory)", description: "Treat the audit as advisory, ignore the reopens, proceed to wrap-up. Logged but not gated" }
  ],
  multiSelect: false
})
```

### 4.4 Telemetry (B1)

`mcp-server/src/telemetry.ts` already supports arbitrary error codes. No schema changes needed — bump `compliance_false_closed` from the new tool. Welcome-banner "Error-code trends" surfaces it automatically.

### 4.5 CASS persistence (B2)

The compliance-audit tool persists one `compliance_score` record per audited bead. The v1 contract is intentionally narrow: the tool only needs a write helper for the score records it emits during Step 9, and it must not call `flywheel_memory` over MCP from inside another MCP tool.

**`mcp-server/src/cass-helpers.ts` (NEW file):** exports the v1 score persistence helper used by `mcp-server/src/tools/compliance-audit.ts`:

```ts
export interface ComplianceScoreRecord {
  beadId: string;
  score: number;
  threshold: number;
  passed: boolean;
  rubric: Record<string, string>;
  passUtc: string;
  sessionId: string | null;
  gitHead: string;
}

export function storeComplianceScore(cwd: string, record: ComplianceScoreRecord): void;
```

The broader memory refactor originally considered here is deferred: do not require `storeMemoryRecord`, `searchMemoryRecords`, or `searchPriorComplianceScores` in v1. The existing `flywheel_memory` implementation remains unrefactored for v1, and prior-score search is part of the future "low-score-N-sessions-in-a-row" surface.

**New record kind `compliance_score`:**

```
{
  kind: "compliance_score",
  tags: ["compliance", "score", "<bead-id>", "score-<bucket>"],
  // bucket = "0-499" | "500-699" | "700-849" | "850-1000"
  body: { beadId, score, threshold, passed, rubric, passUtc, sessionId, gitHead }
}
```

## 5. Data flow

```
[impl agents close beads]
        │ br update --status closed
        ▼
[Step 9 _review.md]
        │
        ├─ flywheel_verify_beads(beadIds)
        │     → verified / autoClosed / unclosedNoCommit / missingEvidence
        │     (existing — unchanged)
        │
        └─ flywheel_compliance_audit(beadIds, mode: "single-bead")
              │   → spawn skill in parallel (parallelism cap: 5)
              │   skill writes passes/<UTC>/result.json
              │   skill writes per-bead scorecards
              ▼
              parse result.json
                  ├─ for each failed: br update --status open + br comment + bump telemetry
                  ├─ for each result: storeComplianceScore(compliance_score)
                  └─ return { passed, failed, passUtc, errors }
        │
        ▼
[Step 9 menu]
        ├─ failed.length === 0 → existing "Looks good / Self review" menu
        └─ failed.length > 0 → new failure menu
              │
              ├─ Re-implement → set checkpoint.activeBeadIds = failed[].beadId, jump to Step 7
              ├─ Show evidence → cat passUtc/REPORT.md → re-show menu
              ├─ Override → record `compliance.overrides[]` in checkpoint, stamp `Compliance-Override:` trailer in wrap-up commit, proceed to Step 9.5
              └─ Skip → mark advisory, proceed to Step 9.5
```

## 6. Failure modes

| Failure | Detection | Behavior |
|---|---|---|
| Skill not installed at `~/.claude/skills/...` | spawn returns ENOENT or non-zero exit immediately | tool returns `status: "error"`, no telemetry bump, Step 9 prints banner warning ("Compliance skill unavailable — install via …"), wrap-up proceeds |
| `result.json` parse fails | JSON.parse throws | tool returns `status: "error"` with parse error in `errors`, Step 9 treats as advisory, existing menu |
| `br update --status open` fails on a failed bead | execa exit code != 0 | log to `errors[beadId]`, continue with other reopens. Never block on partial failures |
| Audit timeout (skill hangs > 15 min on a bead) | tool-side abort signal | kill the spawn, mark `errors[id] = "timeout"`, return partial result for others |
| `FW_COMPLIANCE_OVERRIDE` env present at tool entry | env check before spawn | tool returns `status: "skipped"` immediately, no skill spawn, no telemetry bump. Emergency unblock path |
| Wave is empty (`beadIds.length === 0`) | input validation | tool returns `status: "ok"` with empty arrays. Caller has nothing to gate on |

## 7. Testing strategy

| Layer | Location | Coverage |
|---|---|---|
| Unit | `mcp-server/src/__tests__/compliance-audit.test.ts` | Mock skill spawn with fixture `result.json`s — all pass / all fail / mixed / parse error / spawn error / override env / empty wave |
| Integration | `mcp-server/src/__tests__/compliance-audit-integration.test.ts` (gated by `RUN_INTEGRATION=1`) | Spawn the real skill against a temp project with one trivially-passing bead and one obviously-incomplete bead. Slow — not in default CI |
| Skill-side | (separate change-list, lower priority) | Snapshot test for `result.json` schema in the skill repo |
| Manual | None required | The MCP tool's contract tests cover the end-to-end path. `_review.md` is too prompt-heavy for CI |

## 8. Out of scope (deferred to v2)

- Step 10 wrap-up audit (post-session learning capture)
- Cron / tripwire entry point (weekly all-closed audit)
- "Low-score-N-sessions-in-a-row" signal in welcome banner (data is captured in v1, surfacing comes later)
- Generic CASS helper extraction (`storeMemoryRecord` / `searchMemoryRecords`) shared with `flywheel_memory`
- `searchPriorComplianceScores` helper and consumers for historical score trend queries
- Per-bead override granularity (today: env-list bypasses ALL beads; v2: per-id approve)
- UI surface for inspecting score history outside the flywheel

## 9. Notes

The skill's `--remediation report-only` for flywheel-gate mode is a deliberate inversion: normally the skill itself reopens; in flywheel-gate mode the MCP tool does. This is so the tool owns the bead-mutation lifecycle (cleaner for the override flow). Trade-off: standalone-skill users who pick `--mode flywheel-gate` outside the flywheel will get reports without reopens, which might surprise them. Documented in the skill's mode reference.

## 10. Implementation plan

To be generated via `/superpowers:writing-plans` immediately after this spec is approved. Expected task graph:

1. Skill changes (C1 + C2) — `--mode flywheel-gate` + `result.json`. Two-repo PR.
2. MCP tool scaffold — `compliance-audit.ts` with mock skill spawn (unit-test driver).
3. Telemetry + CASS wiring (B1 + B2).
4. `_review.md` Step 9 rewrite with new failure menu.
5. Integration test against the real skill.
6. Docs — update AGENTS.md and `_review.md` cross-references.
7. Version bump + CHANGELOG.
