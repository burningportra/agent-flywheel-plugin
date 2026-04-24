# dqo-wave Test Coverage Review — 2026-04-23

Reviewer: feature-dev:code-reviewer (test lens)
Range: `git diff 936f227..HEAD -- '**/*.test.ts'`

## Critical

### Finding 1 — `resolveRealpathWithinRoot` untested at the unit level (confidence 88)

Source: `mcp-server/src/utils/path-safety.ts:358-399`
Test gap: `mcp-server/src/__tests__/utils/path-safety.test.ts` (no describe block exists)

`path-safety.test.ts` tests `assertSafeRelativePath` and `assertSafeSegment` with exact `reason` assertions, but `resolveRealpath`, `resolveRealpathWithinRoot`, and the throwing wrappers are absent. The `root_not_found` path (line 368, when `realpathSync(root)` throws ENOENT) is never directly asserted. The `outside_root` reason code (line 383) is only reachable indirectly via tool tests that check message strings like `'rejected by realpath guard'` (injected by the tool, not the utility). If someone renames `outside_root` to `escape_root`, all tool tests still pass.

**Fix:** Add a `describe('resolveRealpathWithinRoot')` block covering: happy-path output shape (`realRoot`, `relativePath`), `reason: 'outside_root'` from a symlink escape, `reason: 'not_found'` from a missing file inside existing root, and `reason: 'root_not_found'` from a missing root using `mkdtempSync` + delete.

## Important

### Finding 2 — `allocateAgentNames` negative-count guard untested (confidence 82)

File: `mcp-server/src/__tests__/adapters/agent-names.test.ts:25-28`
Source: `mcp-server/src/adapters/agent-names.ts:171`

The source throws `'count must be >= 0'` for negative inputs, and returns `[]` for zero. Neither is tested. A computed bead count that underflows to `-1` would throw at the call site with no coverage verifying the error message shape.

**Fix:** Two `it` blocks — `allocateAgentNames(0, 'seed')` returns `[]`; `allocateAgentNames(-1, 'seed')` throws matching `/count must be >= 0/`.

### Finding 3 — planFile directory-component symlink not tested (confidence 80)

File: `mcp-server/src/__tests__/tools/plan.test.ts:175`

Only leaf-file symlinks are tested (`symlinkSync(outsidePlan, join(tmpDir, 'plan.md'))`). A directory-component symlink (`symlinkSync(outsideDir, join(tmpDir, 'subdir'))` then `planFile: 'subdir/plan.md'`) is not covered. The `resolveRealpathWithinRoot` implementation should block this correctly, but no test pins it.

## Summary

- `resolveRealpathWithinRoot` and `resolveRealpath` (path-safety.ts) have zero direct unit tests; only exercised indirectly through tool tests.
- `allocateAgentNames` zero-count and negative-count paths unexercised.
- planFile directory-component symlink escape not tested (only leaf-symlink).
- All new symlink-escape tests assert exact error codes (`'invalid_input'`); isolation correct (`mkdtempSync` + `rmSync` in `finally`).
- `error-contract.test.ts` `it.each` blocks across 29 codes are thorough; `Object.keys(DEFAULT_HINTS).sort()` equality (line 302) precise.
