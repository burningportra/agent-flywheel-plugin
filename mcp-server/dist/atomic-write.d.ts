/**
 * `writeAtomic(filePath, content)` — POSIX-atomic file write helper.
 *
 * Pattern: `mkdir(dir, recursive)` → `writeFile(<filePath>.tmp, content)`
 * → `rename(<filePath>.tmp, filePath)`.
 *
 * `rename(2)` is atomic on POSIX filesystems — a concurrent reader sees
 * either the old file or the new file, never a half-written one. This
 * matters for `rubric.md` (read by `parseRubricFrontmatter`,
 * `flywheel_doctor`'s `outcome_rubric_validity` check, and the welcome
 * banner) and for `iteration-<N>.json` (read by future `flywheel_observe`
 * grading-history rendering and any cross-cycle telemetry tool).
 *
 * If the rename step throws, the orphan `.tmp` file remains on disk; the
 * next successful write replaces it. We do NOT auto-delete the orphan
 * because a half-finished tmp is occasionally useful for post-mortem
 * forensics (and `git status` will surface it if it ever lands inside a
 * tracked path).
 *
 * `completion-report.ts:writeCompletionReport` is intentionally NOT
 * retrofitted here — it has a different call-site contract (single
 * implementor, no concurrent reader, called once per bead) and the
 * naive `writeFile` is fine for that use.
 *
 * Bead: claude-orchestrator-3u4 (T3).
 */
/**
 * Atomically write `content` to `filePath`. Creates parent directories as
 * needed. Throws whatever `mkdir`, `writeFile`, or `rename` throws — the
 * caller is responsible for branching on `ENOSPC` / `EROFS` / etc.
 *
 * The tmp filename is `<basename>.tmp`. If two writers race on the same
 * `filePath`, the last-rename-wins; both renames are individually atomic.
 * Outcome-grading callers serialize via the in-memory mutex in
 * `gradeOutcome`, so this race never materialises in practice.
 */
export declare function writeAtomic(filePath: string, content: string): Promise<void>;
//# sourceMappingURL=atomic-write.d.ts.map