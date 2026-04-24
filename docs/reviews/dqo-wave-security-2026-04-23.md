# dqo-wave Security Review — 2026-04-23

Reviewer: feature-dev:code-reviewer (security lens)
Range: `git show 555b2d2` + merge `bc1e689`
Files examined: `path-safety.ts` (146 LoC), `server.ts`, `plan.ts`, `memory-tool.ts`, `doctor.ts`, `doctor-tool.ts`

## Critical Findings

None. The core `resolveRealpathWithinRoot` chain is sound for all explicitly guarded inputs.

## Important Findings

### Finding 1 — Unguarded symlink read in `readLatestBrainstorm` (confidence: 85)

File: `mcp-server/src/tools/plan.ts:38-42`

The function uses `statSync(abs)` then checks `st.isFile()`. `statSync` follows symlinks, so a symlink to a regular file outside `cwd` returns `isFile() === true` and its content is read. The `abs` path is built from `readdirSync(join(cwd, 'docs', 'brainstorms'))` output — that directory is not under `resolveRealpathWithinRoot` protection. An attacker with write access to `docs/brainstorms/` could place a symlink named `<goalslug>-2026-04-23.md -> /etc/passwd` and the content would be read and embedded into the planning prompt.

The impact is read-only information disclosure into a planning prompt (not a filesystem write), but it bypasses the dqo protection that every other path-ish input in this batch now has.

**Fix:** replace `statSync(abs)` with `lstatSync(abs)` and add `!st.isSymbolicLink()` to the guard, or run `abs` through `resolveRealpathWithinRoot(abs, { root: cwd })` before reading.

### Finding 2 — TOCTOU window between `resolveRealpathWithinRoot` and `readFileSync` (confidence: 80)

File: `mcp-server/src/tools/plan.ts:129-155`

The flow is: `resolveRealpathWithinRoot(args.planFile)` returns `resolvedPlanFile.realPath`, then immediately `readFileSync(resolvedPlanFile.realPath)`. Standard TOCTOU pattern — between realpath resolution and the open, an attacker with write access to a parent dir could re-point a symlink. No fix in pure Node.js `readFileSync` (no O_NOFOLLOW equivalent). Accepted-as-designed; documented for completeness.

## Checklist Verification

1. **TOCTOU** — See Finding 2. Small window, inherent in Node sync fs API.
2. **Symlink-on-component** — Sound. `resolveRealpathWithinRoot` calls `realpathSync` on both input and root, then compares canonical paths via `isSameOrChildPath`.
3. **ENOENT handling** — Uniform structured `not_found` everywhere. `server.ts:413`, `plan.ts:135-153`, `memory-tool.ts:229-249`, `doctor.ts:330-350`.
4. **Allowlist comparison** — Sound. `path-safety.ts:157-159` appends `sep` before `startsWith`, defeats `/safe-evil/...` confusion.
5. **Coverage gaps** — Only Finding 1 (`readLatestBrainstorm`). All MCP-facing args (`cwd`, `planFile`, `refreshRoot`) are guarded.

## Summary

- Core `resolveRealpathWithinRoot` / `isSameOrChildPath` logic is correct
- ENOENT handling is uniform; no raw fs errors leak
- **Finding 1 (conf 85):** `readLatestBrainstorm` in `plan.ts:38-42` uses `statSync` (symlink-following). Fix: `lstatSync` + `!isSymbolicLink()`, or route through `resolveRealpathWithinRoot`
- **Finding 2 (conf 80):** TOCTOU in `plan.ts:155`; exploitable only with prior write access; no O_NOFOLLOW in Node `readFileSync`
- All other audit checks pass; `cwd` canonicalized at server boundary before any runner sees it
