/**
 * Tests for the draft_solution_doc branch of runMemory (bead 71x).
 *
 * Coverage:
 *   - missing entryId → invalid_input error envelope
 *   - happy path → structuredContent.data.kind === 'solution_doc_draft'
 *   - rendered markdown contains the entry_id (reconciliation join key)
 *   - never invokes `cm` CLI (no CASS write side-effect)
 */
export {};
//# sourceMappingURL=memory-tool.solution-doc.test.d.ts.map