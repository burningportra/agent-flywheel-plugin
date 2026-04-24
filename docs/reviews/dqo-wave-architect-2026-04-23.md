# dqo-wave Architect Review — 2026-04-23

Reviewer: feature-dev:code-reviewer (architect lens)
Range: `936f227..HEAD` (5 commits, 3 merges)
Beads: i7t, 9p3, byx, dqo

## CRITICAL

### 1. `emit-codex.ts:183-235` — inline parallel symlink resolver, not using shared `resolveRealpathWithinRoot` (confidence 87)

The private `resolvePluginRoot` function rolls its own `realpathSync`-based containment check (three direct `realpathSync` calls) instead of delegating to `resolveRealpathWithinRoot` from `path-safety.ts`. The dqo bead explicitly created `resolveRealpathWithinRoot` as the single shared realpath resolver, but `emit-codex.ts` was not migrated.

Additionally, line 226 hardcodes POSIX `/` as the separator (`realRoot.startsWith(allowed + "/")`), while `path-safety.ts:isSameOrChildPath` correctly uses `path.sep`. On macOS this is harmless, but it is a behavioral divergence from the canonical implementation that will cause silent failures on Windows.

Also: lines 202-205 silently swallow `realpathSync` errors when the target doesn't exist (`realRoot` stays equal to `absRoot`, which was computed with `resolve(cwd, rawRoot)` — so it still passes the cwd-containment check). The `resolveRealpath` in `path-safety.ts` handles this explicitly as a `not_found` error. The behaviors diverge.

**Fix:** replace the inline function body with `resolveRealpathWithinRoot(absRoot, { root: cwd, label: 'pluginRoot' })`, adding `CLAUDE_PLUGIN_ROOT` as a second allowed root if needed via the `allowAbsoluteInsideRoot` opt-in or a new `allowedRoots` parameter.

## IMPORTANT

### 2. `plan.ts:116-133` — `safe.value` discarded; raw `args.planFile` re-passed to `resolveRealpathWithinRoot` (confidence 82)

`assertSafeRelativePath` returns `safe.value` — the normalized, containment-verified relative path. The immediately following call (`resolveRealpathWithinRoot(args.planFile, ...)`) passes the original raw input rather than `safe.value`. Two-layer guard design implies layer 2 should consume layer 1's output. Functionally safe today (resolveRealpathWithinRoot handles absolute inputs via `isAbsolute`), but design is internally inconsistent.

**Fix:** change line 129 to `resolveRealpathWithinRoot(safe.value, { root: cwd, ... })`.

## All other focus areas pass

- **API surface coherence**: `path-safety.ts` and `fs-safety.ts` cleanly separated. Zero overlap.
- **Boundary discipline**: `server.ts:412` is the sole cwd canonicalization point. Tools re-realpath their *arguments*, not cwd.
- **Error contract**: All path-safety rejections map to registered `FlywheelErrorCode` values via `makeFlywheelErrorResult`.
- **Test patterns**: Four symlink-escape regression tests follow the same `mkdtempSync` / `symlinkSync` / `rmSync` pattern as `fs-safety.test.ts`.
- **DEFAULT_HINTS quality**: All 29 hints >30 chars, include specific CLI commands, none echo the code name. `it.each` tripwire in `error-contract.test.ts:305` enforces.

## Summary

- **Critical (87)**: `emit-codex.ts:183-235` parallel realpath resolver, hardcoded POSIX `/`, silent ENOENT-swallowing — dqo's shared resolver was not adopted here
- **Important (82)**: `plan.ts:129` discards `assertSafeRelativePath`'s normalized output; re-passes raw input
- All other dimensions clean
