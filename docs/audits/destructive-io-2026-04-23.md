# Destructive filesystem-IO audit

- **Bead:** `agent-flywheel-plugin-8tf`
- **Date:** 2026-04-23
- **Reference:** CE phase4 blunder #3 — `forceSymlink` unconditionally
  `fs.unlink`s an existing regular file under `~/.agents/skills/` with
  no ownership check and no backup
  (`docs/research/compound-engineering-phase4-blunders.md`).

## Goal

CE's `forceSymlink` silently destroyed user hand-edits because the
destructive branch of its install logic had **no positive ownership
signal** — it walked straight from `stat()` to `fs.unlink()`. This audit
does the same scan against agent-flywheel-plugin and wires a shared
guard module (`mcp-server/src/utils/fs-safety.ts`) through every
destructive call site.

## Inventory

Grep: `rg -n 'fs\.(unlink|rm|rmSync|symlink|rename|unlinkSync|renameSync|symlinkSync)' mcp-server/src/ skills/`.

| # | File:line | Op | Target | Ownership | Before | After |
|---|---|---|---|---|---|---|
| 1 | `mcp-server/src/checkpoint.ts:174` | `renameSync(tmp, main)` | `.pi-flywheel/checkpoint.json[.tmp]` | flywheel | unguarded | `guardedRename` |
| 2 | `mcp-server/src/checkpoint.ts:271` (`clearCheckpoint`) | `unlinkSync(main)` | `.pi-flywheel/checkpoint.json` | flywheel | `existsSync + unlinkSync` | `guardedUnlink` |
| 3 | `mcp-server/src/checkpoint.ts:285` (`moveToCorrupt`) | `renameSync(file, corrupt)` | `.pi-flywheel/checkpoint.json[.corrupt]` | flywheel | unguarded + fallback `unlinkSync` | `guardedRename` + `isFlywheelManagedPath` assertion + `guardedUnlink` fallback |
| 4 | `mcp-server/src/checkpoint.ts:302` (`cleanupOrphanedTmp`) | `unlinkSync(tmp)` | `.pi-flywheel/checkpoint.json.tmp` | flywheel | `existsSync + unlinkSync` | `guardedUnlink` |
| 5 | `mcp-server/src/bead-review.ts:84,94` | `rmSync(outputDir, recursive:true)` | `$TMPDIR/pi-bead-review-<ts>/` | flywheel-scratch (tmpdir) | unguarded recursive-rm with a path we assembled ourselves | `guardedRemoveDir`; prefix changed to `pi-flywheel-bead-review-<ts>/` so the tmpdir allowlist recognises it as flywheel-owned |
| 6 | `mcp-server/src/telemetry.ts:221` (`atomicWriteExclusive`) | `rename(tmp, final)` | `.pi-flywheel/error-counts.json[.tmp]` | flywheel | unguarded (paths built from `spoolPath`/`tmpPath`) | `isFlywheelManagedPath` defence-in-depth guard at function entry |
| 7 | `mcp-server/src/telemetry.ts:228` | `unlink(tmp)` | `.pi-flywheel/error-counts.json.tmp` | flywheel | unguarded | covered by the guard added in #6 |
| 8 | `mcp-server/src/lint/baseline.ts:60` (`saveBaseline`) | `rename(tmp, path)` | user-supplied baseline path (e.g. `mcp-server/.lintskill-baseline.json`) | user-owned (VCS tracked) | unguarded atomic overwrite | **intentional**: only reachable via explicit `--update-baseline` CLI flag. Comment added; VCS is backup of record. |
| 9 | `mcp-server/src/lint/manifest.ts:28` (`saveManifest`) | `rename(tmp, path)` | user-supplied manifest path | user-owned (VCS tracked) | unguarded atomic overwrite | **intentional**: only reachable via explicit `--update-manifest` CLI flag. Comment added; VCS is backup of record. |
| 10 | `skills/brainstorming/scripts/server.cjs:290,304` | `fs.unlinkSync(events)`, `fs.unlinkSync(info)` | `$BRAINSTORM_DIR/state/{events,server-info}` | flywheel-scratch | `existsSync + unlinkSync` | **not rewired**: `.cjs` sidecar script, not part of the TS build. Paths are process-owned state files produced by the same script. Added to follow-ups. |

### Ownership rules used

A path is "flywheel-managed" iff its resolved form is inside one of:

- `<cwd>/.pi-flywheel/` (checkpoint, telemetry spool, backups)
- `<cwd>/.pi-flywheel-feedback/` (per-tool feedback jsonl)
- `<cwd>/mcp-server/dist/` (TypeScript build output)
- `$TMPDIR/pi-flywheel-<anything>/` (short-lived scratch)

Anything else is user-owned by default. The allowlist is defence-in-depth
against future refactors that introduce new destructive sites.

## Module: `mcp-server/src/utils/fs-safety.ts`

Exports:

- `isFlywheelManagedPath(absPath, cwd)` — pure predicate.
- `guardedUnlink(absPath, cwd)` — refuses targets outside the allowlist;
  idempotent on missing files.
- `backupThenReplace(absPath, cwd)` — copies existing content to
  `<cwd>/.pi-flywheel/_backup/<timestamp>/<basename>` *before* the
  caller overwrites. The timestamp folds in
  `process.hrtime.bigint()` + `process.pid`, not just
  `toISOString()` — this is the CE phase4 blunder #6 lesson applied
  directly (ISO-only timestamps collide at second-resolution under
  CI/test harnesses).
- `guardedRename(src, dest, cwd)` — refuses if *either* side is outside
  the allowlist.
- `guardedRemoveDir(absPath, cwd)` — recursive-rm, but refuses targets
  outside the allowlist and rejects non-directories (belt against a
  symlink-pointing-outside attack).
- `FLYWHEEL_MANAGED_DIRS`, `FLYWHEEL_TMP_PREFIX`, `BACKUP_SUBDIR`
  constants for callers that need to stay in sync with the allowlist.

## Backup convention

`<cwd>/.pi-flywheel/_backup/<ISO-<nanos>-<pid>>/<basename>`.

Example: `.pi-flywheel/_backup/2026-04-23T19-20-47-123Z-3892471223000000-17042/checkpoint.json`.

`_backup/` is inside `.pi-flywheel/` rather than the repo root, so it
rides along with whatever `.gitignore` already covers `.pi-flywheel/*`
(no new ignore rule required).

## Tests

`mcp-server/src/__tests__/utils/fs-safety.test.ts` (21 tests, all green):

- **user-owned file preserved** — `guardedUnlink` refuses a
  `skills/my-skill/SKILL.md` and leaves bytes intact;
- **flywheel-owned file updated** — `guardedUnlink` removes a
  `.pi-flywheel/checkpoint.json.tmp`;
- **backup created before overwrite** — `backupThenReplace` produces a
  timestamped subdir under `.pi-flywheel/_backup/` holding the previous
  bytes;
- collision-resistance: back-to-back `backupThenReplace` calls on the
  same target produce distinct backup dirs (hrtime+pid fold-in);
- prefix confusables: `.pi-flywheel-evil/` is rejected;
- `guardedRename` refuses if either side escapes the allowlist;
- `guardedRemoveDir` refuses to recursively-rm `skills/`.

## Findings summary

- No **existing** destructive site in the TS codebase targeted a
  user-owned path today. The forceSymlink blunder pattern **did not**
  reproduce as a live bug — but the defensive guards mean the next
  destructive site a future author adds must justify itself against
  the allowlist at the API boundary.
- The `.cjs` brainstorming sidecar was deliberately left alone: it
  does not import from the TS build, its targets are process-owned
  state files, and wiring TS imports into a plain Node script is out
  of scope for this bead.
- `saveBaseline`/`saveManifest` writes were **documented** rather than
  guarded. They are user-initiated (`--update-baseline`/`--update-manifest`
  CLI flags), and their targets are VCS-tracked — the backup of record
  is `git`.

## Follow-ups (out of scope for this bead)

- Migrate `skills/brainstorming/scripts/server.cjs` state writes to
  the flywheel tmpdir prefix so they fall under the same allowlist.
- Consider writing an ambient "pre-destructive-op" hook that audits
  every new `unlink*`/`rm*`/`rename*`/`symlink*` in `mcp-server/src/`
  via a custom lint rule — today's audit is point-in-time; CI
  enforcement is better.
- If an install command ever starts writing under `~/.agents/` or
  `~/.claude/`, add those as ownership roots with the user's consent,
  not as allowlist entries — the CE lesson is that shared-tenant user
  dirs are exactly where ownership checks matter most.
