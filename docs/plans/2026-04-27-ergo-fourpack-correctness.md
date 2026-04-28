# Ergonomic Four-Pack — Correctness Perspective Plan

**Date:** 2026-04-27
**Perspective:** correctness (type safety, schema integrity, error contracts, idempotency, test coverage, backward compatibility)
**Target version:** agent-flywheel v3.6.11 → v3.7.0
**Repo:** `/Volumes/1tb/Projects/agent-flywheel`

This plan is one of multiple perspective drafts for a deep-plan synthesizer to merge.
It does not propose UX flourishes, telemetry expansion, or performance work beyond
what is required for type-correctness and forward compatibility.

---

## 1. Architecture Decisions

### 1.1 Inline doctor remediation — `flywheel_remediate`

**File boundaries:**
- New module: `mcp-server/src/tools/remediate.ts` — pure dispatcher, no I/O of its own.
- New module: `mcp-server/src/tools/remediations/` — one file per check (`mcp_connectivity.ts`, `agent_mail_liveness.ts`, `dist_drift.ts`, `orphaned_worktrees.ts`, `checkpoint_validity.ts`, `codex_config_compat.ts`). Each exports a uniform `Remediation` interface.
- Touch: `mcp-server/src/server.ts` (TOOLS array + `DEFAULT_RUNNERS`), `mcp-server/src/types.ts` (shared types), `mcp-server/src/tools/doctor.ts` (re-export `DOCTOR_CHECK_NAMES` already public).
- SKILL: `skills/flywheel-doctor/SKILL.md` lines 60–77 → add a "Remediation invocation" subsection that calls the new tool per failing check with `AskUserQuestion`.

**Type/schema design:**

```ts
// mcp-server/src/types.ts (new exports)
export type RemediationMode = 'dry_run' | 'execute';

export interface RemediationStep {
  description: string;          // human-readable; rendered to user before exec
  command?: string;             // shell command (optional — some fixes are FS ops)
  filesTouched?: readonly string[]; // for idempotency manifest
}

export interface RemediationPlan {
  check: DoctorCheckName;
  reversible: boolean;          // gates auto-confirm requirement
  steps: readonly RemediationStep[];
  rationale: string;            // why this is the canonical fix
}

export interface RemediationResult {
  check: DoctorCheckName;
  mode: RemediationMode;
  plan: RemediationPlan;
  executed: boolean;            // false in dry_run or if user declined
  stepsRun: number;             // partial-completion-aware
  stdout?: string;              // last step's stdout, truncated to 4 KiB
  stderr?: string;              // last step's stderr, truncated to 4 KiB
  durationMs: number;
}
```

```ts
// Zod schema (mcp-server/src/tools/remediate.ts)
const RemediateInputSchema = z.object({
  cwd: z.string().min(1),
  checkName: z.enum(DOCTOR_CHECK_NAMES),
  autoConfirm: z.boolean().optional().default(false),
  mode: z.enum(['dry_run', 'execute']).optional().default('dry_run'),
});
```

**Encoding decision — lookup map vs polymorphic functions:** use a `Record<DoctorCheckName, RemediationHandler | null>` lookup map in `remediate.ts`. Rationale:
- Exhaustiveness check at compile time: TypeScript flags any missing key when `DOCTOR_CHECK_NAMES` grows.
- `null` entries explicitly mark "no automated fix" (e.g. `node_version`, `git_status`, `gemini_cli`) — the tool returns `unsupported_action` with a hint.
- Avoids polymorphic class hierarchies; each handler is `(ctx: RemediationCtx) => Promise<RemediationResult>` — easier to mock per-handler in vitest.

**Handler contract:**
```ts
export type RemediationHandler = (ctx: {
  cwd: string;
  exec: ExecFn;        // injected; same ExecFn type used by doctor.ts
  fs: FsLike;          // narrow interface — readFile, writeFile, stat, unlink
  mode: RemediationMode;
  signal: AbortSignal;
  now: () => number;
}) => Promise<RemediationResult>;
```

**Idempotency model:**
- All handlers MUST be re-runnable. Re-run that finds nothing-to-do returns `executed: false, stepsRun: 0` with `plan.steps[].description` reading "No-op: already healthy".
- Any handler that mutates files outside `.pi-flywheel/` MUST set `reversible: false` and refuse to run with `autoConfirm: false` unless `mode === 'dry_run'`.
- `dist_drift` rebuild handler runs `npm --prefix mcp-server run build` — wraps `exec` with a 120 s timeout (exceeds default but bounded).
- `orphaned_worktrees` removal handler enumerates first, returns the planned set in `dry_run`, then in `execute` mode iterates `git worktree remove --force` per entry. Each removal is independently logged so partial failures are recoverable.
- `checkpoint_validity` writes `.pi-flywheel/checkpoint.json.bak` before unlinking — recoverable for 1 session.

**Error envelope:**
- All failures return `FlywheelError` results via `makeFlywheelErrorResult`. New error code (added to `FLYWHEEL_ERROR_CODES`): `remediation_unavailable` (no handler for check), `remediation_requires_confirm` (mutating action attempted with `autoConfirm: false` and `mode !== 'dry_run'`), `remediation_failed` (handler threw or step exited non-zero).
- Existing `cli_failure`, `exec_timeout`, `exec_aborted` reused for shell-out failures inside handlers.
- Hint for `remediation_requires_confirm` MUST tell agent to re-call with `autoConfirm: true` after user assent — NEVER auto-set.

### 1.2 Plan estimation calibration — `flywheel_calibrate`

**File boundaries:**
- Modify: `mcp-server/src/types.ts` — add `EstimatedEffort` type and optional field on `BeadTemplate`.
- Modify: `mcp-server/src/bead-templates.ts` — populate `estimatedEffort` on each of the ~9 built-in templates (single-line additions inside `defineTemplate({...})` calls).
- New: `mcp-server/src/tools/calibrate.ts` — aggregator + Zod schema + tool runner.
- New: `mcp-server/src/calibration-store.ts` — pure functions for stats math (mean/median/p95) so they're easy to unit-test in isolation.
- Touch: `mcp-server/src/server.ts` (registration), `commands/flywheel-status.md` (render the table).
- Touch: `mcp-server/src/deep-plan-synthesis.ts` — inject calibration table into the synthesis prompt so the synthesizer learns from history.

**Type design — making `estimatedEffort` non-breaking:**
```ts
// types.ts
export const EFFORT_LEVELS = ['S', 'M', 'L', 'XL'] as const;
export type EstimatedEffort = (typeof EFFORT_LEVELS)[number];

// Canonical mapping used by calibrate when comparing estimate vs actual.
// Stable; promoted to a const so the synthesis prompt sees the same numbers.
export const EFFORT_TO_MINUTES: Record<EstimatedEffort, number> = {
  S: 30,
  M: 90,
  L: 240,
  XL: 720,
};

export interface BeadTemplate {
  // ...existing fields
  /**
   * Median expected wall-clock effort. OPTIONAL — legacy templates without
   * this field are treated as `M` (90 min) by `flywheel_calibrate`.
   * @since v3.7.0
   */
  estimatedEffort?: EstimatedEffort;
}
```

**Backward compatibility — bead bodies without `template:` field:**
Beads created before v3.4.x do not carry the `template:` hint in their body. Calibration MUST tolerate this:
- Group all such beads under the synthetic key `__untemplated__` and exclude from per-template ratios.
- Surface a single line in the report: `__untemplated__: N closed beads (excluded from calibration)`.
- Never emit `not_found` for missing template id; the registry lookup uses `getTemplateById(id) ?? null`.

**Aggregation rules:**
- `created_ts` and `closed_ts` come from `br list --json --status closed` per bead. If either field is missing OR `closed_ts < created_ts` (clock skew), drop that bead and increment a `dropped` counter. Surface `dropped` in the report for transparency — never silently swallow.
- `sinceDays` filter applies to `closed_ts`, default `90` (capped at 365 to keep memory bounded).
- Stats: mean, median, p95 in **minutes**. Ratio = median_actual_minutes / EFFORT_TO_MINUTES[template.estimatedEffort ?? 'M'].
- Return shape:
```ts
export interface CalibrationRow {
  templateId: string;
  templateVersion: number;        // pinning (templates can have @v1, @v2)
  estimatedEffort: EstimatedEffort | null;  // null = legacy/unknown
  estimatedMinutes: number;
  sampleCount: number;
  meanMinutes: number;
  medianMinutes: number;
  p95Minutes: number;
  ratio: number;                  // medianMinutes / estimatedMinutes
}
export interface CalibrationReport {
  cwd: string;
  sinceDays: number;
  generatedAt: string;            // ISO
  totalBeadsConsidered: number;
  droppedBeads: number;
  rows: CalibrationRow[];         // sorted by ratio descending (worst first)
  untemplated: { count: number };
}
```

**Schema:**
```ts
const CalibrateInputSchema = z.object({
  cwd: z.string().min(1),
  sinceDays: z.number().int().min(1).max(365).optional().default(90),
});
```

**Synthesis prompt integration:** `deep-plan-synthesis.ts` builds its prompt by concatenating sections. Insert a new optional section "## Past calibration" that consumes a `CalibrationReport` if one is on disk at `.pi-flywheel/calibration.json`. The calibrate tool writes that file as a side effect. Synthesizer never invokes calibrate directly (avoids tool dependency).

### 1.3 Skill markdown precompilation — `flywheel_get_skill`

**File boundaries:**
- New: `mcp-server/scripts/build-skills-bundle.ts` — walks `skills/**/SKILL.md` and `skills/start/_*.md`, parses frontmatter via existing `gray-matter`-equivalent or hand-rolled YAML-front (the repo already uses `unified` + `remark-parse` per package.json; reuse).
- New: `mcp-server/src/skills-bundle.ts` — runtime loader with disk fallback. Exports `loadSkillsBundle(): Promise<SkillsBundle>` and `getSkill(name): Promise<SkillContent>`.
- New: `mcp-server/src/tools/get-skill.ts` — Zod schema + tool runner.
- Modify: `mcp-server/package.json` `scripts.build` to chain `&& tsx scripts/build-skills-bundle.ts`.
- Modify: `mcp-server/src/server.ts` (registration).
- Output: `mcp-server/dist/skills.bundle.json` (committed alongside `dist/server.js`).

**Bundle shape:**
```ts
export interface SkillBundleEntry {
  name: string;                   // "<plugin>:<skill-name>" e.g. "agent-flywheel:start"
  path: string;                   // repo-relative source path for cross-checks
  frontmatter: { name: string; description?: string; [k: string]: unknown };
  body: string;                   // markdown body after frontmatter
  bodyHash: string;               // sha-256 of body — drift detection
  bundledAt: string;              // ISO
}
export interface SkillsBundle {
  bundleVersion: 1;
  generatedAt: string;
  generator: string;              // "build-skills-bundle.ts vN"
  entries: SkillBundleEntry[];
}
```

**Disk fallback semantics:**
- `getSkill(name)` first checks the in-memory bundle (loaded once at server start, cached). If the bundle file is missing OR the requested name is absent, it reads the source `.md` from disk and **logs a warning** via `logger.warn` (no fallback noise on green path).
- Disk read uses the same path resolution rules as the bundler so contributors editing skills in dev mode see immediate updates without rebuild.
- Tool input schema:
```ts
const GetSkillInputSchema = z.object({
  name: z.string().regex(/^[a-z0-9_-]+:[a-z0-9_-]+$/),
});
```
- Returns `{ name, frontmatter, body, source: 'bundle' | 'disk' }`. The `source` field is the contract for tests asserting fallback behavior.
- Errors: `not_found` if neither bundle nor disk yields a match.

**Drift gotcha mitigation:** the bundler computes `bodyHash` for every entry; an additional `npm run check:skills-bundle` script (added to `scripts`) re-walks the source tree and compares hashes against `dist/skills.bundle.json`. CI runs this before tests; if hashes diverge, the script exits non-zero. This addresses the dist-drift gotcha that hit this session.

### 1.4 Web-based bead-graph visualizer

**File boundaries:**
- New: `mcp-server/scripts/bead-viewer.ts` — Node CLI (uses `node:http`, `node:fs/promises`, `node:child_process`). No external runtime deps.
- New: `mcp-server/scripts/bead-viewer-assets/index.html` — single static HTML file with embedded CSS and Cytoscape.js loaded via CDN. Read at server start, parameter-substituted.
- New: `mcp-server/src/bead-graph.ts` — pure data layer. `buildBeadGraph(listJson, depJson): BeadGraph` returns nodes + edges + cycle annotations. Tested without HTTP.
- Modify: `mcp-server/package.json` — add `"bead-viewer": "tsx scripts/bead-viewer.ts"`.
- New: `commands/flywheel-bead-viewer.md` — slash-command thin wrapper that runs `npm --prefix mcp-server run bead-viewer`.

**Minimal-deps strategy:** zero new package.json deps. Cytoscape.js loaded via `<script src="https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js">` from the static HTML — the page is loaded by a human browser, not the server, so this is a transitive concern only. SRI hash pinned. No React, no bundler, no JSX.

**Server contract:**
- HTTP server binds `127.0.0.1:0` (ephemeral port) by default, prints `http://127.0.0.1:<port>` to stdout, opens via `open` (macOS), `xdg-open` (linux), `start` (windows). Use `child_process.spawn` detached; never block on browser exit.
- Read-only: no PATCH/POST/DELETE handlers. Only `GET /` (HTML), `GET /api/graph` (JSON), `GET /api/bead/:id` (single bead body via `br show <id> --json`).
- `/api/graph` runs `br list --json` + `br dep list --json` once per request (no caching beyond HTTP), pipes through `buildBeadGraph`. Server crashes do not leak the page; `process.on('SIGINT')` and `SIGTERM` close the server cleanly.
- Bind only to loopback. Never `0.0.0.0`. Document this constraint in the script header.

**Data shape:**
```ts
export interface BeadGraphNode {
  id: string;
  title: string;
  status: 'open' | 'in_progress' | 'closed' | 'deferred' | 'blocked';
  priority: number;
  template?: string;
}
export interface BeadGraphEdge {
  from: string;                   // depender id
  to: string;                     // dependee id
  type: 'blocks' | 'related';
}
export interface BeadGraph {
  nodes: BeadGraphNode[];
  edges: BeadGraphEdge[];
  cycles: ReadonlyArray<readonly string[]>;  // each cycle is ordered ids
  generatedAt: string;
}
```

**Cycle detection:** Tarjan's SCC implementation in `bead-graph.ts`. Any SCC with size > 1 is a cycle. Output is a stable list (sorted by smallest id within each cycle) so test snapshots are deterministic.

---

## 2. Bead Breakdown

15 beads, dependency-graphed. Eat-our-own-dogfood: every bead carries `estimatedEffort` (feature 2's new field).

### Foundation (no cross-feature dependencies)

**T1 — Add `EstimatedEffort` type + `EFFORT_TO_MINUTES` constant**
- Template: `add-feature` (despite small size — it adds public exports)
- Effort: S (30 min)
- Files: `mcp-server/src/types.ts`
- Acceptance: `EFFORT_LEVELS`, `EstimatedEffort`, `EFFORT_TO_MINUTES` all exported. `BeadTemplate.estimatedEffort?: EstimatedEffort` added with TSDoc `@since v3.7.0`. `tsc --noEmit` passes.
- depends_on: []

**T2 — Add `remediation_unavailable`, `remediation_requires_confirm`, `remediation_failed` error codes**
- Template: `update-config`
- Effort: S (30 min)
- Files: `mcp-server/src/errors.ts` (extend `FLYWHEEL_ERROR_CODES`, `DEFAULT_HINTS`, `DEFAULT_RETRYABLE`).
- Acceptance: All three codes have non-empty default hints, schema test in `errors.schema.test.ts` continues to pass after exhaustiveness update.
- depends_on: []

**T3 — Populate `estimatedEffort` on all built-in bead templates**
- Template: `update-config`
- Effort: S (30 min)
- Files: `mcp-server/src/bead-templates.ts` (~9 templates: `add-feature`, `add-tool`, `update-config`, `add-test`, `fix-bug`, `add-documentation`, `improve-performance`, `add-integration`, plus any others discovered in `BUILTIN_TEMPLATES`).
- Acceptance: every template has `estimatedEffort` set; `tsc --noEmit` passes; `validateTemplateIntegrity` returns no warnings.
- depends_on: [T1]

### Feature 1 — Inline doctor remediation

**T4 — Implement `RemediationHandler` lookup table + dispatcher**
- Template: `add-feature`
- Effort: M (90 min)
- Files: `mcp-server/src/tools/remediate.ts` (Zod schema, dispatcher, `Record<DoctorCheckName, RemediationHandler | null>` table with TODO placeholders).
- Acceptance: dispatcher type-checks against full `DoctorCheckName` union; calling with `null`-mapped check returns `remediation_unavailable`; calling with unknown check returns Zod validation error.
- depends_on: [T2]

**T5 — Implement remediation handlers (5 deterministic fixes)**
- Template: `add-feature`
- Effort: L (240 min)
- Files: `mcp-server/src/tools/remediations/dist_drift.ts`, `mcp_connectivity.ts`, `agent_mail_liveness.ts`, `orphaned_worktrees.ts`, `checkpoint_validity.ts`. (6th candidate `codex_config_compat.ts` deferred to non-goals.)
- Acceptance: each handler implements idempotency rule (re-run no-op returns `executed: false, stepsRun: 0`); each declares `reversible` correctly; mutating handlers refuse with `remediation_requires_confirm` when called without `autoConfirm: true` in `execute` mode.
- depends_on: [T4]

**T6 — Register `flywheel_remediate` MCP tool**
- Template: `add-tool`
- Effort: S (30 min)
- Files: `mcp-server/src/server.ts` (TOOLS array entry, `DEFAULT_RUNNERS` map entry, name added to `FlywheelToolName` union — confirm via `tsc`).
- Acceptance: `flywheel_remediate` listed by `ListToolsRequestSchema` handler; deprecated alias `orch_remediate` auto-generated by existing `DEPRECATED_ALIAS_TOOLS` mapper; integration test in `server.test.ts` confirms registration.
- depends_on: [T4]

**T7 — Update `skills/flywheel-doctor/SKILL.md` for remediation flow**
- Template: `add-documentation`
- Effort: S (30 min)
- Files: `skills/flywheel-doctor/SKILL.md` lines 60–77 (replace the static remediation flowchart with an `AskUserQuestion` loop calling `flywheel_remediate` per failing check).
- Acceptance: skill body lints clean (`npm run lint:skill`); manual rendering shows the new "Fix it now?" prompt; flowchart still falls back to manual one-line fix for `null`-mapped checks.
- depends_on: [T6]

**T8 — Vitest specs for remediation**
- Template: `add-test`
- Effort: M (90 min)
- Files: `mcp-server/src/__tests__/tools/remediate.test.ts`.
- Acceptance: covers (a) every check in `DOCTOR_CHECK_NAMES` either dispatches or returns `remediation_unavailable` (table-driven); (b) `dry_run` never invokes `exec` for mutating ops; (c) idempotent re-run returns `executed: false`; (d) `autoConfirm: false` + mutating handler returns `remediation_requires_confirm`; (e) handler timeout maps to `exec_timeout`. Mock `ExecFn` and `FsLike` per-test.
- depends_on: [T5, T6]

### Feature 2 — Calibration

**T9 — Implement stats functions in `calibration-store.ts`**
- Template: `add-feature`
- Effort: S (30 min)
- Files: `mcp-server/src/calibration-store.ts`.
- Acceptance: pure functions `mean`, `median`, `p95` handle empty arrays (return `0`), single-element, and large samples; no I/O in this module.
- depends_on: []

**T10 — Implement `flywheel_calibrate` tool runner + register**
- Template: `add-tool`
- Effort: M (90 min)
- Files: `mcp-server/src/tools/calibrate.ts`, `mcp-server/src/server.ts` (TOOLS + runner registration).
- Acceptance: parses `br list --json --status closed`, applies `sinceDays` filter, groups by template, drops malformed, computes `CalibrationRow[]`, writes to `.pi-flywheel/calibration.json` (mkdirp), returns `CalibrationReport`. Untemplated beads aggregated separately. Returns `cli_failure` on `br` exit non-zero.
- depends_on: [T1, T3, T9]

**T11 — Surface calibration in `commands/flywheel-status.md` and synthesis prompt**
- Template: `add-integration`
- Effort: S (30 min)
- Files: `commands/flywheel-status.md` (add step 6 "Calibration" rendering top-3 worst ratios), `mcp-server/src/deep-plan-synthesis.ts` (read `.pi-flywheel/calibration.json` if present, splice into prompt section "## Past calibration").
- Acceptance: synthesis prompt unit test (existing fixture) still passes; new fixture covers prompt with calibration data.
- depends_on: [T10]

**T12 — Vitest specs for calibration**
- Template: `add-test`
- Effort: M (90 min)
- Files: `mcp-server/src/__tests__/tools/calibrate.test.ts`, `mcp-server/src/__tests__/calibration-store.test.ts`.
- Acceptance: synthetic `br list` JSON fixture with mixed templated/untemplated/malformed beads exercises grouping, dropping, ratio math; stats functions covered for edge cases (empty, single, even-count median, p95 boundary).
- depends_on: [T10]

### Feature 3 — Skills bundle

**T13 — Implement `build-skills-bundle.ts` script + wire into `npm run build`**
- Template: `add-tool`
- Effort: M (90 min)
- Files: `mcp-server/scripts/build-skills-bundle.ts`, `mcp-server/scripts/check-skills-bundle.ts`, `mcp-server/package.json` (`build` chain + new `check:skills-bundle` script + new `tsconfig.scripts.json` already includes `scripts/**`).
- Acceptance: post-build `mcp-server/dist/skills.bundle.json` exists with one entry per `skills/**/SKILL.md` plus `skills/start/_*.md`. `npm run check:skills-bundle` exits 0 on a fresh build, non-zero after editing a source `.md` without rebuild.
- depends_on: []

**T14 — Implement `flywheel_get_skill` tool with disk fallback**
- Template: `add-tool`
- Effort: M (90 min)
- Files: `mcp-server/src/skills-bundle.ts` (loader + cache + fallback), `mcp-server/src/tools/get-skill.ts` (Zod + runner), `mcp-server/src/server.ts` (registration).
- Acceptance: tool returns `source: 'bundle'` when bundle present and contains entry; returns `source: 'disk'` and emits `logger.warn` when bundle missing or entry absent; returns `not_found` when neither path resolves; name validation rejects malformed inputs at Zod boundary.
- depends_on: [T13]

**T15 — Vitest specs for skills bundle (parity + fallback)**
- Template: `add-test`
- Effort: M (90 min)
- Files: `mcp-server/src/__tests__/skills-bundle.test.ts`, `mcp-server/src/__tests__/tools/get-skill.test.ts`.
- Acceptance: parity test loads every entry from a freshly built bundle and asserts `body === fs.readFileSync(entry.path)` minus frontmatter; fallback test deletes bundle file and asserts `getSkill` still returns content with `source: 'disk'`; not-found test asserts proper `FlywheelError` with `not_found`.
- depends_on: [T14]

### Feature 4 — Bead-graph visualizer

**T16 — Implement `buildBeadGraph` data layer + Tarjan SCC**
- Template: `add-feature`
- Effort: M (90 min)
- Files: `mcp-server/src/bead-graph.ts`.
- Acceptance: pure function, no I/O; cycles list is deterministic (sorted); handles empty input, single-node, self-loop edge case; returns `BeadGraph` shape exactly as specified.
- depends_on: []

**T17 — Implement `bead-viewer.ts` HTTP server + static page**
- Template: `add-tool`
- Effort: L (240 min)
- Files: `mcp-server/scripts/bead-viewer.ts`, `mcp-server/scripts/bead-viewer-assets/index.html`, `commands/flywheel-bead-viewer.md`, `mcp-server/package.json` (`bead-viewer` script).
- Acceptance: `npm run bead-viewer` binds loopback ephemeral port, serves graph JSON and static HTML, opens browser; `Ctrl-C` exits cleanly within 1 s; no external runtime deps installed (`npm ls` shows zero new entries).
- depends_on: [T16]

**T18 — Vitest specs for bead graph data layer**
- Template: `add-test`
- Effort: S (30 min)
- Files: `mcp-server/src/__tests__/bead-graph.test.ts`.
- Acceptance: serialization round-trip (graph → JSON → parse → equal); cycle detection on 3-node cycle, disjoint subgraphs, no-edge graph; deterministic ordering snapshot.
- depends_on: [T16]

---

## 3. Test Plan

| Tool | Test file | Strategy | NOT tested |
|------|-----------|----------|------------|
| `flywheel_remediate` | `__tests__/tools/remediate.test.ts` | Mock `ExecFn` + `FsLike` per handler. Table-driven exhaustiveness over `DOCTOR_CHECK_NAMES`. Assert idempotency, dry-run safety, confirm gating. | Real CLI invocation. Real worktree manipulation. |
| `flywheel_calibrate` | `__tests__/tools/calibrate.test.ts` + `__tests__/calibration-store.test.ts` | Synthetic `br list --json` fixture (in `scripts/fixtures/` alongside existing). Stats fns tested in isolation. | Real `br` invocation in CI. Cross-cwd aggregation. |
| `flywheel_get_skill` | `__tests__/skills-bundle.test.ts`, `__tests__/tools/get-skill.test.ts` | Build bundle in test setup, assert parity body-by-body. Delete bundle, assert disk fallback. | Bundle generation under concurrent tsc invocations. |
| `bead-viewer` | `__tests__/bead-graph.test.ts` | Pure data layer only — JSON serialization, cycle detection, ordering. | HTTP server (no E2E per spec). Browser rendering. CDN reachability. |

All tests run under existing vitest config; no new framework. New fixtures live under `mcp-server/scripts/fixtures/calibration/` and `mcp-server/scripts/fixtures/bead-graph/`.

---

## 4. Risk Register

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| R1 | Extending `DOCTOR_CHECK_NAMES` later silently leaves new checks unhandled in `remediate.ts` lookup table | High | Lookup typed as `Record<DoctorCheckName, RemediationHandler \| null>` — TS exhaustiveness error at compile time. Add `assertExhaustive(_: never)` in default branch. |
| R2 | `estimatedEffort` field on `BeadTemplate` could break existing template fixtures or callers | Medium | Field is `?:` optional. Existing callers ignore it. Calibration code defaults missing values to `'M'`. Snapshot tests in `bead-templates.test.ts` re-recorded as part of T3. |
| R3 | Beads created before `template:` field existed pollute calibration with `__untemplated__` noise | Medium | Aggregate them under one bucket and surface count separately. Never include in per-template ratios. Document in calibrate docstring. |
| R4 | `dist/skills.bundle.json` drift between source `.md` and bundled JSON — exact same gotcha that bit this session | High | `npm run check:skills-bundle` script (T13) compares `bodyHash` of source vs bundle; CI fails on mismatch. Pre-commit hook recommendation in AGENTS.md (non-binding). |
| R5 | New MCP tools not registered → server won't dispatch them | Medium | T6 + T10 + T14 each include a `server.test.ts` assertion that the new tool name appears in `ListToolsRequestSchema` response. Existing `DEPRECATED_ALIAS_TOOLS` mapper auto-generates `orch_*` aliases — verify in test. |
| R6 | Remediation handler kills user state (e.g. wrong worktree removed, checkpoint lost) | High | (a) `dry_run` is the default; (b) mutating handlers require `autoConfirm: true`; (c) `checkpoint_validity` writes `.bak` before unlink; (d) `orphaned_worktrees` enumerates first, removes per-entry. |
| R7 | Bead-viewer binds to non-loopback by accident, exposes data on LAN | High | Hardcode `127.0.0.1` literal, not `'0.0.0.0'` or empty string. Add unit test on `bead-viewer.ts` `getBindAddress()` returning `'127.0.0.1'` exactly. |
| R8 | Cytoscape CDN load fails → page silently blank | Low | Out of scope (read-only viewer); add SRI hash to `<script>` tag and a `<noscript>` fallback message pointing user at `npm run bead-viewer -- --json` to dump raw JSON to stdout. |
| R9 | Calibration p95 over tiny samples (n=1, n=2) misleading | Low | Report `sampleCount` per row; renderer in `flywheel-status.md` adds `(n=K)` suffix; rows with `sampleCount < 3` flagged with `low-confidence: true` and excluded from synthesis-prompt injection. |
| R10 | Adding 3 new error codes breaks existing hint exhaustiveness check | Medium | T2 updates `DEFAULT_HINTS` and `DEFAULT_RETRYABLE` in same commit; `errors.schema.test.ts` already enforces every code has an entry — test will fail loudly if missed. |
| R11 | Skills bundle increases server cold-start time (parses every SKILL.md eagerly) | Low | Loader uses lazy single-pass parse cached behind `loadSkillsBundle()` promise. First `flywheel_get_skill` call triggers load; subsequent calls O(1). Bundle is JSON, ~200 KiB worst case. |
| R12 | `tsx scripts/build-skills-bundle.ts` runs in `npm run build` but is missing from `tsconfig.scripts.json` includes | Medium | `tsconfig.scripts.json` already globs `scripts/**/*` — verified via existing `lint-skill.ts` precedent. Confirm in T13 acceptance. |

---

## 5. Cross-Feature Dependencies

```
T1 (EstimatedEffort)
 ├─→ T3 (populate templates)
 │    └─→ T10 (calibrate consumes estimatedEffort)
 │         ├─→ T11 (synthesis + status integration)
 │         └─→ T12 (calibrate tests)
 └─→ (no other consumers — types only)

T2 (error codes)
 └─→ T4 (remediate dispatcher uses new codes)
      ├─→ T5 (handlers)
      │    └─→ T8 (handler tests)
      ├─→ T6 (registration)
      │    ├─→ T7 (SKILL update)
      │    └─→ T8 (server registration test)
      └─→ T8 (test depends on both handlers and registration)

T9 (stats fns) ──→ T10 (calibrate uses them)

T13 (build-skills-bundle) ──→ T14 (get-skill loader) ──→ T15 (parity tests)

T16 (graph data) ──→ T17 (HTTP server)
              └─→ T18 (data tests)
```

**Notable cross-feature interactions:**

1. **Calibration ↔ Synthesis (T10 → T11):** calibrate writes `.pi-flywheel/calibration.json` as a side-effect; synthesis reads it. Decoupled via filesystem so synthesis never imports calibrate (avoids circular module dependency between `tools/calibrate.ts` and `deep-plan-synthesis.ts` if synthesis ever moved into `tools/`).

2. **Bundle ↔ Get-skill (T13 → T14):** the build script generates a JSON file; the runtime loader reads it. The disk fallback (T14 acceptance) means the loader works even when the bundle is missing — important for contributor dev mode AND for the "first run after `git clone`" scenario before `npm run build` runs.

3. **Bead-viewer ↔ Calibration (data layer overlap):** both consume `br list --json` output. The graph data layer (T16) MUST NOT import from calibrate; if shared parsing is needed later, extract to a `mcp-server/src/br-parser.ts` module — left as a non-goal here.

4. **Remediation ↔ Doctor (T4 → existing doctor):** remediate imports `DOCTOR_CHECK_NAMES` and `DoctorCheckName` from `tools/doctor.ts`. No reverse dependency. Doctor remains pure-read-only; remediation is the only mutation surface for those checks.

---

## 6. Explicit Non-Goals

1. **Auto-running remediations from doctor itself.** `flywheel_doctor` stays read-only forever. Mutation lives in `flywheel_remediate` with explicit consent. Considered: bundling `--remediate` flag into doctor. Rejected: violates doctor's "always safe to run" contract.

2. **Remediation handler for `node_version`, `git_status`, `gemini_cli`, `claude_cli`, `codex_cli`, `swarm_model_ratio`, `br_binary`, `bv_binary`, `ntm_binary`, `cm_binary`, `rescues_last_30d`.** All marked `null` in lookup table. Reasoning: each requires user-level decisions (which version? which install method? rate-limit credentials?) that automation cannot safely make. Manual hints already exist in SKILL.md.

3. **Effort calibration on `add-feature`-style mega-templates retroactively rewriting bead estimates.** Calibrate produces a *report*; it never mutates existing beads. Considered: writing a `calibrated_effort` field back into beads. Rejected: distorts historical data, fights the synthesizer's authoring path.

4. **Bead-viewer write-back / bead editing.** Read-only by spec. No PATCH/POST. No "mark closed" button. Considered: drag-to-reorder priority. Rejected: doubles complexity, requires auth, conflicts with `br` as source of truth.

5. **Bead-viewer rich filtering UI.** Cytoscape provides built-in zoom/pan; we do not build custom layout switcher, search, multi-select. Rationale: focus on cycle visualization (the unique value) and graph topology, not bead management.

6. **Skill bundle compression / deduplication.** ~200 KiB JSON is acceptable; gzipping at the wire would matter only for remote MCP transports. The current MCP transport is stdio — no benefit.

7. **Migrating the skill front-matter parser to a dedicated `gray-matter` dep.** Reuse existing `unified` + `remark-parse` dev-dep for front-matter extraction. Considered adding `gray-matter`. Rejected: violates AGENTS.md "no new deps unless requested" + zero functional gain.

8. **Per-handler concurrency limits in remediate.** All handlers run sequentially per-call (one tool invocation = one fix). Considered batch mode `flywheel_remediate({ checkNames: [...] })`. Rejected: out of scope; would obscure failure attribution and complicate confirm-gating UX.

9. **Telemetry events for remediation success / failure.** The existing `recordErrorCode` hook fires on all `FlywheelError` results, which already covers remediation failures. Adding success-counter telemetry deferred to a future ergonomics pass.

10. **Wiring `flywheel_get_skill` into the orchestrator's existing `/start` flow.** That replacement is a separate ergonomics concern (different perspective). This plan only ships the tool + bundle; orchestrator continues to Read skills from disk until a follow-up replaces those calls.

---

## 7. Per-Bead Effort Summary (Dogfooded)

| Bead | Template | Effort | Estimated Min |
|------|----------|--------|---------------|
| T1   | add-feature       | S  | 30  |
| T2   | update-config     | S  | 30  |
| T3   | update-config     | S  | 30  |
| T4   | add-feature       | M  | 90  |
| T5   | add-feature       | L  | 240 |
| T6   | add-tool          | S  | 30  |
| T7   | add-documentation | S  | 30  |
| T8   | add-test          | M  | 90  |
| T9   | add-feature       | S  | 30  |
| T10  | add-tool          | M  | 90  |
| T11  | add-integration   | S  | 30  |
| T12  | add-test          | M  | 90  |
| T13  | add-tool          | M  | 90  |
| T14  | add-tool          | M  | 90  |
| T15  | add-test          | M  | 90  |
| T16  | add-feature       | M  | 90  |
| T17  | add-tool          | L  | 240 |
| T18  | add-test          | S  | 30  |

**Total estimated effort:** 1440 minutes ≈ 24 hours of focused work across 18 beads.
**Critical path (longest dependency chain):** T2 → T4 → T5 → T8 = 30 + 90 + 240 + 90 = 450 min ≈ 7.5 h.
**Parallelization opportunity:** T1, T2, T9, T13, T16 are all roots — 5 swarm agents can start immediately.

---

## 8. Implementation Conventions Reminder

- All new `.ts` files MUST use `.js` import suffixes per NodeNext.
- All `exec` calls MUST pass an explicit timeout (per `mcp-server/src/AGENTS.md` if present, else 60 s default).
- No `console.log` — use `logger.info`/`logger.warn`/`logger.error` per project convention.
- Never edit `mcp-server/dist/` directly; rebuild via `npm run build`.
- Every new tool returns `{ structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] }` per existing pattern in `tools/profile.ts` etc.
- Zod schemas exported as `*InputSchema` and `*OutputSchema` constants, types derived via `z.infer<typeof ...>`.

---

**End of correctness perspective plan.**
