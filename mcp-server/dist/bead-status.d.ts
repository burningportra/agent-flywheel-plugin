import { z } from "zod";
export declare const BEAD_STATUSES: readonly ["open", "in_progress", "blocked", "closed", "deferred"];
export type BeadStatus = (typeof BEAD_STATUSES)[number];
export declare const BeadStatusSchema: z.ZodEnum<{
    open: "open";
    in_progress: "in_progress";
    blocked: "blocked";
    closed: "closed";
    deferred: "deferred";
}>;
/** Unfinished work: open, in progress, or waiting on a blocker. Deferred and closed beads are not. */
export declare function isActiveBeadStatus(status: BeadStatus): boolean;
export declare function normalizeBrStatus(raw: unknown): BeadStatus | null;
/** A status as br emits it, read into the flywheel's status. Unknown values fail with the raw value in the issue. */
export declare const BrStatusSchema: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodEnum<{
    open: "open";
    in_progress: "in_progress";
    blocked: "blocked";
    closed: "closed";
    deferred: "deferred";
}>>;
//# sourceMappingURL=bead-status.d.ts.map