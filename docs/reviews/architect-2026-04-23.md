# Architect review — 2026-04-23

Wave reviewed: `dfc8c51..HEAD` (19 commits, 18 beads, +18672/-512 LOC).
Reviewer: fresh-eyes architect.

## Summary

**Yellow.** The wave is structurally sound — the new `utils/` (path/clone/fs/text-normalize) and `adapters/` modules are cleanly layered, the collision-detection design is genuinely good, and the Zod-first contract surface in `state.ts` continues to mature. But three issues need attention before this ships as a release: (1) `flywheel_refresh_learnings` was implemented as a 534-LOC module but was **never registered as an MCP tool** in `server.ts`, (2) `ReviewArgs` is duplicated across `state.ts` (Zod) and `types.ts` (TS interface) with no single-source-of-truth derivation, and (3) the new `wave_collision_detected` flow has zero coupling to the existing agent-mail file-reservation system, so the two collision-prevention mechanisms can't cooperate. None of these is a P0, but each is the kind of thing that compounds.

## Top concerns (ranked)

### 1. `flywheel_refresh_learnings` is implemented but NOT exposed as a tool — P0

`mcp-server/src/refresh-learnings.ts:482` exports `refreshLearnings(...)` (534 LOC, classifier + overlap rubric + extensive tests), and bead b6f69be ("flywheel_refresh_learnings tool") claims to ship the tool. But `mcp-server/src/server.ts` has zero references to `refresh_learnings` or `refreshLearnings` — only `flywheel_emit_codex` is wired in (`src/server.ts:299`). The MCP surface promised by the bead does not exist; only the library does.

**Suggested fix:** Either register a `runRefreshLearnings` handler in `server.ts` (mirror the `flywheel_emit_codex` pattern at `src/server.ts:296-299`) and add a JSON Schema entry, OR demote the bead's commit message and changelog entry to "internal helper, not yet exposed." Whichever path, the contract advertised in the commit message must match what `tools/list` returns.

### 2. `ReviewArgs` shape is duplicated across `state.ts` and `types.ts` — P1

`mcp-server/src/state.ts:24-44` defines `ReviewModeSchema`, `ReviewActionSchema`, and `ReviewArgsSchema` (Zod). `mcp-server/src/types.ts:596-605` defines a parallel `ReviewMode` union and `ReviewArgs` interface (TS). Both are hand-maintained. The `parallelSafe` field exists in both but with different defaults: state.ts defaults `false`, types.ts marks it optional with no default. The commit message acknowledges this ("`ReviewArgs` in types.ts gains `mode` and `parallelSafe` (advisory) optional fields. The JSON Schema in server.ts mirrors both") — three places to keep in sync is a contract bug waiting to happen.

**Suggested fix:** Make `types.ts:ReviewArgs` an alias of `z.infer<typeof ReviewArgsSchema>` (i.e. `export type ReviewArgs = ReviewArgsZ`), and generate the JSON Schema in `server.ts` from `zodToJsonSchema(ReviewArgsSchema)` instead of hand-typing it. Bead 0ef explicitly notes "types.ts is owned by another bead" as the reason for forking — that ownership rule is now actively producing drift and should be re-litigated.

### 3. Wave-collision detection and agent-mail file reservations are uncoordinated — P1

`mcp-server/src/coordination.ts:267-525` is a complete, well-tested post-hoc collision-detection system. `mcp-server/src/agent-mail.ts:221-366` is a complete, separate pre-emptive file-reservation system. They share no types, no ignore-list, and no escalation pathway. Concretely: when agent-mail is up, reservations should *prevent* the wave_collision case from ever firing — but `detectWaveCollisions` doesn't consult `listReservations` to know that paths were claimed and explicitly approved (e.g., a coordinator might intentionally allow shared writes to a manifest under a reservation lease). Conversely, when collision-detection fires post-commit, there's no notification back through agent-mail so the in-flight reservations stay held.

**Suggested fix:** At minimum, document the intended interaction in `coordination.ts:240-265` (the COLLISION_IGNORE doc block). At better, have `detectWaveCollisions` accept an optional `reservedPaths: Set<string>` argument; aggregate but downgrade collisions on reserved paths to "expected, ignored" with telemetry. This is not blocking ship but should be on the roadmap before swarm parallelism widens.

### 4. `coordination.ts` has accreted three unrelated concerns — P2

`mcp-server/src/coordination.ts` (525 LOC) now contains: backend detection (beads/agent-mail/sophia), pre-commit hook scaffolding, UBS detection, and wave-collision detection. The collision system pulls in `normalizeText`, `readFileSync`, glob matching, and `git diff` parsing — none of which are about *coordination strategy selection*, which is what the file's `selectStrategy` / `selectMode` API suggests it's for.

**Suggested fix:** Extract the collision system into `src/coordination/collisions.ts` (or top-level `src/wave-collisions.ts`), keeping `coordination.ts` focused on backend selection. The current file violates SRP and will keep growing as new backends are added.

### 5. `flywheel_emit_codex` builds its own error envelope, bypassing `FlywheelError` — P1

`mcp-server/src/tools/emit-codex.ts:93-end` defines a bespoke `EmitCodexErrorStructured` type and a private `makeEmitCodexError` factory because — per the JSDoc at line 11 — "this tool intentionally does NOT extend `FlywheelToolName` in `types.ts` (forbidden by bead scope — types.ts is owned by another bead)." The result is a tool whose error envelope is shaped like the contract but is not validated against `FlywheelToolErrorSchema`, and whose error codes (`invalid_input | internal_error`) are a *subset* of `FLYWHEEL_ERROR_CODES` chosen by string-typing rather than enum-typing.

**Suggested fix:** Same root cause as concern #2 — types.ts ownership is producing duplication. Either widen the bead scope to allow types.ts edits, or have a single bead consolidate the contract surface in a follow-up. Until then, at least `safeParse` the constructed envelope against `FlywheelStructuredErrorSchema` in tests so the duplication doesn't drift silently.

### 6. `text-normalize` module is appropriately small and well-placed — P2 (positive)

24 LOC, single function, used at 17 distinct read sites (`coordination.ts`, `lint/*`, `refresh-learnings.ts`, `agents-md.ts`, `tools/{approve,plan}.ts`, `profiler.ts`, `tender.ts`, `telemetry.ts`, `feedback.ts`). This is exactly the right level of abstraction — a one-liner with a clear policy doc. Not premature; if anything, it should have existed sooner.

### 7. `path-safety` / `clone-safety` / `fs-safety` are large for utils — P2

280 / 261 / 266 LOC respectively. These are bigger than typical "utils" (they're closer to "security primitives"). At this size and scope — they encode policy, not just helpers — they probably deserve their own top-level `src/security/` directory rather than living under `src/utils/` next to a 24-LOC `text-normalize`. Mixing a one-line normalizer with three policy modules in the same folder makes the folder's intent unclear.

**Suggested fix:** Move `path-safety.ts`, `clone-safety.ts`, `fs-safety.ts` into `src/security/`. Leave `text-normalize.ts` in `utils/`. This isn't urgent but the shape will harden as more security primitives accrue.

### 8. `codex-handoff.ts` correctly stays a consumer of adapters — P2 (positive)

`mcp-server/src/codex-handoff.ts:1-50` explicitly documents "this module is a *consumer*, never a modifier of the adapter (per coordination rules with bead `x6g`)". Good design — the adapter pattern is preserved, dispatch is delegated, and the module is "pure: zero side effects, zero I/O". 248 LOC for what it does is reasonable. No concern.

## Well-designed parts (keep)

- `src/utils/text-normalize.ts` — single-responsibility, well-documented policy, broad adoption (17 sites).
- `src/coordination.ts:267-525` collision-detection — `aggregateCollisions` is pure, `detectWaveCollisions` is the only I/O wrapper, ignore-globs are seeded per-project not hardcoded, and `forceSerialRerun` separates strategy from execution. The 29-test suite is the right shape.
- `src/codex-handoff.ts` — pure module, delegates to `adapters/codex-prompt.ts`, hint copied verbatim from `FlywheelToolError.hint`. Good adapter discipline.
- `src/state.ts:24-44` ReviewArgs Zod schema — runtime validation at the contract boundary is correct (the duplication into types.ts is the bug, not the Zod schema itself).
- `FLYWHEEL_ERROR_CODES` continues to be the single registry, with explicit comments grouping the v3.4.0 / iy4 / f0j additions and `DEFAULT_RETRYABLE` updated alongside (`src/errors.ts:80+`). The "bumped 26→27 tripwire" pattern in `error-contract.test.ts` is a great forcing function.

## Questions for the coordinator

1. **`flywheel_refresh_learnings`** — was the tool exposure deliberately deferred, and should I file a follow-up bead, or did it slip and need a hot-patch?
2. **types.ts ownership rule** — bead 0ef and bead zbx both call out "types.ts is owned by another bead" as a reason for duplication. Is that ownership still active, and is there a planned consolidation bead?
3. **Wave-collision + agent-mail integration** — is the explicit non-coupling intentional (defense-in-depth), or did the iy4 design just not get to that conversation?
4. **`coordination.ts` 525 LOC** — comfortable as-is, or should we split before the next backend lands?
5. **`security/` vs `utils/` placement** — would you accept a follow-up to move the three audit modules out of `utils/`?

## Scope drift detected

- **Bead 6qj — None found in the commit.** The user's task description suggested 6qj "committed release-gate items instead of the telemetry-summary it was supposed to do," but `br show agent-flywheel-plugin-6qj` confirms the bead was titled "v3.4.1: address 5 P1s from v3.4.0 R1 release gate" and the commit (`2f94b5b`) addresses exactly P1-2/P1-3/P1-4 from that bead's WHAT/WHY. **The commit matches the bead spec.** If telemetry-summary was an *additional* expected deliverable, it's missing from the bead text — likely a coordinator/bead-spec drift, not an implementation drift.
- **Bead b6f69be (`flywheel_refresh_learnings`) — TRUE scope drift.** Bead title says "tool"; the implementation ships only the library. The MCP tool surface is missing (see concern #1). This is the only real scope drift I found.
- **Bead 0ef (review mode matrix)** — explicitly defers README mode-paragraph as a "follow-up" (acknowledged in commit message). Acceptable, but tracked-deferral should generate a bead, not just a commit-message TODO.
- **Bead zbx (`flywheel_emit_codex`)** — explicitly notes types.ts edits were out-of-scope and worked around with a duplicated error envelope. Acknowledged constraint, not stealth drift, but produces tech debt (concern #5).
