import type { ToolContext, McpToolResult, Bead, ApproveArgs, HotspotMatrix } from '../types.js';
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
 * flywheel_approve_beads — Review and approve bead graph before implementation.
 *
 * action="start"    — Approve beads and launch implementation
 * action="polish"   — Request another refinement round
 * action="reject"   — Reject and stop the flywheel
 * action="advanced" — Advanced refinement (requires advancedAction param)
 */
export declare function runApprove(ctx: ToolContext, args: ApproveArgs): Promise<McpToolResult>;
//# sourceMappingURL=approve.d.ts.map