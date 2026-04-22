/**
 * I5 — Hotspot matrix injection into flywheel_approve_beads.
 *
 * Coverage:
 *   - 3 beads sharing a file via `### Files:` section → 4-option menu +
 *     matrix visible in structuredContent.
 *   - Empty / single-bead case → legacy 3-option menu + empty matrix rows.
 *   - Regression for Gate 1 finding: Bead.description must be mapped to
 *     HotspotInputBead.body at the adapter boundary. If this test passes,
 *     the `description → body` surprise is correctly handled.
 */
export {};
//# sourceMappingURL=approve.hotspot.test.d.ts.map