/**
 * Tests for draftSolutionDoc (bead 71x).
 *
 * Invariants under test:
 *   S-1: degraded inputs (empty session) still yield a Zod-valid SolutionDoc
 *   S-2: frontmatter.entry_id is always populated from ctx.entryId
 *   S-3: path matches docs/solutions/<category>/<slug>-YYYY-MM-DD.md
 *   S-4: body re-uses post-mortem markdown
 *   reconciliation: entry_id flows through to rendered frontmatter
 */
export {};
//# sourceMappingURL=episodic-memory.solution-doc.test.d.ts.map