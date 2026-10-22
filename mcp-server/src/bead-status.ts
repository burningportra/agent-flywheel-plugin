import { z } from "zod";

export const BEAD_STATUSES = ["open", "in_progress", "blocked", "closed", "deferred"] as const;

export type BeadStatus = (typeof BEAD_STATUSES)[number];

export const BeadStatusSchema = z.enum(BEAD_STATUSES);

/** Unfinished work: open, in progress, or waiting on a blocker. Deferred and closed beads are not. */
export function isActiveBeadStatus(status: BeadStatus): boolean {
  return status === "open" || status === "in_progress" || status === "blocked";
}

// br stores any string passed to `br update --status`, so these are the ones
// with an obvious flywheel meaning. `pinned` beads are standing context, not work.
const BR_STATUS_ALIASES: ReadonlyMap<string, BeadStatus> = new Map([
  ["completed", "closed"],
  ["done", "closed"],
  ["pinned", "deferred"],
]);

export function normalizeBrStatus(raw: unknown): BeadStatus | null {
  if (typeof raw !== "string") return null;
  if ((BEAD_STATUSES as readonly string[]).includes(raw)) return raw as BeadStatus;
  return BR_STATUS_ALIASES.get(raw) ?? null;
}

/** A status as br emits it, read into the flywheel's status. Unknown values fail with the raw value in the issue. */
export const BrStatusSchema = z.preprocess((raw) => normalizeBrStatus(raw) ?? raw, BeadStatusSchema);
