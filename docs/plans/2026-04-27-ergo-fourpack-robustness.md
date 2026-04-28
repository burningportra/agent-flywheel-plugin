# Ergonomic Four-Pack — Robustness-First Plan

**Author:** robustness perspective planner
**Date:** 2026-04-27
**Repo:** `/Volumes/1tb/Projects/agent-flywheel` (v3.6.11, NodeNext/ESM, strict TS)
**Scope:** four new features — `flywheel_remediate`, plan estimation calibration, skill markdown precompilation, web bead-graph visualizer.
**Posture:** every new surface must fail closed, leave no half-state, and refuse to lie about success. The dist-drift incident this session (mtime != content drift) is the cautionary tale: any check or artifact whose value is derived must be a content hash, not a filesystem timestamp.

---

## 0. Executive summary

Robustness ground rules applied uniformly to all four features:

1. **Content hashes over mtimes.** `skills.bundle.json` must carry sha256 fingerprints over each skill body and an aggregate manifest hash. `flywheel_doctor.dist_drift` adopts the same model — compare hashes, not timestamps.
2. **AbortSignal threaded everywhere.** Every new MCP tool accepts `signal?: AbortSignal`, threads it through `ExecFn` (per `mcp-server/src/exec.ts:3`), and uses `try/finally` to release any state it acquired (mutex, port, tmp file).
3. **Per-tool timeouts, no open-ended exec.** AGENTS.md hard constraint #7. Remediate caps each fix at a documented budget; calibrate caps the bead query; bead-viewer caps render computation per request.
4. **Localhost-only sockets, sanitised rendering.** Bead-viewer binds `127.0.0.1` only, escapes bead bodies before serialising into HTML, and refuses any path traversal in static assets.
5. **Structured errors via `makeFlywheelErrorResult`.** No new ad-hoc error classes. Reuse `FlywheelError` + `FlywheelErrorCode` per `mcp-server/src/errors.ts:18`. Two new codes proposed: `remediate_unknown_check`, `remediate_apply_failed`, `bundle_integrity_failed`, `calibration_insufficient_data`, `viewer_port_in_use`.
6. **Atomic writes only.** All persistent writes use `write tmp -> fsync -> rename` (the pattern already used in `mcp-server/src/lint/baseline.ts:78`). Never partial-update `skills.bundle.json` or calibration cache files.
7. **Bounded everything.** Bundle size cap, calibration sample cap, viewer connection cap, remediate timeout. No unbounded reads of bead JSON or session logs.
8. **Observability as a peer to functionality.** Every new tool emits a structured stderr log line on entry, exit, and at every decision branch (skipped, applied, failed, aborted). The log shape is fixed up-front so dashboards and chaos tests can pin against it.

---

## 1. Threat models per feature

### 1.1 `flywheel_remediate({ checkName, autoConfirm? })`

| Threat | Worst case |
|---|---|
| Caller passes `checkName` not in the registry | Tool runs an arbitrary fix or no-ops silently. Must reject with `remediate_unknown_check` and list valid names. |
| Fix is mid-apply when user sends Ctrl-C | Process killed mid-`npm run build`, dist half-written, future doctor sees inconsistent state. Must use atomic dest writes and a sentinel file `.pi-flywheel/remediate.lock` cleaned in `finally`. |
| Two `flywheel_remediate` calls overlap on the same check | Concurrent rebuilds clobber each other. Must take a per-check mutex via `mcp-server/src/mutex.ts`. |
| Fix succeeds at the shell level but doesn't actually green the check | Tool reports success but doctor still red. After every apply, re-run the original probe and report `verifiedGreen: boolean`. Never rely on exit code alone. |
| Fix shells out via user-controlled `checkName` | Command injection. `checkName` is matched against a static map; never interpolated into a shell command. `shell: false` already enforced by `makeExec`. |
| Fix exceeds budget | `npm install` could take minutes. Per-fix timeout (default 60s, configurable per registry entry) with SIGTERM then SIGKILL escalation already in `exec.ts:24`. |
| `autoConfirm=false` but no user is attached (headless) | Must default to refusing to apply and returning the proposed shell command as a string. |
| Remediate runs in a worktree, the fix targets the main repo | Wrong cwd writes to the wrong tree. Resolve `cwd` from `git rev-parse --show-toplevel` once and reuse. |

### 1.2 Plan estimation calibration

| Threat | Worst case |
|---|---|
| `closed_ts < created_ts` (clock skew, manual edits) | Negative duration poisons mean. Drop samples where `duration <= 0` and increment `dropped_samples` counter in result. |
| Bead created, sat open for weeks, closed in 5 minutes of real work | `closed_ts - created_ts` overstates effort by 99%. Prefer first-commit timestamp from `git log --grep=<bead-id> --format=%aI --reverse` as `started_ts` proxy when available; fall back to `created_ts` and tag the sample as `proxy_started`. |
| Empty bucket for a template | Mean = NaN, median undefined. Return `{ insufficient: true, reason: "n=0" }` instead of synthesising. Do not propagate NaN into status output. |
| Bucket of size 1-2 | Mean is meaningless. Require `n >= 5` for surfaced estimate; otherwise return `insufficient: true`. |
| `br list --json` is huge (10k beads) | Unbounded memory and 30s+ parse. Cap the query (`--since 90d` filter, hard cap 5k beads); page if needed. |
| Calibration cache file corrupted (truncated JSON) | Tool throws on next read. Schema-validate on load with `zod`; on parse failure, log `warn`, treat as empty, regenerate. |
| `br update --status closed` was called on a bead never actually shipped | Time inflation. Cross-check that a commit references the bead id; if not, tag sample as `unverified` and weight half. |
| Race between calibration and bead-tracker writing | Read inconsistent JSON. Calibration is read-only and snapshotted; if `br list` returns parse-error retry once with backoff. |

### 1.3 Skill markdown precompilation

| Threat | Worst case |
|---|---|
| `skills.bundle.json` corrupted on disk (partial write, disk full) | Server returns garbled bodies. Validate on load with `zod`; on integrity failure (`bundle_integrity_failed`) fall back to reading the on-disk `.md` file. |
| Bundle older than source files | Caller gets stale skill text. Each entry stores `srcSha256` of the source `.md`; at request time, recompute (or compare against on-disk if available) and re-emit a `stale: true` warning in stderr. **Do not silently serve stale content** without warning. |
| Bundle present but skill renamed/deleted upstream | Lookup misses, currently returns undefined. Return `not_found` envelope with valid skill names list. |
| Skill body contains a NUL byte / invalid UTF-8 | JSON.parse fails silently or truncates. Reject during build; CI catches. |
| `~/.claude/plugins/cache/...` shipped a different bundle than the source tree | Plugin cache vs git tree drift. The `flywheel_get_skill` tool resolves bundle path via the same logic as `skills/start/SKILL.md` Step 0a (cache-first, fall back to repo `skills/`). Both paths must include their own bundle file; manifest hash is logged so drift is observable. |
| Build script invoked while server is reading the bundle | Reader gets partial content. Use atomic write (`tmp -> fsync -> rename`). |
| Bundle file size grows unboundedly as skills accumulate | Memory pressure on load. Hard cap 5 MB total; build fails over cap with an actionable error. |
| Attacker modifies bundle to inject prompt content | Bundle ships with a top-level `manifestSha256`; on load, recompute and refuse mismatched bundles. Not crypto-secure (no signature) but detects accidental tampering and disk corruption. |

### 1.4 Web bead-graph visualizer

| Threat | Worst case |
|---|---|
| Bead body contains `<script>alert(1)</script>` | XSS in the rendered SVG/HTML page. Escape every string injected into HTML using a tested escaper; serve graph data as JSON consumed by client-side Cytoscape, never as inlined HTML strings. |
| Port 3737 already in use | `EADDRINUSE`, server crashes loudly. Detect with `lsof`-equivalent or `net.Server.on('error')`; on collision, try +1 up to +9, then return `viewer_port_in_use` with the candidate set. |
| Request flood (open in two browsers, refresh storm) | Memory blowup. Connection cap (max 16), rate limit 30 req/s/IP, refuse with 429. |
| Bind to `0.0.0.0` accidentally exposes internal beads to the LAN | Hard-coded `127.0.0.1`; assert in startup. |
| Static asset path traversal (`/assets/../../etc/passwd`) | File disclosure. Resolve under a fixed root, reject paths with `..` after normalisation. |
| Bead JSON has cyclic deps (data corruption) | Cytoscape loops. Detect cycles during graph build; mark cycle edges `style: dashed` and emit a warning in the response. |
| `br list --json` exceeds 50k beads | Render hang. Cap nodes at 2000; return a banner in the page when truncated. |
| Server still running after parent process exits | Orphan process. Register `SIGTERM` / parent-death handler; exit on parent disconnection. |
| Long-poll for live updates leaves connection open forever | Resource leak. Hard timeout per connection (60s), client reconnects. |

---

## 2. Failure-mode → response matrix

| Feature | Failure mode | Defense |
|---|---|---|
| remediate | unknown checkName | reject with `remediate_unknown_check`, list valid names |
| remediate | mid-apply abort | `try/finally` cleanup, `.pi-flywheel/remediate.lock` removal, partial-write rollback via tmp-rename |
| remediate | concurrent runs same check | per-check mutex via `mutex.ts` |
| remediate | shell injection via checkName | static registry, `shell: false` |
| remediate | succeeded but doctor still red | re-run probe, surface `verifiedGreen` |
| remediate | headless w/o autoConfirm | return proposed command, do not apply |
| calibrate | clock skew negative duration | drop sample, increment `dropped_samples` |
| calibrate | inflated duration (open-then-quick-close) | use first-commit ts proxy; tag `proxy_started` |
| calibrate | n < 5 | return `insufficient` flag |
| calibrate | corrupted cache file | zod validation, regenerate on failure |
| calibrate | unverified close (no commit) | half-weight + `unverified` flag |
| bundle | corrupted on disk | zod validation, fall back to on-disk `.md` |
| bundle | stale vs source | sha256 compare, emit `stale: true` warning, do not silently serve |
| bundle | name not found | return `not_found` with valid names |
| bundle | size exceeds cap | build-time fail, 5 MB cap |
| bundle | tampering / accidental edit | manifestSha256 recompute on load, refuse mismatch |
| viewer | XSS via bead body | escape on render, JSON+client-side Cytoscape |
| viewer | port collision | try N+1..N+9, then `viewer_port_in_use` |
| viewer | request flood | conn cap 16, 30 req/s/IP rate limit |
| viewer | bind 0.0.0.0 | hard-coded `127.0.0.1`, startup assertion |
| viewer | path traversal | normalise + reject `..` |
| viewer | cyclic deps | detect, mark cycle edges, warn |
| viewer | bead set too large | cap 2000 nodes, banner |
| viewer | parent died | watch parent pid, self-exit on disconnection |

---

## 3. Bead breakdown (depends_on dependency graph)

Each implementation bead pairs with a chaos/regression test bead. Estimated effort: S (≤1h), M (1-3h), L (3-6h), XL (6h+).

### Foundation

- **T1** (S, depends_on: []) — Add new `FlywheelErrorCode` values: `remediate_unknown_check`, `remediate_apply_failed`, `remediate_already_running`, `bundle_integrity_failed`, `bundle_stale`, `calibration_insufficient_data`, `viewer_port_in_use`, `viewer_payload_too_large`. Edit `mcp-server/src/errors.ts:19` (the `FLYWHEEL_ERROR_CODES` array). Update tests that snapshot the enum.
- **T1b** (S, depends_on: [T1]) — Regression: assert all new codes are reachable from at least one tool boundary; assert no code is silently dropped by `makeFlywheelErrorResult`.

### Feature 1 — `flywheel_remediate`

- **T2** (M, depends_on: [T1]) — Build the remediation registry: a static `Record<string, RemediationEntry>` in `mcp-server/src/tools/remediate.ts`. Each entry: `{ checkName, description, command: { cmd, args }, timeoutMs, verifyProbe: () => Promise<boolean> }`. Seed with the 6 highest-frequency doctor failures (dist drift rebuild, missing `br`, missing `cm`, agent-mail not running, codex config gpt-5, missing dist file).
- **T2b** (S, depends_on: [T2]) — Unit test that every entry's `verifyProbe` references a real check defined in `tools/doctor.ts`.
- **T3** (M, depends_on: [T2]) — Implement `flywheel_remediate` MCP tool: input zod schema, registry lookup, mutex acquire, exec with timeout + signal, post-run verifyProbe, structured envelope return. Use `try/finally` for lock release. Register in `server.ts` next to `flywheel_doctor`.
- **T3b** (M, depends_on: [T3]) — Chaos test `mcp-server/src/__tests__/chaos/remediate-kill-midrun.test.ts`: start remediate against a stub that hangs 5s, fire `controller.abort()` at 100ms, assert (a) tool throws or returns `exec_aborted`, (b) `.pi-flywheel/remediate.lock` is gone, (c) no half-written tmp files in cwd.
- **T3c** (S, depends_on: [T3]) — Chaos test `remediate-concurrent.test.ts`: spawn 2 calls to remediate(`dist_drift`) simultaneously; second must return `remediate_already_running`.
- **T3d** (S, depends_on: [T3]) — Regression test `remediate-unknown-check.test.ts`: assert `remediate_unknown_check` envelope with valid-names list.
- **T3e** (S, depends_on: [T3]) — Regression test `remediate-headless-noconfirm.test.ts`: assert `autoConfirm=false` returns command string only, applies nothing.
- **T4** (S, depends_on: [T3]) — Update `skills/flywheel-doctor/SKILL.md`: replace existing "Fix it now?" prose with explicit instructions to call `flywheel_remediate({ checkName, autoConfirm: true })` after user confirmation; document the `verifiedGreen` field consumers should branch on.

### Feature 2 — Plan estimation calibration

- **T5** (S, depends_on: []) — Add optional `estimatedEffort?: 'S'|'M'|'L'|'XL'` field to `BeadTemplate` (`mcp-server/src/types.ts:240`). Backfill the 8 builtin templates in `bead-templates.ts` with conservative estimates. Existing beads that have no `estimatedEffort` continue to deserialise fine because the field is optional.
- **T5b** (S, depends_on: [T5]) — Schema test: load every builtin template, assert presence and validity of `estimatedEffort`. Asserts no enum drift.
- **T6** (M, depends_on: [T5]) — Implement `flywheel_calibrate` MCP tool in `mcp-server/src/tools/calibrate.ts`: query `br list --status closed --since 90d --json` with timeout 8s and `--limit 5000`, parse via zod (drop malformed entries), bucket by `templateId`, drop samples with `closed_ts <= created_ts`, prefer first-commit ts via `git log --grep=<id> -1 --format=%aI` as `started_ts` (cap 200 git calls per run), compute `mean / median / p95` per bucket where `n >= 5`, return `{ buckets, droppedSamples, totalBeadsConsidered, queriedAt }`.
- **T6b** (M, depends_on: [T6]) — Chaos test `calibrate-empty-data.test.ts`: stub `br list` to return `[]`; assert `insufficient: true` per bucket, no NaN, no throw.
- **T6c** (S, depends_on: [T6]) — Regression test `calibrate-clock-skew.test.ts`: feed beads with `closed_ts < created_ts`; assert dropped, never surfaced.
- **T6d** (S, depends_on: [T6]) — Regression test `calibrate-corrupt-cache.test.ts`: write garbage to cache path; assert tool degrades to empty + warn log, then regenerates.
- **T7** (S, depends_on: [T6]) — Surface calibration in `/flywheel-status`: add a "Template effort calibration" section showing each templateId's estimated vs actual mean; flag `>2x` divergence with a hint to review the template estimate.

### Feature 3 — Skill markdown precompilation

- **T8** (M, depends_on: []) — Add `mcp-server/scripts/build-skills-bundle.ts`: walk `skills/*/SKILL.md`, for each compute `srcSha256`, assemble `{ skills: Record<name, { body, srcSha256, sizeBytes }>, manifestSha256, builtAt, builderVersion }`. Atomic write to `mcp-server/dist/skills.bundle.json`. Hard cap 5 MB total; abort with actionable error over cap. Wire into `npm run build` (`mcp-server/package.json` build script).
- **T8b** (S, depends_on: [T8]) — Test: build against fixture skills tree, assert manifest hash deterministic across two runs (no timestamps in hashed content).
- **T9** (M, depends_on: [T8, T1]) — Implement `flywheel_get_skill({ name })` MCP tool in `mcp-server/src/tools/get-skill.ts`. Resolve bundle path: prefer plugin cache (`~/.claude/plugins/cache/...`) if present, fall back to `mcp-server/dist/skills.bundle.json`. On load: zod-validate, recompute `manifestSha256`, on mismatch return `bundle_integrity_failed` and fall back to reading the on-disk `.md` file directly. On lookup hit: if a same-named source `.md` exists and its sha256 differs from `srcSha256`, log `warn` with `bundle_stale: true` field but still serve. Cache parsed bundle in-process (re-validate on file mtime change).
- **T9b** (M, depends_on: [T9]) — Chaos test `bundle-corrupt-fallback.test.ts`: write truncated JSON to bundle path, ensure `flywheel_get_skill` returns content from the source `.md` and emits `bundle_integrity_failed` log line.
- **T9c** (S, depends_on: [T9]) — Regression test `bundle-stale-warns.test.ts`: bundle has body `"v1"`, source `.md` is now `"v2"`; assert response is `"v1"` (bundle wins for stability) AND a `bundle_stale: true` log fires.
- **T9d** (S, depends_on: [T9]) — Regression test `bundle-not-found.test.ts`: query a missing skill name, assert `not_found` envelope listing valid names.

### Feature 4 — Web bead-graph visualizer

- **T10** (L, depends_on: []) — `mcp-server/scripts/bead-viewer.ts`: HTTP server on `127.0.0.1:3737`, with `+1..+9` port-collision retry. Routes: `GET /` (HTML shell), `GET /assets/cytoscape.min.js` (static, sandboxed under fixed root), `GET /api/graph` (JSON `{ nodes, edges, truncated, cycles }` from `br list --json`, capped at 2000 nodes, cycles detected). Connection cap 16, per-IP rate limit 30 req/s. Bind assertion: refuse to start if `process.env.FW_VIEWER_BIND` is anything other than `127.0.0.1`. Watches `process.ppid`; exits on parent death.
- **T10b** (M, depends_on: [T10]) — Security test `viewer-xss-bead-body.test.ts`: insert a bead whose body is `<script>__pwn=1</script>`. Hit `/api/graph`, assert response is JSON with the body present-but-escaped (or stripped); hit `/`, render headless via JSDOM, assert `window.__pwn` undefined.
- **T10c** (S, depends_on: [T10]) — Chaos test `viewer-port-collision.test.ts`: pre-bind 3737, start viewer, assert it lands on 3738 (or whichever) and logs the chosen port; pre-bind 3737..3745, assert `viewer_port_in_use` returned.
- **T10d** (S, depends_on: [T10]) — Security test `viewer-bind-localhost.test.ts`: set `FW_VIEWER_BIND=0.0.0.0`, assert refusal at startup.
- **T10e** (S, depends_on: [T10]) — Regression test `viewer-path-traversal.test.ts`: `GET /assets/../../../etc/passwd` returns 403.
- **T10f** (S, depends_on: [T10]) — Chaos test `viewer-parent-death.test.ts`: start as child, kill parent, assert child exits within 2s.

### Cross-cutting

- **T11** (S, depends_on: [T3, T6, T9, T10]) — Add structured stderr log lines for entry/exit/decision in every new tool. Define and document the per-tool log shape (see §5).
- **T12** (S, depends_on: [T3, T6, T9, T10]) — Telemetry: emit `tool_invoked`, `tool_succeeded`, `tool_failed` events with the tool name + duration to existing `telemetry.ts`. For remediate, additionally emit `remediate_verified_green: boolean` so we can dashboard "fix-but-still-broken" rates.

Total: **18 beads** (5 foundation/cross-cutting + 4 impl + 9 chaos/regression).

---

## 4. Test plan (chaos + regression specifics)

All new tests live under `mcp-server/src/__tests__/chaos/` and follow the `_helpers.ts` (`makeExecFn`, `makeTmpCwd`, `cleanupTmpCwd`) pattern already used by `doctor-kill-midrun.test.ts` (118 LOC reference).

| Test | Asserts |
|---|---|
| `remediate-kill-midrun.test.ts` | (a) abort propagates SIGTERM, (b) lockfile removed, (c) no orphan tmp files, (d) returns `exec_aborted` |
| `remediate-concurrent.test.ts` | second concurrent call returns `remediate_already_running`; first completes successfully |
| `remediate-unknown-check.test.ts` | unknown name → `remediate_unknown_check`; valid-names list non-empty |
| `remediate-headless-noconfirm.test.ts` | `autoConfirm=false` returns proposed command, applies nothing, no exec calls |
| `remediate-fix-but-still-broken.test.ts` | exec succeeds (code 0) but verifyProbe still red → `verifiedGreen: false`, structured warning |
| `calibrate-empty-data.test.ts` | empty bead set → `insufficient` per bucket, no NaN |
| `calibrate-clock-skew.test.ts` | negative durations dropped, `droppedSamples` counter incremented |
| `calibrate-corrupt-cache.test.ts` | corrupted cache → fallback to empty + warn log, regenerate on next call |
| `calibrate-large-dataset.test.ts` | 5k beads complete under 8s timeout; 5001st rejected at query layer |
| `bundle-corrupt-fallback.test.ts` | corrupted bundle → fall back to on-disk `.md`, `bundle_integrity_failed` log |
| `bundle-stale-warns.test.ts` | source-bundle hash mismatch → serves bundle, emits `bundle_stale: true` |
| `bundle-not-found.test.ts` | unknown skill name → `not_found` with valid names |
| `viewer-xss-bead-body.test.ts` | bead body with `<script>` does not execute in JSDOM render |
| `viewer-port-collision.test.ts` | `+1..+9` retry; full block returns `viewer_port_in_use` |
| `viewer-bind-localhost.test.ts` | non-localhost bind refused at startup |
| `viewer-path-traversal.test.ts` | `..` requests return 403 |
| `viewer-parent-death.test.ts` | parent SIGKILL → child exits within 2s |

CI hookup: extend the existing chaos-test glob (vitest config) — these tests run in the same suite.

---

## 5. Observability hooks (log shape per tool)

All log lines use `createLogger(ctx)` from `mcp-server/src/logger.ts:50`, written as JSON to stderr. Stable field shapes so dashboards and chaos-test assertions are pinnable.

**`remediate` (`ctx: "remediate"`):**

```json
{ "level": "info", "ctx": "remediate", "msg": "remediate.start",
  "checkName": "dist_drift", "autoConfirm": true, "headless": false }

{ "level": "info", "ctx": "remediate", "msg": "remediate.applied",
  "checkName": "dist_drift", "exitCode": 0, "durationMs": 4123 }

{ "level": "info", "ctx": "remediate", "msg": "remediate.verified",
  "checkName": "dist_drift", "verifiedGreen": true }

{ "level": "warn", "ctx": "remediate", "msg": "remediate.fix_but_red",
  "checkName": "dist_drift", "verifiedGreen": false }
```

**`calibrate` (`ctx: "calibrate"`):**

```json
{ "level": "info", "ctx": "calibrate", "msg": "calibrate.start",
  "windowDays": 90, "limit": 5000 }

{ "level": "info", "ctx": "calibrate", "msg": "calibrate.done",
  "buckets": 8, "totalSamples": 142, "droppedSamples": 7,
  "insufficientBuckets": 2, "durationMs": 1894 }
```

**`get_skill` (`ctx: "skill-bundle"`):**

```json
{ "level": "warn", "ctx": "skill-bundle", "msg": "bundle.integrity_failed",
  "bundlePath": "...", "expectedHash": "...", "actualHash": "..." }

{ "level": "warn", "ctx": "skill-bundle", "msg": "bundle.stale",
  "skill": "flywheel-doctor", "bundleSha": "...", "sourceSha": "..." }
```

**`bead-viewer` (`ctx: "bead-viewer"`):**

```json
{ "level": "info", "ctx": "bead-viewer", "msg": "viewer.listening",
  "port": 3737, "host": "127.0.0.1" }

{ "level": "warn", "ctx": "bead-viewer", "msg": "viewer.port_collision",
  "tried": [3737,3738,3739], "chosen": 3740 }

{ "level": "warn", "ctx": "bead-viewer", "msg": "viewer.truncated",
  "totalBeads": 4823, "rendered": 2000 }

{ "level": "info", "ctx": "bead-viewer", "msg": "viewer.parent_dead_exit" }
```

**Telemetry events (via `telemetry.ts`):** `tool_invoked`, `tool_succeeded`, `tool_failed` with `{ tool, durationMs, errorCode? }`. Add tool-specific extras: `remediate.verifiedGreen`, `calibrate.insufficientBuckets`, `bundle.integrityOk`, `viewer.portChosen`.

---

## 6. Migration safety

| Concern | Strategy |
|---|---|
| Existing beads have no `estimatedEffort` field | Field is optional on `BeadTemplate`. Existing serialised beads do not include the field; calibration treats absence as "no template estimate to compare against" rather than error. No backfill required. |
| Plans synthesised against old template versions | `BeadTemplate.version` already pinned (per `types.ts:243` comment). Calibration buckets by `templateId` ignoring version, so historical samples count toward current template estimates. Future: bucket by `templateId@version` if drift becomes a problem. |
| Plugin cache vs repo bundle drift | `flywheel_get_skill` resolves bundle path same as `skills/start/SKILL.md` Step 0a. Both `~/.claude/plugins/cache/agent-flywheel/.../skills.bundle.json` and `<repo>/mcp-server/dist/skills.bundle.json` are valid sources. The chosen path and its `manifestSha256` are logged at server startup so cache-vs-repo mismatch is observable. |
| Users on v3.6.x without skills bundle | `flywheel_get_skill` falls back to reading the source `.md` from disk if the bundle is absent, so the tool is forward-compatible with installs that haven't been rebuilt. Callers must tolerate the fallback being slightly slower (no preload). |
| Doctor checks change name | Remediation registry keys are stable strings. Renaming a doctor check requires deprecation: keep old name as an alias entry pointing at the new fix for one minor version. Document in CHANGELOG. |
| Calibration cache schema evolves | Versioned schema (`version: 1`) on the cache file. Mismatch → invalidate, log, regenerate. Same pattern as `BaselineFileSchema` in `lint/baseline.ts:30`. |

---

## 7. Resource limits

| Resource | Cap | Rationale |
|---|---|---|
| `flywheel_remediate` per-fix timeout | 60s default; entry-overridable up to 180s | Bounded by AGENTS.md hard constraint #7. `npm install` may need 120s; reject anything wanting more. |
| Remediation registry size | unlimited (compile-time) | Static map; no runtime growth path. |
| `flywheel_calibrate` `br list` timeout | 8s | Matches existing doctor probes. |
| Calibration query `--limit` | 5000 beads | Beyond this, parse memory + git-log fanout become unfriendly. |
| Calibration `git log` calls per run | 200 | Bounded fanout to compute first-commit ts. Beyond cap, fall back to `created_ts`. |
| Calibration result memory | <1 MB | 8 buckets × small JSON. Unlikely to be a constraint, but documented. |
| `skills.bundle.json` total size | 5 MB | Build fails over cap. Current skills directory is well under 1 MB. |
| Skill body individual entry | 200 KB | Single skill .md exceeds → build-time error suggesting a split. |
| Bundle in-memory cache | size of bundle, single instance | One process, one cache. Re-validated on file mtime change. |
| Bead-viewer concurrent connections | 16 | Stop browsers + tabs from exhausting fds. |
| Bead-viewer per-IP rate | 30 req/s | Generous for one human, defends against accidental refresh storms. |
| Bead-viewer rendered nodes | 2000 | Cytoscape SVG performance cliff above this. Banner shown when truncated. |
| Bead-viewer per-connection timeout | 60s | Releases stuck clients. |
| Bead-viewer total memory budget | 64 MB | Detected via `process.memoryUsage().heapUsed` polling; over budget → log warn. |

---

## 8. Per-bead estimated effort

| Bead | Effort | Notes |
|---|---|---|
| T1 | S | Enum addition + snapshot fix |
| T1b | S | Single regression test |
| T2 | M | Static registry + 6 entries |
| T2b | S | Reflective test |
| T3 | M | Tool wiring, mutex, exec, verify |
| T3b | M | Chaos test infrastructure |
| T3c | S | Concurrency test |
| T3d | S | Envelope shape test |
| T3e | S | Headless flow test |
| T4 | S | SKILL.md prose update |
| T5 | S | Type field + 8 backfills |
| T5b | S | Schema test |
| T6 | M | Calibration logic + git probe |
| T6b | M | Chaos test |
| T6c | S | Skew test |
| T6d | S | Cache corruption test |
| T7 | S | Status surface integration |
| T8 | M | Build script + atomic write + size cap |
| T8b | S | Determinism test |
| T9 | M | Tool wiring + fallback + cache |
| T9b | M | Corrupt-fallback test |
| T9c | S | Stale-warning test |
| T9d | S | Not-found test |
| T10 | L | HTTP server + cytoscape + caps |
| T10b | M | XSS test via JSDOM |
| T10c | S | Port collision test |
| T10d | S | Bind assertion test |
| T10e | S | Path traversal test |
| T10f | S | Parent-death test |
| T11 | S | Logging additions |
| T12 | S | Telemetry hooks |

**Rough total:** 4 L/M-heavy beads (T3, T6, T8, T9) + 1 L (T10) + remainder S. Estimated wall time for an experienced contributor: 3–5 days; with two parallel implementers: 2–3 days, gated on T1 completing first.

---

## 9. Open robustness questions for synthesizer

1. **Mutex granularity for remediate.** Per-check (proposed) vs global (simpler, slower). Per-check assumes fixes are independent — true for the seed set but may not generalise. If a future fix touches `mcp-server/dist/`, two fixes that both touch `dist/` would conflict despite different check names. Recommendation: per-check now, escalate to `dist/` lock if such a fix is added.
2. **Calibration: include open beads in stale-flagging?** A bead open >30 days with no commits is a signal of stale planning, not of effort. Out of scope for v1 of this feature, but the data is right there.
3. **Bundle signing.** `manifestSha256` detects accidental tampering, not malicious. If/when the plugin cache becomes a remote-fetched artifact, an HMAC or detached signature should follow. Tracked but not in this plan.
4. **Bead-viewer auth.** Localhost-only is the present defense. If users want to expose it across a tailscale net, we need a token; explicitly out of scope here.
5. **Remediate idempotency.** All seed fixes are idempotent (rebuild dist, install package, restart agent-mail). New entries must declare `idempotent: true` or remediate refuses to apply twice in a row without a state change.

---

## 10. Robustness alignment with existing AGENTS.md hard constraints

| Constraint | This plan's adherence |
|---|---|
| no `console.log` (#1) | All logging via `createLogger` (§5). |
| dist read-only by humans (#2) | Only `npm run build` writes `dist/skills.bundle.json`. |
| TypeScript strict (#3) | All new code uses strict mode; no implicit any. |
| NodeNext `.js` imports (#4) | All new modules import with explicit `.js`. |
| ESM only (#5) | No `require()`. |
| No direct `.pi-flywheel/checkpoint.json` writes (#6) | New tools touch `.pi-flywheel/remediate.lock` and calibration cache only — never checkpoint.json. |
| All exec calls have timeouts (#7) | Per-fix timeout, calibration timeout, git probe timeout — all enumerated in §7. |
| AbortSignal threaded (#8) | Every new tool's signature accepts `signal?: AbortSignal` and forwards via `ExecFn` opts (per `exec.ts:3`). |

---

End of robustness plan.
