/**
 * Tests for flywheel_observe (T6, claude-orchestrator-29i).
 *
 * Acceptance coverage (per bead):
 *   1. no checkpoint / no beads → graceful empty snapshot
 *   2. corrupt-checkpoint warning surfaces
 *   3. WIZARD_*.md artifact detection
 *   4. br unavailable → graceful degradation (beads.unavailable=true)
 *   5. agent-mail unreachable → graceful degradation (agentMail.reachable=false)
 *   6. tool registers via the existing tool-listing path (TOOLS array + dispatch)
 */
export {};
//# sourceMappingURL=observe.test.d.ts.map