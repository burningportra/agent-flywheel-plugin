import { z } from "zod";
export const BEAD_STATUSES = ["open", "in_progress", "closed", "deferred"];
export const BeadStatusSchema = z.enum(BEAD_STATUSES);
// br stores any string passed to `br update --status`, so these are the ones
// with an obvious flywheel meaning. `blocked` stays open because `br ready`
// already holds it back; `pinned` beads are standing context, not work.
const BR_STATUS_ALIASES = new Map([
    ["completed", "closed"],
    ["done", "closed"],
    ["blocked", "open"],
    ["pinned", "deferred"],
]);
export function normalizeBrStatus(raw) {
    if (typeof raw !== "string")
        return null;
    if (BEAD_STATUSES.includes(raw))
        return raw;
    return BR_STATUS_ALIASES.get(raw) ?? null;
}
/** A status as br emits it, read into the flywheel's status. Unknown values fail with the raw value in the issue. */
export const BrStatusSchema = z.preprocess((raw) => normalizeBrStatus(raw) ?? raw, BeadStatusSchema);
//# sourceMappingURL=bead-status.js.map