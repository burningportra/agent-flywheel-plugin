# Ergonomics Plan: Four-Pack Feature Suite

**Date:** 2026-04-27
**Agent:** Ergonomics perspective (deep-plan swarm)
**Perspective:** User first-touch, failure modes, AskUserQuestion design, output scannability.

---

## 1. User Journeys

### Feature 1: Inline Doctor Remediation

**Trigger:** User runs `/agent-flywheel:flywheel-doctor` on a fresh clone.

**Flow:**
```
User: /flywheel-doctor
→ Doctor report renders (familiar box format)
→ [FAIL] dist_drift  — src/errors.ts newer than dist/server.js by 43 min
→ [WARN] ntm_binary  — not on PATH

AskUserQuestion:
  "2 checks need attention. What would you like to do?"
  [1] Fix dist_drift now  (runs: cd mcp-server && npm run build)
  [2] Install ntm binary  (runs: curl install script)
  [3] Fix all auto-fixable checks
  [4] Skip — I'll fix manually

→ User picks [1]
→ Progress: "Running: npm run build..."  (streaming output, bounded 30s)
→ Build completes: "dist_drift — fixed. Rebuild took 4.2s."

AskUserQuestion:
  "dist_drift fixed. Re-run doctor to confirm?"
  [1] Yes — re-run now
  [2] No — continue to /start

→ User picks [1]
→ Doctor re-runs, all green
→ "All checks green. Ready for /start."
```

**Single most-likely friction point:** The user sees the report, types the fix command manually anyway (old muscle memory), and then wonders why the skill bothered prompting. Mitigation: make the remediation prompt appear *inline immediately below* the failing check row, not at the end of the report. The spatial co-location signals "this fix belongs to that check."

---

### Feature 2: Plan Estimation Calibration

**Trigger:** User finishes a bead and sees the calibration ratio in `/flywheel-status`.

**Flow:**
```
User: /flywheel-status
→ Standard status table renders
→ NEW section at bottom: "Calibration (last 30d)"
   template             mean    median  p95     ratio
   new-mcp-tool         1.8h    1.5h    4.2h    1.4×
   add-feature          0.6h    0.5h    1.1h    1.1×
   fix-bug              0.4h    0.3h    0.9h    0.9×

→ During /start deep-plan synthesis, synthesizer prompt includes:
  "new-mcp-tool beads historically take 1.4× their estimate — mark M→L"
```

**Flow for calibration data becoming useful (warm path — 5+ closed beads):**
```
User opens plan. Synthesizer emits a new-mcp-tool bead marked M.
Calibration engine sees ratio 1.4× → silently upgrades to L in the bead body.
At bead approval, user sees "(calibrated: M→L, ratio 1.4×)"
```

**Single most-likely friction point:** On a cold repo (0 closed beads), the calibration table renders empty or with N/A — looks broken. Mitigation: gate the calibration section on N≥3 closed beads of any template. Below threshold, show a single dim line: "Calibration available after 3+ closed beads."

---

### Feature 3: Skill Markdown Precompilation

**Trigger:** Session start — `/start` loads phase instructions.

**Flow (current — slow path):**
```
/start → Read skills/start/SKILL.md (I/O)
       → Read skills/start/_planning.md (I/O)
       → Read skills/start/_beads.md (I/O)
       → … 6 more reads across the session
```

**Flow (new — bundle path):**
```
/start → flywheel_get_skill({ name: "start" })
       → returns full bundled body in <1 MCP roundtrip
       → sub-skill files served from same bundle on demand
```

**Single most-likely friction point:** Contributor edits a SKILL.md, runs `/start`, and gets the old cached version. Mitigation: dev-mode env var `FW_SKILL_BUNDLE=off` bypasses bundle entirely and falls back to direct filesystem reads. Contributor sets it once in their shell; CI always uses bundle.

---

### Feature 4: Web-Based Bead-Graph Visualizer

**Trigger:** User runs `npm run bead-viewer` (or `/agent-flywheel:flywheel-bead-viewer`).

**Flow:**
```
$ npm run bead-viewer
→ "Bead viewer running at http://localhost:7331"
→ Browser tab opens automatically (open/xdg-open)
→ Graph renders: nodes colored by status, edges show depends_on
→ User clicks a node → side panel shows bead title, status, description
→ Auto-refresh every 30s (or on file change if chokidar available)
```

**Single most-likely friction point:** Port 7331 already in use — server crashes with EADDRINUSE and no helpful message. Mitigation: on bind failure, try 7332, 7333 (up to 3 attempts), print the actual URL in green so the user knows where to go.

---

## 2. AskUserQuestion Designs

### Doctor Remediation Prompt (per failing/warning check)

Appears once after the full report renders, not per-check inline.

```
AskUserQuestion({
  question: "Doctor found 2 fixable issues. Fix them now?",
  header: "Remediation",
  options: [
    { label: "Fix dist_drift",    description: "cd mcp-server && npm run build (auto, ~10s)" },
    { label: "Install ntm",       description: "curl install script for ntm binary (auto, ~30s)" },
    { label: "Fix all auto-fixable", description: "Run both fixes sequentially" },
    { label: "Skip",              description: "I'll fix manually; continue" }
  ],
  multiSelect: false
})
```

Rules:
- Only surface checks with known auto-fix scripts (dist_drift, br_binary, bv_binary, ntm_binary, cm_binary, agent_mail_liveness).
- Checks without auto-fix (git_status, node_version, mcp_connectivity) get their hint printed below the report line, no AskUserQuestion — user must fix manually.
- If overall is green or only informational: no AskUserQuestion at all.

### Re-run Doctor Prompt (after successful fix)

```
AskUserQuestion({
  question: "Fix applied. Verify by re-running doctor?",
  header: "Verify fix",
  options: [
    { label: "Re-run doctor", description: "Confirm the fix resolved the issue" },
    { label: "Continue",      description: "Skip verify and proceed to /start" }
  ],
  multiSelect: false
})
```

### Calibration Ratio Notification (at bead approval time)

Only fires when a single bead's template has a calibration ratio ≥1.3×.

```
AskUserQuestion({
  question: "Calibration: new-mcp-tool beads run 1.4× their estimate (median 1.5h vs 1.1h). This bead is marked M — keep M or adjust?",
  header: "Effort calibration",
  options: [
    { label: "Keep M", description: "Accept the current estimate as-is" },
    { label: "Upgrade to L", description: "Bump to L to reflect historical run time" }
  ],
  multiSelect: false
})
```

---

## 3. Output Mockups

### `/flywheel-status` Calibration Table (new section, max 4 lines)

```
── Calibration (last 30 beads) ──────────────────────────────
  template          mean    p50     p95     ratio
  new-mcp-tool      1.8h    1.5h    4.2h    1.4×  ▲
  add-feature       0.6h    0.5h    1.1h    1.1×
  fix-bug           0.4h    0.3h    0.9h    0.9×  ▼
  (3 templates — 5 more below threshold)
```

- `▲` = systematically underestimated (ratio > 1.25×); `▼` = overestimated (ratio < 0.8×).
- Shows top 3 by bead count. "X more below threshold" for templates with <3 data points.
- Omitted entirely if total closed beads < 3.

### Doctor Remediation Prompt Block (inline below report)

```
┌─ flywheel doctor ─────────────────────────────────┐
│ overall: FAIL   elapsed: 312ms                    │
├───────────────────────────────────────────────────┤
│ [OK]   mcp_connectivity       — build current     │
│ [FAIL] dist_drift             — src newer by 43m  │
│ [WARN] ntm_binary             — not on PATH       │
│ [OK]   br_binary              — v1.4.1            │
│  ...                                              │
└───────────────────────────────────────────────────┘

Fixable: dist_drift (auto), ntm_binary (auto)
Manual:  (none)
```

(AskUserQuestion immediately follows — no text between report and prompt.)

### Bead-Viewer ASCII Sketch

```
┌─ Bead Graph ──────────────────────┬─ Detail ──────────────────────────┐
│                                   │ ID:      fw-ergo-01               │
│  [fw-ergo-01] ──→ [fw-ergo-02]   │ Title:   Add flywheel_remediate   │
│       ↓                           │ Status:  in_progress              │
│  [fw-ergo-03] ──→ [fw-ergo-04]   │ Effort:  M                        │
│                                   │ Template: new-mcp-tool@1          │
│  Legend:                          │                                   │
│  ■ open  ▣ in_progress            │ Description:                      │
│  ● closed  ○ deferred             │ Register flywheel_remediate MCP   │
│                                   │ tool with per-check fix scripts.  │
│  [Refresh in 28s]                 │                                   │
└───────────────────────────────────┴───────────────────────────────────┘
```

Color coding:
- open: gray
- in_progress: blue
- closed: green
- deferred: orange
- Node with calibration ratio >1.3× gets a `!` badge

---

## 4. Skill Markdown Integration

### `skills/flywheel-doctor/SKILL.md` — Remediation Integration

**Insertion point:** Line 77, immediately after the remediation flowchart block ends (`...run `/agent-flywheel:flywheel-stop` to reset...`).

**Patch:**

```markdown
## Inline remediation (new in v3.7.0)

After rendering the report, collect all checks where `severity` is `red` or
`yellow` AND a canonical auto-fix exists (dist_drift, br_binary, bv_binary,
ntm_binary, cm_binary, agent_mail_liveness). If any exist, call:

```
flywheel_remediate({ checkName: "<name>", autoConfirm: false })
```

Present the result via AskUserQuestion — see template in §AskUserQuestion
designs. Do NOT skip the prompt; `autoConfirm: true` is reserved for CI.

After each fix completes, log the event to CASS:
```
flywheel_memory({ operation: "store", content: "flywheel-remediate check=<name> result=<ok|err> ts=<ISO>" })
```

Then offer to re-run doctor (see §Re-run Doctor Prompt).
```

**Tone match:** Matches existing imperative-present style ("After rendering…", "call:", "do NOT").

---

### `skills/start/SKILL.md` — Skill Bundle Note

**Insertion point:** Step 0b (where sub-skill files are loaded per UNIVERSAL RULE 3).

**Patch (add after the phase table):**

```markdown
> **Bundle fast-path:** `flywheel_get_skill({ name: "<phase-file-stem>" })` returns
> the precompiled body without filesystem I/O. Use it when available. Falls back to
> `Read skills/start/<file>.md` if the MCP tool returns `bundle_not_found` or
> `FW_SKILL_BUNDLE=off` is set (dev mode).
```

---

## 5. Bead Breakdown

Dependencies: T = depends_on task IDs listed below.

| ID  | Title | Template | Effort | depends_on |
|-----|-------|----------|--------|------------|
| E1  | Add `flywheel_remediate` MCP tool — schema + per-check fix registry | new-mcp-tool | M | — |
| E2  | Wire remediation into `skills/flywheel-doctor/SKILL.md` — AskUserQuestion flow | new-skill | S | E1 |
| E3  | Add re-run doctor AskUserQuestion after remediation completes | add-feature | S | E1, E2 |
| E4  | Log remediation events to CASS (flywheel-remediate prefix) | add-feature | S | E1 |
| E5  | Add `estimatedEffort` field to `BeadTemplate` type + all BUILTIN_TEMPLATES | add-feature | S | — |
| E6  | Implement `flywheel_calibrate` MCP tool — aggregate closed-bead timings | new-mcp-tool | M | E5 |
| E7  | Surface calibration table in `/flywheel-status` (max 4-line block) | add-feature | S | E6 |
| E8  | Inject calibration ratios into deep-plan synthesizer prompts | add-feature | S | E6 |
| E9  | AskUserQuestion at bead approval when ratio ≥1.3× (single-bead prompt) | add-feature | S | E6, E8 |
| E10 | `mcp-server/scripts/build-skills-bundle.ts` — emit `dist/skills.bundle.json` | add-feature | M | — |
| E11 | `flywheel_get_skill({ name })` MCP tool — serve from bundle | new-mcp-tool | S | E10 |
| E12 | Update `/start` SKILL.md §bundle fast-path note | doc-update | S | E11 |
| E13 | `FW_SKILL_BUNDLE=off` dev-mode bypass + docs | add-feature | S | E10, E11 |
| E14 | `mcp-server/scripts/bead-viewer.ts` — HTTP server, br list --json, Cytoscape CDN | add-feature | L | — |
| E15 | Auto-open browser tab on launch (open/xdg-open), port fallback 7331→7333 | add-feature | S | E14 |
| E16 | Calibration ratio heat color in bead-viewer nodes | add-feature | S | E14, E6 |
| E17 | `npm run bead-viewer` script + `flywheel-bead-viewer` command/skill stubs | new-skill | S | E14, E15 |

**Wave ordering for early visible value:**
- Wave 1 (ship first — touches every doctor run): E1, E2, E3, E4
- Wave 2 (calibration foundation): E5, E6, E7, E8, E9
- Wave 3 (skill bundle): E10, E11, E12, E13
- Wave 4 (bead-viewer polish): E14, E15, E17, E16

---

## 6. Cross-Feature Ergonomic Synergies

**Remediation → Calibration loop:**
When `flywheel_remediate` logs to CASS (E4), the `flywheel_calibrate` engine (E6) can include doctor→fix→re-doctor cycle times as a separate "time-to-healthy" metric. This surfaces in `/flywheel-status` as a second row: `doctor remediation  avg 4s  (dist_drift 4.2s, ntm_binary 32s)`.

**Bead-viewer → Calibration heat:**
Bead nodes in the viewer (E14) can show calibration ratio as node color intensity (E16): green for ratio <1.1×, yellow for 1.1–1.3×, red for >1.3×. Gives the PM a 5-second "which templates are blowing up?" answer without opening `/flywheel-status`.

**Skill bundle → Doctor:**
If `flywheel_get_skill({ name: "flywheel-doctor" })` is served from the bundle (E11), the doctor skill loads in one MCP call instead of a Read. This is especially visible on cold session starts where the skill directory hasn't been warmed.

**Calibration → Synthesizer → Bead-viewer:**
When the synthesizer marks a bead M→L due to calibration (E8), the bead-viewer node for that bead gets a `!` badge (E16) indicating "auto-calibrated effort." Gives a visual audit trail.

---

## 7. Risk Register (Ergonomics Angle)

| Risk | Feature | Likely symptom | Mitigation |
|------|---------|----------------|-----------|
| Bundle hides live edits during active skill development | F3 (skill bundle) | Contributor edits `_planning.md`, session still loads old version — debugging nightmare | `FW_SKILL_BUNDLE=off` env var (E13); prominently documented in AGENTS.md |
| Calibration table on cold repo looks broken | F2 (calibration) | Empty table with headers confuses new users | Gate on N≥3 closed beads; show "3+ beads needed" single line below threshold |
| Remediation AskUserQuestion fires for every yellow check | F1 (remediation) | 6 optional checks (ntm, cm, bv, swarm_model_*) all yellow → 6-option prompt is overwhelming | Cap prompt to "fix all auto-fixable" single option when >2 fixable; individual options only when ≤2 |
| Bead-viewer port collision on developer machines | F4 (bead-viewer) | EADDRINUSE crash, no hint where to look | Try ports 7331–7333; print "Bead viewer at http://localhost:<N>" in green on success |
| Calibration ratio injection into synthesizer adds token cost | F2 (calibration) | Plan synthesis token budget exceeded on large plans | Only inject ratios for templates with N≥3 data points; max 5 rows in synthesizer prompt |
| Auto-fix scripts run without user seeing what they execute | F1 (remediation) | Trust/audit concern — user doesn't know what ran | Print the exact shell command in the AskUserQuestion description field; never run silently |
| `flywheel_calibrate` called on repo with no CASS/cm | F2 (calibration) | Tool errors or hangs | Graceful degradation: read from `.pi-flywheel/bead-timings.json` local fallback (same pattern as `rescues_last_30d` local telemetry fallback in `doctor.ts:1260`) |

---

## 8. Per-Bead Estimated Effort

S = ~30min, M = ~1.5h, L = ~3-4h, XL = >6h.

| ID  | Effort | Rationale |
|-----|--------|-----------|
| E1  | M | New MCP tool: schema, handler, fix registry map, tests, server.ts registration |
| E2  | S | Skill markdown patch only; no TypeScript |
| E3  | S | One AskUserQuestion call added to skill flow |
| E4  | S | One `flywheel_memory` call after fix; well-established pattern |
| E5  | S | Type field addition + backfill on 15 templates; mechanical |
| E6  | M | New MCP tool: timing aggregation, mean/median/p95, template keying |
| E7  | S | Render calibration block in status output; formatting only |
| E8  | S | Prompt injection: read calibration JSON, prepend 5-row table to synthesizer prompt |
| E9  | S | Conditional AskUserQuestion at bead approval; one new branch |
| E10 | M | New build script: walk skills/, parse frontmatter, emit JSON bundle |
| E11 | S | New MCP tool: read bundle file, return body by name |
| E12 | S | 3-line patch to SKILL.md |
| E13 | S | Env var check in flywheel_get_skill + note in AGENTS.md |
| E14 | L | HTTP server, br list --json polling, Cytoscape CDN, graph render, side panel |
| E15 | S | open/xdg-open call + port fallback loop |
| E16 | S | Node color from calibration ratio; CSS class map |
| E17 | S | package.json script + command/skill stub files |

Total: 4×S(trivial) + 8×S + 4×M + 1×L = ~16h estimated across all 17 beads.

---

## Dependency Graph

```
E1 ──→ E2 ──→ E3
 └──→ E4

E5 ──→ E6 ──→ E7
        └──→ E8 ──→ E9

E10 ──→ E11 ──→ E12
  └──→ E13

E14 ──→ E15 ──→ E17
  └──→ E16 (also depends on E6)
```

Wave 1 (E1–E4) is fully independent. Wave 2 (E5–E9) is fully independent. Waves 3 and 4 are also independent of each other and of Waves 1–2. All four waves can be parallelized by different agents.
