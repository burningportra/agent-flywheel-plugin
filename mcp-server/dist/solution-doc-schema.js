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
// ─── Category taxonomy ──────────────────────────────────────────
//
// Chosen to match typical post-mortem shapes observed in flywheel sessions.
// Kept deliberately small; `general` is the safe default when nothing else
// fits. Downstream bead `bve` is free to introduce new categories — the
// schema accepts any non-empty string, these are just the canonical set.
export const SOLUTION_CATEGORIES = [
    'build', // build / compile / type-check failures
    'test', // flaky tests, coverage gaps, test infra
    'runtime', // production / runtime behaviour
    'tooling', // CLI ergonomics, dev-loop, editor integration
    'coordination', // multi-agent / swarm / agent-mail
    'docs', // doc rot, skill refinement, README
    'refactor', // architecture, extract, rename
    'general', // fallback
];
// ─── Zod schema for frontmatter ────────────────────────────────
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
export const SolutionDocFrontmatterSchema = z.object({
    /** CASS entry id returned by `cm add`. Links doc → CASS for reconciliation. */
    entry_id: z.string().min(1),
    /** Short tag for problem kind (e.g. "flaky_test", "stale_checkpoint"). */
    problem_type: z.string().min(1),
    /** Subsystem touched (e.g. "episodic-memory"). */
    component: z.string().min(1),
    /** Free-form tag list. May be empty. */
    tags: z.array(z.string()).default([]),
    /** Natural-language trigger condition. */
    applies_when: z.string().default(''),
    /** ISO-8601 creation date (YYYY-MM-DD). */
    created_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
});
/** Full doc envelope — path relative to repo root + frontmatter + markdown body. */
export const SolutionDocSchema = z.object({
    /** Relative path: docs/solutions/<category>/<slug>-<date>.md */
    path: z.string().regex(/^docs\/solutions\/[a-z0-9-]+\/[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.md$/, 'path must match docs/solutions/<category>/<slug>-YYYY-MM-DD.md'),
    frontmatter: SolutionDocFrontmatterSchema,
    body: z.string(),
});
// ─── Helpers ────────────────────────────────────────────────────
/**
 * Slugify a free-form string into a filesystem-safe identifier.
 * Lowercased, non-alphanumerics collapsed to "-", trimmed, length-capped.
 */
export function slugifySolutionTitle(input) {
    const s = input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return s || 'session';
}
/**
 * Heuristic category picker based on session goal + touched file paths.
 * Falls back to "general" when nothing matches. Pure function — safe to
 * call from tests.
 */
export function inferSolutionCategory(goal, touchedPaths) {
    const hay = `${goal} ${touchedPaths.join(' ')}`.toLowerCase();
    if (/\btest\b|vitest|jest|spec\b|\bflak/i.test(hay))
        return 'test';
    if (/\bbuild\b|tsc|webpack|vite|rollup|compile/i.test(hay))
        return 'build';
    if (/\bskill\b|\breadme\b|\bdocs?\b|changelog/i.test(hay))
        return 'docs';
    if (/agent-mail|swarm|worktree|coordinat/i.test(hay))
        return 'coordination';
    if (/refactor|rename|extract|split|migrate/i.test(hay))
        return 'refactor';
    if (/\bcli\b|tool|editor|ergonom/i.test(hay))
        return 'tooling';
    if (/runtime|produc|crash|panic|oom/i.test(hay))
        return 'runtime';
    return 'general';
}
/**
 * Serialise a SolutionDoc to the exact markdown string that should be
 * written to disk. Frontmatter is emitted as minimal YAML — string fields
 * are JSON-quoted so colons / special chars survive a round-trip through
 * any conservative YAML parser.
 */
export function renderSolutionDoc(doc) {
    const fm = doc.frontmatter;
    const lines = ['---'];
    lines.push(`entry_id: ${JSON.stringify(fm.entry_id)}`);
    lines.push(`problem_type: ${JSON.stringify(fm.problem_type)}`);
    lines.push(`component: ${JSON.stringify(fm.component)}`);
    lines.push(`tags: [${fm.tags.map((t) => JSON.stringify(t)).join(', ')}]`);
    lines.push(`applies_when: ${JSON.stringify(fm.applies_when)}`);
    lines.push(`created_at: ${fm.created_at}`);
    lines.push('---');
    lines.push('');
    lines.push(doc.body);
    return lines.join('\n');
}
//# sourceMappingURL=solution-doc-schema.js.map