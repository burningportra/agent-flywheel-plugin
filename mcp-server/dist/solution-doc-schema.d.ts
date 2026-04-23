/**
 * Durable `docs/solutions/` learning store — Zod schema + types.
 *
 * Purpose (bead agent-flywheel-plugin-71x, CE Proposal 1):
 *   Post-mortems in CASS are opaque — only queryable via `cm` CLI. A sibling
 *   markdown file under `docs/solutions/` with YAML frontmatter is:
 *     - greppable (`rg 'problem_type: flaky_test' docs/solutions/`)
 *     - reviewable in PRs (diff-visible knowledge capture)
 *     - portable across tools (plain markdown + YAML)
 *     - survives CASS DB corruption / schema migrations
 *
 * Reconciliation with CASS:
 *   Every SolutionDoc carries the `entry_id` returned by the `cm add` that
 *   persisted the paired post-mortem. Downstream sweepers (bead `bve`
 *   /flywheel-compound-refresh) join CASS <-> docs/solutions/ on this key.
 */
import { z } from 'zod';
export declare const SOLUTION_CATEGORIES: readonly ["build", "test", "runtime", "tooling", "coordination", "docs", "refactor", "general"];
export type SolutionCategory = (typeof SOLUTION_CATEGORIES)[number];
/**
 * YAML frontmatter carried on every docs/solutions/ entry.
 *
 * Invariants:
 *   F-1: entry_id links back to CASS for reconciliation (required).
 *   F-2: problem_type is a free-form short tag (e.g. "flaky_test",
 *        "stale_checkpoint") — used by `rg` filter queries.
 *   F-3: component identifies the subsystem touched (e.g.
 *        "episodic-memory", "worktree-pool").
 *   F-4: tags[] is free-form (empty array allowed).
 *   F-5: applies_when captures trigger conditions ("when sessionStartSha
 *        points to a rebased SHA").
 *   F-6: created_at is an ISO-8601 date (YYYY-MM-DD).
 */
export declare const SolutionDocFrontmatterSchema: z.ZodObject<{
    entry_id: z.ZodString;
    problem_type: z.ZodString;
    component: z.ZodString;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    applies_when: z.ZodDefault<z.ZodString>;
    created_at: z.ZodString;
}, z.core.$strip>;
export type SolutionDocFrontmatter = z.infer<typeof SolutionDocFrontmatterSchema>;
/** Full doc envelope — path relative to repo root + frontmatter + markdown body. */
export declare const SolutionDocSchema: z.ZodObject<{
    path: z.ZodString;
    frontmatter: z.ZodObject<{
        entry_id: z.ZodString;
        problem_type: z.ZodString;
        component: z.ZodString;
        tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
        applies_when: z.ZodDefault<z.ZodString>;
        created_at: z.ZodString;
    }, z.core.$strip>;
    body: z.ZodString;
}, z.core.$strip>;
export type SolutionDoc = z.infer<typeof SolutionDocSchema>;
/**
 * Slugify a free-form string into a filesystem-safe identifier.
 * Lowercased, non-alphanumerics collapsed to "-", trimmed, length-capped.
 */
export declare function slugifySolutionTitle(input: string): string;
/**
 * Heuristic category picker based on session goal + touched file paths.
 * Falls back to "general" when nothing matches. Pure function — safe to
 * call from tests.
 */
export declare function inferSolutionCategory(goal: string, touchedPaths: readonly string[]): SolutionCategory;
/**
 * Serialise a SolutionDoc to the exact markdown string that should be
 * written to disk. Frontmatter is emitted as minimal YAML — string fields
 * are JSON-quoted so colons / special chars survive a round-trip through
 * any conservative YAML parser.
 */
export declare function renderSolutionDoc(doc: SolutionDoc): string;
//# sourceMappingURL=solution-doc-schema.d.ts.map