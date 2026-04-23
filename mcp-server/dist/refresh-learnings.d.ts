/**
 * Compound-Engineering refresh sweep — bead `bve`.
 *
 * Purpose (Proposal 2):
 *   The `docs/solutions/` learning store accumulates monotonically. Without
 *   periodic pruning it contradicts itself — lessons for a component that
 *   has since been rewritten sit alongside the post-rewrite lesson, and
 *   nothing flags the drift. This module implements the 5-vector overlap
 *   scorer + Keep/Update/Consolidate/Replace/Delete classifier borrowed
 *   from CE's `ce-compound-refresh` Phase 1.75 "Document-Set Analysis".
 *
 * Shape of the pipeline (pure — I/O is injected so tests can stub it):
 *
 *     listSolutionDocPaths(root, fs) ─┐
 *                                     ├─> readSolutionDocs(fs, parse)
 *     parseSolutionDoc(markdown)   ───┘                │
 *                                                      ▼
 *                                    groupSolutionDocs(by problem_type × component)
 *                                                      │
 *                                                      ▼
 *                                    scoreOverlap(a, b)  — 5-vector cosine-ish
 *                                                      │
 *                                                      ▼
 *                                    classifyGroup(docs, opts) → Keep | Update |
 *                                                                Consolidate |
 *                                                                Replace | Delete
 *
 * Invariants:
 *   R-1: Delete is NEVER emitted without stale-evidence AND crossing an
 *        *explicit* `deleteThreshold`. Callers must additionally gate Delete
 *        behind AskUserQuestion before acting on it.
 *   R-2: The scorer is symmetric — score(a,b) === score(b,a) — up to
 *        floating-point rounding. Tested directly.
 *   R-3: All classifications are additive: the pipeline NEVER mutates the
 *        input SolutionDoc array. Archival is the skill's job, not ours.
 *   R-4: Stale-file detection (a solution doc's `component` has no matching
 *        files in the working tree) is a STRONG signal for Delete, but we
 *        still require rename detection via `git log --follow` before
 *        returning Delete (caller supplies a `staleProbe` for this).
 *
 * Non-goals:
 *   - We do NOT touch CASS here. CASS reconciliation happens via
 *     `entry_id` at a later stage (out of scope for this bead).
 *   - We do NOT write or delete files. Classification is advisory; the
 *     skill owns all filesystem mutations (archival, edits).
 */
import { type SolutionDoc, type SolutionDocFrontmatter } from './solution-doc-schema.js';
/**
 * The five overlap dimensions CE's Phase 1.75 rubric scores. Each score is
 * in [0, 1]; the final overall score is the mean of the five.
 *
 *   - problem:    similarity of `problem_type` (+ small title influence)
 *   - rootCause:  body sections that discuss root-cause / "why" passages
 *   - solution:   body sections that discuss the fix itself
 *   - files:      overlap of file paths referenced in the body
 *   - prevention: `applies_when` + prevention/guardrail language overlap
 *
 * We surface the per-dimension scores so the skill can show the user *why*
 * two docs were deemed duplicates, not just "they're 0.83 similar".
 */
export interface OverlapScore {
    problem: number;
    rootCause: number;
    solution: number;
    files: number;
    prevention: number;
    overall: number;
}
/** The five classifications CE's refresh rubric produces. */
export type RefreshClassification = 'Keep' | 'Update' | 'Consolidate' | 'Replace' | 'Delete';
/**
 * One classification decision attached to a group of related docs.
 *
 * `docs` always has ≥1 member; for Keep on a singleton, it has exactly 1.
 * For Consolidate/Replace it has ≥2, with `primary` indexing the doc the
 * sweep recommends keeping (newest or highest-quality — heuristic).
 */
export interface RefreshDecision {
    classification: RefreshClassification;
    /** Docs implicated in this decision. Never mutated. */
    docs: SolutionDoc[];
    /** Index into `docs` of the preferred/primary entry. */
    primary: number;
    /** Score matrix: scores[i][j] = scoreOverlap(docs[i], docs[j]). */
    scores: OverlapScore[][];
    /** Short reason surfaced to the user and archived in the decision log. */
    reason: string;
    /**
     * Relative paths recommended for archival (moved to docs/solutions/_archive/).
     * Empty for Keep/Update. Always a subset of docs[].path.
     */
    archiveCandidates: string[];
}
export interface RefreshReport {
    /** One decision per group. */
    decisions: RefreshDecision[];
    /** Docs that could not be parsed — surfaced to the user, never auto-acted on. */
    unparseable: Array<{
        path: string;
        reason: string;
    }>;
    /** Seconds of wall clock the sweep spent. Diagnostic only. */
    elapsedMs: number;
}
export interface RefreshOptions {
    /**
     * Pairwise overall score ≥ this triggers Consolidate/Replace. 0 = everything
     * collapses; 1 = nothing ever does. CE's rubric uses 0.75; we match.
     */
    consolidateThreshold?: number;
    /**
     * Overall ≥ this AND the newer doc's files no longer exist → Replace.
     * Default 0.85 (strictly stronger than Consolidate).
     */
    replaceThreshold?: number;
    /**
     * Single-doc stale evidence strength ≥ this → Delete candidate. Only
     * honoured when `staleProbe` is supplied. Default 0.9.
     */
    deleteThreshold?: number;
    /**
     * Optional probe that, given a SolutionDoc, returns stale evidence in
     * [0, 1]: 0 = component files exist and reference the doc's topic;
     * 1 = component paths are gone AND git log --follow shows no rename.
     *
     * Keeping this injected means the refresh algorithm stays pure and the
     * skill can wire in ripgrep + `git log --follow` without this module
     * having to shell out.
     */
    staleProbe?: (doc: SolutionDoc) => Promise<number>;
}
/**
 * Filesystem adapter — injected so tests can run without a real FS.
 *
 * Only the two operations we actually need; do not grow this interface
 * without checking whether a test stub has to grow in lock-step.
 */
export interface RefreshFs {
    /** Recursively list *.md under `root`. Paths returned are relative to `root`. */
    listMarkdown(root: string): Promise<string[]>;
    /** Read a file's raw text. */
    readFile(absPath: string): Promise<string>;
}
/**
 * Parse the exact YAML shape produced by `renderSolutionDoc` — a fenced
 * `---\n...\n---\n` block where every scalar is JSON-quoted and the only
 * array is `tags: ["a", "b"]`. We don't pull in a full YAML library
 * because (a) the input is machine-generated and (b) sibling beads are
 * modifying package.json, which we're told not to touch.
 *
 * Returns `null` on malformed input; caller surfaces that to the user.
 */
export declare function parseSolutionDocMarkdown(raw: string): {
    frontmatter: SolutionDocFrontmatter;
    body: string;
} | null;
/**
 * Score the 5-vector overlap between two SolutionDocs.
 *
 * Symmetric (R-2). Returns `overall = mean(problem, rootCause, solution,
 * files, prevention)` — CE's Phase 1.75 uses a straight mean; we preserve
 * that so the numbers are directly comparable to their rubric.
 */
export declare function scoreOverlap(a: SolutionDoc, b: SolutionDoc): OverlapScore;
/** Group SolutionDocs by (problem_type, component). Pure; stable iteration. */
export declare function groupSolutionDocs(docs: SolutionDoc[]): SolutionDoc[][];
/**
 * Classify a single group of SolutionDocs sharing (problem_type, component).
 *
 * Rules (applied in order, first match wins):
 *   1. Singleton + high stale score  → Delete  (requires staleProbe + deleteThreshold)
 *   2. Singleton                     → Keep
 *   3. Any pair ≥ replaceThreshold AND one is stale → Replace (keep fresh, archive stale)
 *   4. Any pair ≥ consolidateThreshold             → Consolidate (keep primary, archive rest)
 *   5. otherwise                                   → Update (all kept, flagged for merge)
 *
 * The returned `scores` matrix is full (i,j) filled, diagonal = 1.0 self-sim.
 */
export declare function classifyGroup(docs: SolutionDoc[], opts: Required<Omit<RefreshOptions, 'staleProbe'>> & Pick<RefreshOptions, 'staleProbe'>): Promise<RefreshDecision>;
/**
 * Run the full sweep: list → parse → group → classify.
 *
 * Any parse failure on an individual doc is surfaced in `unparseable[]`
 * but does NOT abort the sweep — we prefer a partial report over none.
 */
export declare function refreshLearnings(root: string, fs: RefreshFs, options?: RefreshOptions): Promise<RefreshReport>;
//# sourceMappingURL=refresh-learnings.d.ts.map