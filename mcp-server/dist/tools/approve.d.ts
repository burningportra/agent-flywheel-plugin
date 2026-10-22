import type { ToolContext, McpToolResult, Bead, ApproveArgs, HotspotMatrix } from '../types.js';
import { type HotspotInputBead } from '../plan-simulation.js';
/**
 * Bead agent-flywheel-plugin-jl5 — cap for the converge-polish loop
 * (July 2026 Complete Guide §6x Polish). The loop also stops early after
 * 2 consecutive zero-change rounds (steady state).
 */
export declare const MAX_POLISH_ROUNDS = 6;
/**
 * Bead agent-flywheel-plugin-jl5 — widened approve args.
 *
 * `converge-polish` (6x Polish convergence loop) and `verify-bead`
 * (independent SHA + patch-id verification) are handled inside this module.
 * The MCP inputSchema enum in server.ts is intentionally untouched here —
 * the follow-up wiring bead extends it. Callers holding a narrow
 * `ApproveArgs` still satisfy this interface.
 */
export interface ExtendedApproveArgs extends Omit<ApproveArgs, 'action'> {
    action: ApproveArgs['action'] | 'converge-polish' | 'verify-bead';
    /** Required when action='verify-bead': bead whose completion report to verify. */
    beadId?: string;
}
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
export declare function runApprove(ctx: ToolContext, args: ExtendedApproveArgs): Promise<McpToolResult>;
/**
 * `bv --robot-insights` carries two per-bead maps (`Stats`, `full_stats`) that
 * cover every bead in the repository; on a 600-bead repo they are ~120k chars
 * and push the converge-polish result past the MCP result limit. The ranked
 * lists the polish loop reads (Bottlenecks, Keystones, ...) are kept.
 */
export declare function withoutPerBeadStats(data: unknown): unknown;
//# sourceMappingURL=approve.d.ts.map