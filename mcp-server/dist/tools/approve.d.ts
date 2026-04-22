import type { ToolContext, McpToolResult, Bead, ApproveArgs, FlywheelPhase, HotspotMatrix } from '../types.js';
import { type HotspotInputBead } from '../plan-simulation.js';
/**
 * Map br CLI beads (which carry a `description` field) into the input shape
 * expected by `computeHotspotMatrix` (which expects `body`).
 *
 * **Gate 1 finding:** without this mapping, every bead enters
 * `computeHotspotMatrix` with `body: undefined` and the matrix silently
 * returns empty rows, causing the coordinator-serial recommendation to be
 * missed. Do not remove this adapter.
 */
export declare function beadsToHotspotInput(beads: Bead[]): HotspotInputBead[];
/**
 * Render a compact text summary of the hotspot matrix — top 3 hot files by
 * contention count. Used in the MCP `content[]` block to surface contention
 * to the user before they pick start/polish/reject.
 */
export declare function formatHotspotSummary(matrix: HotspotMatrix): string;
/**
 * Is the hotspot matrix severe enough to warrant the 4-option menu
 * (med/high rows) per the I5 plan spec?
 */
export declare function shouldOfferCoordinatorSerial(matrix: HotspotMatrix): boolean;
/**
 * Bead spec as produced by the synthesizer / plan-to-beads prompt, before it
 * becomes a concrete `Bead` via `br create`. Template hints are optional;
 * beads without a `template` hint flow through as free-form.
 */
export interface BeadPlanSpec {
    id?: string;
    title: string;
    /** Optional synthesizer-emitted hint, e.g. `"foundation-with-fresh-eyes-gate@1"`. */
    template?: string;
    /** Free-form description used when no template hint is present. */
    description?: string;
    /** Structured inputs passed to `expandTemplate` when `template` is set. */
    scope?: string;
    acceptance?: string;
    test_plan?: string;
    /** Catch-all for template-specific placeholders (`PARENT_WAVE_BEADS`, `TARGET_FILE`, …). */
    extraPlaceholders?: Record<string, string>;
}
/**
 * Discriminated expansion outcome for a single bead spec.
 *
 * - `status: 'expanded'` — template hint parsed and rendered cleanly; the
 *   `description` field holds the rendered body.
 * - `status: 'passthrough'` — no hint or malformed hint; the bead uses the
 *   caller-supplied `description` unchanged.
 * - `status: 'error'` — template hint parsed but expansion failed; the
 *   structured `errorResult` is a ready-to-return MCP tool envelope.
 */
export type BeadExpansionOutcome = {
    status: 'expanded';
    title: string;
    description: string;
    usedTemplate: {
        id: string;
        version: number;
    };
} | {
    status: 'passthrough';
    title: string;
    description: string;
} | {
    status: 'error';
    title: string;
    code: 'template_not_found' | 'template_placeholder_missing' | 'template_expansion_failed';
    detail: string;
    errorResult: McpToolResult;
};
/**
 * Expand a single bead spec at approve time. Pure function — safe to call
 * in tests and in the bead-creation path without touching br CLI state.
 *
 * @param phase Caller's current `FlywheelPhase`, threaded onto any error
 *              envelope so the SKILL.md orchestrator branches correctly.
 */
export declare function expandBeadPlanSpec(spec: BeadPlanSpec, phase: FlywheelPhase): BeadExpansionOutcome;
/**
 * Expand every bead spec at approve time, returning ordered outcomes.
 *
 * Callers iterate results: `expanded` + `passthrough` beads proceed to
 * `br create`; the first `error` outcome's `errorResult` should be returned
 * from the tool handler to surface the FlywheelErrorCode envelope to the
 * SKILL.md orchestrator.
 */
export declare function expandBeadPlanSpecs(specs: BeadPlanSpec[], phase: FlywheelPhase): BeadExpansionOutcome[];
/**
 * flywheel_approve_beads — Review and approve bead graph before implementation.
 *
 * action="start"    — Approve beads and launch implementation
 * action="polish"   — Request another refinement round
 * action="reject"   — Reject and stop the flywheel
 * action="advanced" — Advanced refinement (requires advancedAction param)
 */
export declare function runApprove(ctx: ToolContext, args: ApproveArgs): Promise<McpToolResult>;
//# sourceMappingURL=approve.d.ts.map