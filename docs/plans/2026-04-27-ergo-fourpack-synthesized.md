# Plan: Ergonomic Four-Pack (synthesized)

**Date:** 2026-04-27
**Source:** 3-perspective deep plan (correctness + ergonomics + robustness)
**Target:** agent-flywheel v3.6.11 → v3.7.0 (`/Volumes/1tb/Projects/agent-flywheel`, NodeNext/ESM, strict TS)
**Status:** Ready for alignment check

---

## Plan-acknowledgment block

### What correctness does best
The correctness plan nails the **type-system spine** that the other two assume but never specify: a `Record<DoctorCheckName, RemediationHandler | null>` lookup with `null` as the explicit "no automated fix" marker, exhaustiveness via TS `assertExhaustive`, and a `RemediationPlan`/`RemediationResult` envelope that tests can assert against shape-by-shape. It is also the only plan that thinks carefully about **`__untemplated__` legacy beads** in calibration (pre-v3.4.x beads have no `template:` field) and about non-breaking optional `estimatedEffort?` semantics. Its file boundaries (`tools/remediations/<check>.ts` per-handler files, pure `bead-graph.ts` data layer, decoupled `calibration-store.ts` stats module) are the most testable.

### What ergonomics does best
The ergonomics plan is the only one that **draws the actual UX**: AskUserQuestion option arrays with concrete labels/descriptions, ASCII mockups of `/flywheel-status` with `▲`/`▼` ratio markers, and a side-panel sketch for the bead-viewer. It also catches subtle journey hazards the others miss — old-muscle-memory users typing the fix manually anyway (mitigated by **inline placement of the prompt next to the failing check**, not at the report bottom), the cold-repo "calibration table looks broken" trap (gate on `n ≥ 3`), and the contributor "bundle hides my live edit" frustration (`FW_SKILL_BUNDLE=off` env-var bypass). The remediation→calibration cross-feature loop ("time-to-healthy" metric) is a unique synergy insight.

### What robustness does best
The robustness plan is the only one that brings a **threat model per feature** and codifies the lessons of the dist-drift incident this session: **content hashes everywhere** (`srcSha256` per skill, `manifestSha256` aggregate, recompute on load and refuse mismatched bundles), AbortSignal threaded into every new tool, atomic `tmp → fsync → rename` writes, per-fix mutex via `mcp-server/src/mutex.ts`, and the killer insight that **"shell exit 0 ≠ check is green"** — every remediation must re-run its `verifyProbe` and surface `verifiedGreen: boolean`. It is also the only plan that explicitly addresses the calibration **inflated-duration trap** (bead opens, sits 30 days, gets done in 5 minutes — `closed_ts - created_ts` lies; prefer first-commit ts via `git log --grep=<bead-id>`).

### Unresolved tensions

| # | Tension | The 3 positions | Synthesis decision |
|---|---|---|---|
| U1 | **Tool surface for remediation** | Correctness: single `flywheel_remediate({ checkName: DoctorCheckName })` with strict union. Ergonomics: free-text labels in AskUserQuestion option descriptions. Robustness: content-hashed entries in registry, would prefer keyed-by-hash for tamper-evidence. | **Single tool, strict `z.enum(DOCTOR_CHECK_NAMES)` schema** (correctness). Free-text only in `description`/`rationale` strings inside the registry entry (ergonomics). Defer hash-keyed registry — overkill for v1 since registry is compile-time static. |
| U2 | **Auto-confirm default** | Correctness: `autoConfirm: false` default + `mode: 'dry_run'` default; mutating handlers refuse without explicit consent. Ergonomics: AskUserQuestion drives consent, then call with `autoConfirm: true`. Robustness: headless detection — if no user attached, return proposed command and apply nothing. | **Both defaults stay false; mode default is `'dry_run'`.** AskUserQuestion-flow in SKILL.md flips them per check. Headless detection added (robustness): if `process.stdin.isTTY === false` AND `autoConfirm: true`, log `warn` and proceed (CI use-case is real). |
| U3 | **Calibration time source** | Correctness: `closed_ts - created_ts` from `br list --json`, drop where `closed_ts < created_ts`. Ergonomics: doesn't address; just shows the table. Robustness: prefer `git log --grep=<bead-id> -1 --format=%aI --reverse` first-commit ts as `started_ts` proxy. | **Use `created_ts` as the baseline**, but additionally compute `firstCommitTs` per bead via `git log` (capped 200 git calls per run — robustness's bound). When `firstCommitTs` exists, use it; tag the sample `proxy_started: true`. When neither works, drop and increment `droppedSamples`. |
| U4 | **Bundle staleness behavior** | Correctness: bundler computes `bodyHash`; CI-only `check:skills-bundle` script enforces match. Ergonomics: dev-mode `FW_SKILL_BUNDLE=off` bypass. Robustness: at runtime, recompute `manifestSha256`; on mismatch return `bundle_integrity_failed` and fall back to disk; if entry's `srcSha256` mismatches on-disk source, serve bundle but emit `bundle_stale: true` warn. | **All three layered**: (a) build-time `check:skills-bundle` for CI gate, (b) runtime integrity check (`manifestSha256`), (c) per-entry stale-warn (`srcSha256`), (d) `FW_SKILL_BUNDLE=off` env-bypass for contributors. The `source: 'bundle' \| 'disk'` field on the response makes the path observable to tests. |
| U5 | **Bead-viewer port + dependency strategy** | Correctness: ephemeral port `127.0.0.1:0`, OS-printed URL, zero new deps, Cytoscape via CDN with SRI. Ergonomics: fixed port 7331 with fallback 7332/7333 ("memorable URL"). Robustness: fixed port 3737 with `+1..+9` fallback, hard-coded loopback bind, conn cap, rate limit, JSDOM XSS test. | **Ephemeral `127.0.0.1:0` default + `--port <N>` CLI flag** for users who want a stable URL. Print the chosen URL prominently. Adopt all robustness caps (16 conn, 30 req/s/IP, 2000 nodes, 60s per-conn timeout, parent-pid watch). Cytoscape via CDN with SRI; document offline-mode limitation. |

---

## Goal & non-goals

**Goal.** Ship the four ergonomic improvements in v3.7.0 with strict typing, AskUserQuestion-driven consent, content-hash-based artifact integrity, and chaos-test coverage of every new failure mode:

1. `flywheel_remediate({ cwd, checkName, autoConfirm?, mode? })` MCP tool + `skills/flywheel-doctor/SKILL.md` integration.
2. `estimatedEffort` field on `BeadTemplate` + `flywheel_calibrate` MCP tool + `/flywheel-status` and synthesizer prompt integration.
3. `npm run build` emits content-hashed `mcp-server/dist/skills.bundle.json` + `flywheel_get_skill({ name })` MCP tool with disk fallback.
4. `mcp-server/scripts/bead-viewer.ts` — read-only loopback HTTP server rendering Cytoscape graph from `br list --json` + `br dep list --json`.

**Non-goals (deduplicated from all 3 plans).**

1. **Doctor never mutates.** `flywheel_doctor` stays read-only forever. No `--remediate` flag. (correctness #1)
2. **No auto-fix for user-decision checks.** `node_version`, `git_status`, `gemini_cli`, `claude_cli`, `codex_cli`, `swarm_model_ratio`, `br_binary`, `bv_binary`, `ntm_binary`, `cm_binary`, `rescues_last_30d` — all `null` in registry, manual hints already in SKILL.md. (correctness #2)
3. **Calibration never mutates beads.** Produces a *report*; no `calibrated_effort` write-back. (correctness #3)
4. **Bead-viewer is read-only.** No PATCH/POST/DELETE. No drag-to-reorder, no auth. (correctness #4)
5. **No bead-viewer rich filtering UI.** Cytoscape's built-in pan/zoom only. (correctness #5)
6. **No new npm deps.** Reuse `unified` + `remark-parse` for frontmatter. Cytoscape via CDN. (correctness #7)
7. **No batch remediation in v1.** One tool call = one fix. (correctness #8)
8. **No bundle compression.** ~200 KiB JSON over stdio MCP — irrelevant. (correctness #6)
9. **No bundle signing (HMAC).** `manifestSha256` detects accidental tampering, not malicious. (robustness §9.3)
10. **No bead-viewer auth / non-localhost binding.** Hard-coded `127.0.0.1`. (robustness §9.4)
11. **No orchestrator wiring of `get_skill` in v1.** Tool ships; `/start` continues to `Read` skills until a follow-up replaces those calls. (correctness #10)
12. **No remediate `idempotent: false` entries in v1.** All seed fixes are idempotent (rebuild, install, restart). (robustness §9.5)

---

## Architecture overview

```
                        ┌─────────────────────────────────────────┐
                        │         mcp-server/src/server.ts        │
                        │  (TOOLS array + DEFAULT_RUNNERS map)    │
                        └────┬────────────┬────────────┬──────────┘
                             │            │            │
              ┌──────────────┘            │            └──────────────┐
              ▼                           ▼                            ▼
   ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
   │ tools/remediate.ts   │  │ tools/calibrate.ts   │  │ tools/get-skill.ts   │
   │  Zod schema +        │  │  Zod schema +        │  │  Zod schema +        │
   │  dispatcher          │  │  aggregator          │  │  bundle loader       │
   └──────┬───────────────┘  └──────┬───────────────┘  └──────┬───────────────┘
          │                          │                          │
          ▼                          ▼                          ▼
   ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
   │ tools/remediations/  │  │ calibration-store.ts │  │ skills-bundle.ts     │
   │  <check>.ts × 5      │  │  (pure stats fns)    │  │  loader + cache +    │
   │  per-handler files   │  │  + br-parser         │  │  disk fallback       │
   └──────┬───────────────┘  └──────┬───────────────┘  └──────┬───────────────┘
          │                          │                          │
          ▼                          ▼                          ▼
   ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
   │ exec.ts + mutex.ts   │  │ br list --json       │  │ dist/                │
   │ + AbortSignal        │  │  + git log --grep    │  │  skills.bundle.json  │
   │ + .pi-flywheel/.lock │  │  + .pi-flywheel/     │  │  (content-hashed,    │
   │                      │  │   calibration.json   │  │  atomic write)       │
   └──────────────────────┘  └──────┬───────────────┘  └──────────────────────┘
                                     │
                                     ▼
                            ┌──────────────────────┐
                            │ deep-plan-           │
                            │ synthesis.ts         │
                            │ (reads calibration   │
                            │ from disk, splices   │
                            │ into prompt)         │
                            └──────────────────────┘

   ┌────────────────────────────────────────────────────────────────────────┐
   │                       scripts/bead-viewer.ts                           │
   │  127.0.0.1:0 HTTP server → reads br list/dep --json → buildBeadGraph   │
   │  → static HTML (Cytoscape via CDN+SRI) + /api/graph JSON               │
   │  Caps: 16 conn / 30 rps / 2000 nodes / 60s timeout / parent-pid watch  │
   └────────────────────────────────────────────────────────────────────────┘
```

**Cross-feature interactions:**
- Calibration writes `.pi-flywheel/calibration.json` as a side effect; synthesis reads it (filesystem decouples — avoids circular import).
- Skill bundle is a build artifact; `flywheel_get_skill` reads it at runtime with disk fallback.
- Bead-viewer is a standalone CLI — does NOT import from any other tool module.
- Remediation logs to CASS via existing `flywheel_memory` (ergonomics' insight) so calibration can later compute "time-to-healthy" per check.

---

## Per-feature design

### Feature 1: Inline doctor remediation

**Tool surface (resolves U1):**
```ts
// mcp-server/src/tools/remediate.ts
const RemediateInputSchema = z.object({
  cwd: z.string().min(1),
  checkName: z.enum(DOCTOR_CHECK_NAMES),
  autoConfirm: z.boolean().optional().default(false),
  mode: z.enum(['dry_run', 'execute']).optional().default('dry_run'),
});
```

**Architecture choice — adopted from correctness:** `Record<DoctorCheckName, RemediationHandler | null>` lookup map in `mcp-server/src/tools/remediate.ts`, one handler file per check under `mcp-server/src/tools/remediations/`. `null` = "no automated fix" → `remediation_unavailable` envelope. `assertExhaustive(_: never)` in default branch. **Why:** TS exhaustiveness check at compile time when `DOCTOR_CHECK_NAMES` grows; per-handler files are easy to mock per-test (correctness's testability win).

**Idempotency model — adopted from robustness + correctness:** Every handler MUST re-run as a no-op (`executed: false, stepsRun: 0`). Mutating handlers MUST set `reversible: false` and refuse to apply with `autoConfirm: false` unless `mode === 'dry_run'`. Per-check mutex via `mcp-server/src/mutex.ts` (robustness's win — concurrent rebuilds clobber each other). `try/finally` cleans `.pi-flywheel/remediate.lock`.

**Verification gate — robustness's killer insight:** Every handler ships with a `verifyProbe: () => Promise<boolean>` that re-runs the original doctor check. Result envelope includes `verifiedGreen: boolean`. **Never rely on shell exit code alone.** A `warn` log fires on `verifiedGreen: false` even when `exitCode === 0`.

**Result envelope (synthesis of correctness's shape + robustness's `verifiedGreen`):**
```ts
export interface RemediationResult {
  check: DoctorCheckName;
  mode: RemediationMode;
  plan: RemediationPlan;
  executed: boolean;
  stepsRun: number;
  verifiedGreen: boolean;       // robustness — re-runs probe after apply
  stdout?: string;              // truncated to 4 KiB
  stderr?: string;              // truncated to 4 KiB
  durationMs: number;
}
```

**Seed handlers (5):** `dist_drift`, `mcp_connectivity`, `agent_mail_liveness`, `orphaned_worktrees`, `checkpoint_validity`. (`codex_config_compat` deferred per correctness #non-goals.)

**Error codes added to `FLYWHEEL_ERROR_CODES`:** `remediation_unavailable`, `remediation_requires_confirm`, `remediation_failed`, `remediate_already_running`. Each gets `DEFAULT_HINTS` + `DEFAULT_RETRYABLE` entries (`errors.schema.test.ts` enforces exhaustiveness).

**SKILL.md integration (ergonomics's user journey):** Insert at `skills/flywheel-doctor/SKILL.md` lines 60–77 — replace the static remediation flowchart with an **inline AskUserQuestion next to each failing check row** (not at report bottom — ergonomics's friction-point fix). For checks with `null` handlers, fall through to the existing manual one-line fix hint.

**Files touched:**
- New: `mcp-server/src/tools/remediate.ts`
- New: `mcp-server/src/tools/remediations/{dist_drift,mcp_connectivity,agent_mail_liveness,orphaned_worktrees,checkpoint_validity}.ts`
- Modify: `mcp-server/src/server.ts` (TOOLS + DEFAULT_RUNNERS), `mcp-server/src/types.ts` (shared types), `mcp-server/src/errors.ts` (new codes)
- Modify: `skills/flywheel-doctor/SKILL.md` (lines 60–77)

---

### Feature 2: Plan estimation calibration

**Type design — adopted from correctness:**
```ts
// mcp-server/src/types.ts
export const EFFORT_LEVELS = ['S', 'M', 'L', 'XL'] as const;
export type EstimatedEffort = (typeof EFFORT_LEVELS)[number];
export const EFFORT_TO_MINUTES: Record<EstimatedEffort, number> = {
  S: 30, M: 90, L: 240, XL: 720,
};
export interface BeadTemplate {
  // ...existing fields
  /** @since v3.7.0 — optional; legacy templates default to 'M' (90 min). */
  estimatedEffort?: EstimatedEffort;
}
```

**Time source (resolves U3):** Per bead, prefer `firstCommitTs` from `git log --grep=<bead-id> -1 --format=%aI --reverse` as `started_ts` proxy. Fall back to `created_ts` from `br list --json`. Drop samples where `closed_ts < started_ts` (clock skew). Cap git fanout at 200 calls per run (robustness's bound) — beyond cap, fall back to `created_ts` and tag `proxy_started: false`.

**Cold-repo gate (ergonomics's friction-point fix):** Surface row only when `sampleCount >= 3` (ergonomics's threshold beats robustness's `n >= 5` — we want signal sooner, with low-confidence flag). Rows with `3 <= n < 5` get `lowConfidence: true` and are excluded from synthesizer prompt injection.

**Untemplated beads (correctness's unique catch):** Pre-v3.4.x beads have no `template:` field. Group under synthetic key `__untemplated__`, exclude from per-template ratios, surface as a single line `"__untemplated__: N closed beads (excluded from calibration)"`.

**Schema:**
```ts
const CalibrateInputSchema = z.object({
  cwd: z.string().min(1),
  sinceDays: z.number().int().min(1).max(365).optional().default(90),
});
```

**Result shape:**
```ts
export interface CalibrationRow {
  templateId: string;
  templateVersion: number;
  estimatedEffort: EstimatedEffort | null;
  estimatedMinutes: number;
  sampleCount: number;
  meanMinutes: number;
  medianMinutes: number;
  p95Minutes: number;
  ratio: number;
  lowConfidence: boolean;       // sampleCount < 5
  proxyStartedCount: number;    // robustness — observability
}
export interface CalibrationReport {
  cwd: string; sinceDays: number; generatedAt: string;
  totalBeadsConsidered: number; droppedBeads: number;
  rows: CalibrationRow[];       // sorted by ratio descending
  untemplated: { count: number };
}
```

**`/flywheel-status` rendering (ergonomics's mockup):**
```
── Calibration (last 30 closed beads) ─────────────────────────
  template          mean    p50     p95     ratio   n
  add-tool          1.8h    1.5h    4.2h    1.4× ▲  12
  add-feature       0.6h    0.5h    1.1h    1.1×    23
  fix-bug           0.4h    0.3h    0.9h    0.9× ▼  18
  (3 templates — 5 more below n≥3 threshold)
```
- `▲` ratio > 1.25×, `▼` < 0.8×, top 3 by sample count, omitted entirely if total closed < 3.

**Synthesis prompt integration:** `mcp-server/src/deep-plan-synthesis.ts` reads `.pi-flywheel/calibration.json` if present, splices a "## Past calibration" section into the prompt with the top 5 rows where `lowConfidence === false`.

**Files touched:**
- Modify: `mcp-server/src/types.ts`, `mcp-server/src/bead-templates.ts` (backfill 9 templates), `commands/flywheel-status.md`, `mcp-server/src/deep-plan-synthesis.ts`
- New: `mcp-server/src/tools/calibrate.ts`, `mcp-server/src/calibration-store.ts` (pure stats), `mcp-server/src/br-parser.ts` (shared `br list --json` parser, also used by Feature 4)

---

### Feature 3: Skill markdown precompilation

**Bundle shape (synthesis of correctness + robustness):**
```ts
export interface SkillBundleEntry {
  name: string;                   // "<plugin>:<skill-name>"
  path: string;                   // repo-relative source path
  frontmatter: { name: string; description?: string; [k: string]: unknown };
  body: string;
  srcSha256: string;              // robustness — per-entry content hash
  sizeBytes: number;              // robustness — for cap enforcement
  bundledAt: string;
}
export interface SkillsBundle {
  bundleVersion: 1;
  generatedAt: string;
  generator: string;
  manifestSha256: string;         // robustness — aggregate hash, recomputed on load
  entries: SkillBundleEntry[];
}
```

**Bundler script:** `mcp-server/scripts/build-skills-bundle.ts` walks `skills/**/SKILL.md` and `skills/start/_*.md`, parses frontmatter via existing `unified` + `remark-parse` (no new deps), atomic write (`tmp → fsync → rename`) to `mcp-server/dist/skills.bundle.json`. **Caps:** 5 MB total, 200 KB per entry — build fails over cap with actionable error. Wired into `npm run build`.

**Drift defense (resolves U4 — all four layers):**
1. **Build-time gate:** `npm run check:skills-bundle` re-walks source tree, compares per-entry `srcSha256` against bundle. CI runs this; non-zero exit fails build.
2. **Runtime integrity:** `loadSkillsBundle()` recomputes `manifestSha256`. On mismatch → `bundle_integrity_failed` log + fall back to disk reads.
3. **Per-entry stale-warn:** When serving a hit, if a same-named source `.md` exists and its on-disk sha256 differs from `entry.srcSha256`, log `bundle_stale: true` warn but still serve the bundle (stability > liveness in production).
4. **Dev-mode bypass (ergonomics):** `FW_SKILL_BUNDLE=off` env var → loader always reads from disk. Documented in AGENTS.md.

**Tool surface:**
```ts
const GetSkillInputSchema = z.object({
  name: z.string().regex(/^[a-z0-9_-]+:[a-z0-9_-]+$/),
});
// Returns: { name, frontmatter, body, source: 'bundle' | 'disk' }
```

The `source` field is the test contract for fallback assertions.

**Errors added:** `bundle_integrity_failed`, `bundle_stale` (warn-level only — bundle still served), `not_found` (existing).

**Files touched:**
- New: `mcp-server/scripts/build-skills-bundle.ts`, `mcp-server/scripts/check-skills-bundle.ts`, `mcp-server/src/skills-bundle.ts` (loader + cache + fallback), `mcp-server/src/tools/get-skill.ts`
- Modify: `mcp-server/package.json` (`build` chain + `check:skills-bundle` script), `mcp-server/src/server.ts` (registration), `skills/start/SKILL.md` (3-line bundle fast-path note)

---

### Feature 4: Web-based bead-graph visualizer

**Server architecture (resolves U5):** `mcp-server/scripts/bead-viewer.ts` — Node CLI using `node:http`, `node:fs/promises`, `node:child_process`. **Zero new runtime deps.** Cytoscape loaded via CDN with SRI hash from a static HTML file.

**Bind + port:**
- Default: `127.0.0.1:0` (ephemeral OS-assigned port). Print `http://127.0.0.1:<port>` in green.
- Override: `--port <N>` CLI flag (ergonomics's "memorable URL" need).
- Hard assertion at startup: refuse if `process.env.FW_VIEWER_BIND` is anything other than `127.0.0.1` (robustness).

**Caps (all from robustness):** 16 concurrent connections, 30 req/s/IP rate limit, 2000 nodes max (banner shown when truncated), 60s per-connection timeout, parent-pid watch (exit on parent SIGKILL), 64 MB heap budget (warn over).

**Routes (read-only):**
- `GET /` — static HTML shell (Cytoscape via CDN+SRI)
- `GET /assets/*` — sandboxed under fixed root, reject `..` after normalisation (robustness)
- `GET /api/graph` — JSON: `{ nodes, edges, cycles, truncated, generatedAt }` from `br list --json` + `br dep list --json`
- `GET /api/bead/:id` — JSON of single bead via `br show <id> --json`

No `PATCH/POST/DELETE` handlers exist.

**Data layer (correctness's win — pure module):** `mcp-server/src/bead-graph.ts` exports `buildBeadGraph(listJson, depJson): BeadGraph`. Tarjan SCC for cycle detection, deterministic ordering (sorted by smallest id within each cycle) so test snapshots are stable.

**XSS defense (robustness's killer test):** Bead bodies are served as JSON, never inlined into HTML. Client-side Cytoscape consumes the JSON and renders. JSDOM regression test (`viewer-xss-bead-body.test.ts`) injects `<script>__pwn=1</script>` in a bead body, asserts `window.__pwn === undefined` after render.

**Cycle visualization (ergonomics-flavored):** Nodes colored by status (open=gray, in_progress=blue, closed=green, deferred=orange). Cycle edges rendered with `style: dashed` and a banner at top listing cycle IDs.

**Files touched:**
- New: `mcp-server/scripts/bead-viewer.ts`, `mcp-server/scripts/bead-viewer-assets/index.html`, `mcp-server/src/bead-graph.ts`, `commands/flywheel-bead-viewer.md`
- Modify: `mcp-server/package.json` (`bead-viewer` script)

---

## Bead breakdown (synthesized — atomic, dependency-graphed)

18 beads, eat-our-own-dogfood (every bead carries `estimatedEffort`).

| T# | Title | Template | depends_on | effort | Acceptance | Files touched |
|---|---|---|---|---|---|---|
| **T1** | Add `EstimatedEffort` type + `EFFORT_TO_MINUTES` constant + optional `BeadTemplate.estimatedEffort?` | `update-config` | [] | S | `EFFORT_LEVELS`, `EstimatedEffort`, `EFFORT_TO_MINUTES` exported with `@since v3.7.0` TSDoc; `tsc --noEmit` passes | `mcp-server/src/types.ts` |
| **T2** | Add new `FlywheelErrorCode`s: `remediation_unavailable`, `remediation_requires_confirm`, `remediation_failed`, `remediate_already_running`, `bundle_integrity_failed`, `bundle_stale`, `viewer_port_in_use` | `update-config` | [] | All codes have `DEFAULT_HINTS` + `DEFAULT_RETRYABLE` entries; `errors.schema.test.ts` exhaustiveness passes | `mcp-server/src/errors.ts` |
| **T3** | Backfill `estimatedEffort` on all built-in `BeadTemplate`s | `update-config` | [T1] | S | All 9 templates set; `validateTemplateIntegrity` returns no warnings; snapshot test re-recorded | `mcp-server/src/bead-templates.ts` |
| **T4** | Implement `buildBeadGraph` pure data layer + Tarjan SCC | `add-feature` | [] | M | Pure fn, no I/O; cycles list deterministic (sorted); handles empty/single-node/self-loop; `BeadGraph` shape exact | `mcp-server/src/bead-graph.ts` |
| **T5** | Implement `calibration-store.ts` pure stats fns + shared `br-parser.ts` | `add-feature` | [] | S | `mean`/`median`/`p95` handle empty/single/large; `br-parser` zod-validates `br list --json` rows | `mcp-server/src/calibration-store.ts`, `mcp-server/src/br-parser.ts` |
| **T6** | Implement `RemediationHandler` registry + dispatcher in `tools/remediate.ts` | `add-feature` | [T2] | M | Dispatcher TS-checks against full `DoctorCheckName` union; `null` entry returns `remediation_unavailable`; per-check mutex via `mutex.ts`; `.pi-flywheel/remediate.lock` cleanup in `try/finally` | `mcp-server/src/tools/remediate.ts` |
| **T7** | Implement 5 remediation handlers (one file each, with `verifyProbe`) | `add-feature` | [T6] | L | Each handler: idempotent re-run = no-op; mutating handlers refuse w/o `autoConfirm`; ships `verifyProbe`; `verifiedGreen` returned in envelope | `mcp-server/src/tools/remediations/{dist_drift,mcp_connectivity,agent_mail_liveness,orphaned_worktrees,checkpoint_validity}.ts` |
| **T8** | Register `flywheel_remediate` MCP tool + `orch_remediate` deprecated alias | `add-tool` | [T6] | S | Tool listed by `ListToolsRequestSchema`; alias auto-generated by existing `DEPRECATED_ALIAS_TOOLS` mapper; `server.test.ts` confirms registration | `mcp-server/src/server.ts` |
| **T9** | Update `skills/flywheel-doctor/SKILL.md` for inline remediation flow (per-check AskUserQuestion) | `add-documentation` | [T8] | S | Skill body lints clean; AskUserQuestion appears spatially adjacent to failing check row; `null`-mapped checks fall through to manual hint; CASS log line documented | `skills/flywheel-doctor/SKILL.md` |
| **T10** | Implement `flywheel_calibrate` tool + writeback to `.pi-flywheel/calibration.json` | `add-tool` | [T1, T3, T5] | M | Parses `br list --json --status closed`, applies `sinceDays` filter, prefers `firstCommitTs` via `git log --grep` (capped 200), drops malformed/skewed, computes rows, writes JSON; returns `cli_failure` on `br` exit non-zero | `mcp-server/src/tools/calibrate.ts`, `mcp-server/src/server.ts` |
| **T11** | Surface calibration in `commands/flywheel-status.md` (top 3, n≥3 gate) + inject into synthesis prompt (n≥5 only) | `add-integration` | [T10] | S | Status command renders ergonomics's mockup; synthesis prompt unit test passes; new fixture covers prompt with calibration data | `commands/flywheel-status.md`, `mcp-server/src/deep-plan-synthesis.ts` |
| **T12** | Implement `build-skills-bundle.ts` + `check-skills-bundle.ts` + wire into `npm run build` | `add-tool` | [] | M | Atomic write; per-entry `srcSha256`; aggregate `manifestSha256`; 5 MB / 200 KB caps enforced; `npm run check:skills-bundle` fails on hash mismatch | `mcp-server/scripts/build-skills-bundle.ts`, `mcp-server/scripts/check-skills-bundle.ts`, `mcp-server/package.json` |
| **T13** | Implement `flywheel_get_skill` tool with 4-layer drift defense + `FW_SKILL_BUNDLE=off` bypass | `add-tool` | [T2, T12] | M | Returns `source: 'bundle' \| 'disk'`; `bundle_integrity_failed` on `manifestSha256` mismatch falls back to disk; `bundle_stale: true` warns when entry `srcSha256` mismatches on-disk; env-bypass works | `mcp-server/src/skills-bundle.ts`, `mcp-server/src/tools/get-skill.ts`, `mcp-server/src/server.ts`, `skills/start/SKILL.md` |
| **T14** | Implement `bead-viewer.ts` HTTP server + static page (loopback + caps + parent-pid watch) | `add-tool` | [T4] | L | Binds `127.0.0.1:0` (or `--port N`); refuses non-loopback `FW_VIEWER_BIND`; opens browser via `open`/`xdg-open`/`start`; conn cap 16, rate 30/s, 2000 node cap; parent-death exits within 2s | `mcp-server/scripts/bead-viewer.ts`, `mcp-server/scripts/bead-viewer-assets/index.html`, `commands/flywheel-bead-viewer.md`, `mcp-server/package.json` |
| **T15** | Vitest specs for remediation (regression + chaos) | `add-test` | [T7, T8] | M | Table-driven exhaustiveness over `DOCTOR_CHECK_NAMES`; dry-run never invokes `exec` for mutating ops; idempotent re-run = no-op; `autoConfirm: false` mutating = `remediation_requires_confirm`; concurrent calls → `remediate_already_running`; mid-run abort cleans lock; fix-but-still-broken → `verifiedGreen: false` warn | `mcp-server/src/__tests__/tools/remediate.test.ts`, `mcp-server/src/__tests__/chaos/remediate-{kill-midrun,concurrent,fix-but-still-broken}.test.ts` |
| **T16** | Vitest specs for calibration (regression + chaos) | `add-test` | [T10] | M | Stats fns: empty/single/even-count median/p95 boundary; tool: synthetic `br list` fixture with mixed templated/untemplated/skewed/malformed; clock-skew dropped; corrupted cache → degrades gracefully; large dataset (5k beads) under 8s | `mcp-server/src/__tests__/calibration-store.test.ts`, `mcp-server/src/__tests__/tools/calibrate.test.ts`, `mcp-server/src/__tests__/chaos/calibrate-{empty,clock-skew,corrupt-cache,large-dataset}.test.ts` |
| **T17** | Vitest specs for skills bundle (parity + 4-layer drift defense) | `add-test` | [T13] | M | Parity: every bundle entry's body matches `fs.readFileSync(entry.path)` minus frontmatter; corrupted bundle → disk fallback (`source: 'disk'`); stale entry → `bundle_stale: true` log fires; not-found → proper envelope; `FW_SKILL_BUNDLE=off` always reads disk | `mcp-server/src/__tests__/skills-bundle.test.ts`, `mcp-server/src/__tests__/chaos/bundle-{corrupt-fallback,stale-warns,not-found}.test.ts` |
| **T18** | Vitest specs for bead-viewer (data layer + security chaos) | `add-test` | [T14] | M | Data layer: round-trip serialization, cycle on 3-node + disjoint subgraphs + no-edge, deterministic ordering snapshot; security: XSS bead body via JSDOM render, port collision retry, `FW_VIEWER_BIND=0.0.0.0` refused, path-traversal 403, parent-death exit within 2s | `mcp-server/src/__tests__/bead-graph.test.ts`, `mcp-server/src/__tests__/chaos/viewer-{xss,port-collision,bind-localhost,path-traversal,parent-death}.test.ts` |

**Total estimated effort:** 5×S + 9×M + 2×L = 150 + 810 + 480 = **1440 minutes ≈ 24h focused work**.
**Critical path:** T2 → T6 → T7 → T15 = 30 + 90 + 240 + 90 = 450 min ≈ 7.5h.
**Parallelization opportunity:** T1, T2, T4, T5, T12, T14 (after T4) are all roots — 6 swarm agents can start immediately.

---

## Test plan (unified)

All vitest, no new framework. New chaos tests live under `mcp-server/src/__tests__/chaos/` following the `_helpers.ts` (`makeExecFn`, `makeTmpCwd`) pattern from existing `doctor-kill-midrun.test.ts`.

| Tool | Test files | Strategy | NOT tested |
|---|---|---|---|
| `flywheel_remediate` | `tools/remediate.test.ts` + `chaos/remediate-*.test.ts` | Mock `ExecFn` + `FsLike` per handler. Table-driven exhaustiveness over `DOCTOR_CHECK_NAMES`. Chaos: kill-midrun, concurrent (mutex), fix-but-still-broken (`verifiedGreen` warn), unknown check, headless w/o autoConfirm. | Real CLI invocation. Real worktree manipulation. |
| `flywheel_calibrate` | `tools/calibrate.test.ts` + `calibration-store.test.ts` + `chaos/calibrate-*.test.ts` | Synthetic `br list --json` fixture under `scripts/fixtures/calibration/`. Stats fns isolated. Chaos: empty data (no NaN), clock-skew dropped, corrupt cache regenerates, 5k bead dataset under 8s. | Real `br` CLI invocation. Cross-cwd aggregation. |
| `flywheel_get_skill` | `skills-bundle.test.ts` + `tools/get-skill.test.ts` + `chaos/bundle-*.test.ts` | Build bundle in test setup, parity body-by-body. Delete bundle → disk fallback (`source: 'disk'`). Corrupt bundle → integrity failure + fallback. Edit source `.md` → `bundle_stale: true` log. `FW_SKILL_BUNDLE=off` always disk. | Bundle generation under concurrent tsc. |
| `bead-viewer` | `bead-graph.test.ts` + `chaos/viewer-*.test.ts` | Pure data layer: serialization, cycle detection, ordering snapshots. Security chaos: XSS via JSDOM render (assert `window.__pwn === undefined`), port collision (`+1..+9` retry), `FW_VIEWER_BIND=0.0.0.0` refused, `..` path traversal 403, parent-death exit within 2s. | HTTP E2E. Browser rendering beyond JSDOM. CDN reachability. |

---

## Risk register (unified)

Severity: **H** = High, **M** = Medium, **L** = Low.

| # | Risk | Sev | Source | Mitigation |
|---|---|---|---|---|
| R1 | Extending `DOCTOR_CHECK_NAMES` later silently leaves new checks unhandled | H | C | `Record<DoctorCheckName, RemediationHandler \| null>` typing + `assertExhaustive(_: never)` in default → TS compile error. |
| R2 | Remediation handler kills user state (wrong worktree, lost checkpoint) | H | C+R | (a) `dry_run` default; (b) mutating handlers require `autoConfirm: true`; (c) `checkpoint_validity` writes `.bak` before unlink; (d) `orphaned_worktrees` enumerates first, removes per-entry; (e) per-check mutex prevents concurrent clobber. |
| R3 | Handler exits 0 but doctor still red ("fix-but-still-broken") | H | R | Every handler ships `verifyProbe`; result envelope includes `verifiedGreen`; warn log fires on mismatch. |
| R4 | Mid-apply abort leaves lock + half-written tmp | H | R | `try/finally` removes `.pi-flywheel/remediate.lock`; atomic `tmp → fsync → rename` writes; chaos test asserts cleanup. |
| R5 | Concurrent remediate calls clobber each other | M | R | Per-check mutex via `mcp-server/src/mutex.ts`; second caller returns `remediate_already_running`. |
| R6 | `dist/skills.bundle.json` drift between source `.md` and bundle (the gotcha that bit this session) | H | C+R | 4-layer defense: build-time `check:skills-bundle` (CI gate); runtime `manifestSha256` integrity check + disk fallback; per-entry `srcSha256` stale-warn; `FW_SKILL_BUNDLE=off` dev bypass. |
| R7 | Bundle hides live edits during active skill development | M | E | `FW_SKILL_BUNDLE=off` env-var bypass; documented in AGENTS.md; per-entry stale warn surfaces drift even when bundle is loaded. |
| R8 | Bead-viewer binds non-loopback, exposes data on LAN | H | C+R | Hardcoded `127.0.0.1`; startup assertion refuses `FW_VIEWER_BIND` ≠ `127.0.0.1`; chaos test verifies refusal. |
| R9 | XSS via bead body in viewer | H | R | Bead bodies served as JSON, client-side Cytoscape consumes; never inlined HTML; JSDOM regression test asserts `window.__pwn === undefined`. |
| R10 | Path traversal in viewer static assets | M | R | Resolve under fixed root; reject `..` after normalisation; chaos test asserts 403. |
| R11 | Calibration p95 over tiny samples (n=1, n=2) misleading | M | C+E | Surface `sampleCount` per row; rows w/ `n < 5` flagged `lowConfidence: true` and excluded from synthesizer prompt; status command renders `(n=K)` suffix; `n < 3` rows omitted entirely. |
| R12 | Inflated calibration durations (open-then-quick-close) | M | R | Prefer `firstCommitTs` via `git log --grep=<bead-id>` as `started_ts` proxy; fall back to `created_ts` w/ `proxy_started: false` tag. |
| R13 | Clock skew → negative durations poison mean | M | C+R | Drop samples where `closed_ts < started_ts`; increment `droppedBeads` counter surfaced in report. |
| R14 | Untemplated legacy beads (pre-v3.4.x) pollute calibration | M | C | Bucket under `__untemplated__`, exclude from per-template ratios, surface count separately. |
| R15 | Cold-repo calibration table looks broken | M | E | Gate entirely on total closed `>= 3`; dim line "3+ beads needed" below threshold. |
| R16 | Large bead dataset (10k+) hangs viewer / calibrate | M | R | Calibrate: hard cap 5000 beads + 8s timeout. Viewer: cap 2000 nodes + banner when truncated. |
| R17 | Viewer port collision (EADDRINUSE) | L | E+R | Default `127.0.0.1:0` (ephemeral); `--port N` flag with `+1..+9` retry; `viewer_port_in_use` if all blocked. |
| R18 | Cytoscape CDN load fails → page blank | L | C | SRI hash on `<script>`; `<noscript>` fallback message pointing to `--json` flag. |
| R19 | Viewer parent process dies → orphan server | M | R | Watch `process.ppid`; exit on parent disconnection; chaos test verifies <2s exit. |
| R20 | Bundle file size grows unboundedly | L | R | 5 MB total + 200 KB per-entry caps in bundler; build fails over cap with actionable error. |
| R21 | Bundle corrupted (truncated JSON, disk full) | M | R | Zod validation on load; on parse failure → `bundle_integrity_failed` log + disk fallback. |
| R22 | Adding 7 new error codes breaks hint exhaustiveness | M | C | T2 updates `DEFAULT_HINTS` + `DEFAULT_RETRYABLE` in same commit; `errors.schema.test.ts` enforces exhaustiveness. |

---

## Wave structure (for parallel impl)

**Wave 0 — Foundations (T1, T2, T4, T5, T12, T14*).** All have `depends_on: []`. T14 has soft dep on T4 but its scaffold (HTTP server, asset serving, port logic) can start immediately and integrate `buildBeadGraph` once T4 lands. **6 swarm agents** can run in parallel.

**Wave 1 — Per-feature core (T3 → T6 → T10, T7, T13).** Foundations unblock: T3 (templates) needs T1; T6 (remediate dispatcher) needs T2; T7 (5 handlers) needs T6; T10 (calibrate) needs T1+T3+T5; T13 (get-skill) needs T2+T12. **5 parallel tracks.**

**Wave 2 — Wiring & SKILL integration (T8, T9, T11).** T8 registers `flywheel_remediate`; T9 updates doctor SKILL; T11 surfaces calibration in status command + synthesis prompt. **3 parallel tracks.**

**Wave 3 — Tests (T15, T16, T17, T18).** All test beads run in parallel after their corresponding feature lands. **4 parallel tracks.**

**Why this ordering:** Foundations are non-trivial-but-decoupled (types, errors, pure data layers) — landing them first unblocks every downstream bead. Per-feature core lands serially within feature but parallel across features. Tests last so we test the integrated surface, not stubs.

---

## Open questions for the user (alignment-check seeds)

Each question is a load-bearing decision; the coordinator will pick 2–4 to ask via AskUserQuestion. Phrasing is concrete, with the synthesis recommendation noted in parens.

1. **Q1 — Remediate tool granularity.** Ship `flywheel_remediate({ checkName: DoctorCheckName })` as a single dispatcher tool (synthesis recommendation: yes — strict union schema, easy to extend), OR one tool per check (`flywheel_remediate_dist_drift`, `flywheel_remediate_orphaned_worktrees`, etc., for clearer agent affordances)? *Single dispatcher means `tools/list` stays compact; per-check means each fix is independently discoverable but balloons the tool surface from 12 to 17+.*

2. **Q2 — Calibration started_ts source.** Should calibration prefer `firstCommitTs` from `git log --grep=<bead-id>` as the `started_ts` proxy (synthesis recommendation: yes, capped at 200 git calls per run — measures "real work time"), OR stick with `created_ts` from `br list --json` (simpler, deterministic, but inflated by open-and-sit beads)? *The git-log proxy is more accurate but adds shell-out cost and depends on disciplined commit message hygiene.*

3. **Q3 — Skill bundle stale behavior.** When a bundled skill's `srcSha256` no longer matches the on-disk source `.md`, should the loader serve the bundle and emit a `bundle_stale: true` warn (synthesis recommendation: yes — stability over liveness in production), OR refuse to serve and force a rebuild (safer but breaks contributor flow without `FW_SKILL_BUNDLE=off`)? *Robustness wants safety, ergonomics wants flow. Recommendation threads the needle: bundle wins on the green path, contributors set the env-bypass.*

4. **Q4 — Bead-viewer port strategy.** Default to `127.0.0.1:0` (ephemeral OS-assigned, URL printed at startup — synthesis recommendation), OR fixed `127.0.0.1:7331` with `+1..+9` retry (memorable URL, but collision risk on dev machines)? *Ergonomics wants memorable; correctness wants no surprises; robustness wants explicit retry. Ephemeral default + `--port N` flag covers all three.*

5. **Q5 — Effort calibration scope of action.** Should the synthesizer **automatically rewrite** bead `estimatedEffort` based on calibration ratios (e.g. `M → L` when ratio ≥ 1.3×, with a `(calibrated: M→L, ratio 1.4×)` annotation — ergonomics's flow), OR only **inject calibration into the prompt** and let the synthesizer decide (synthesis recommendation: prompt injection only — distorts historical data less, keeps synthesizer in control)? *Ergonomics wants the auto-bump for visible value; correctness's non-goal #3 explicitly rejects bead mutation. The prompt-injection middle-ground gives the synthesizer the info without rewriting beads.*

---

**End of synthesized plan.**
