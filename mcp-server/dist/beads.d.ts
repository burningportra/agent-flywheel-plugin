import type { ExecFn } from "./exec.js";
import type { Bead } from "./types.js";
/**
 * Check if a bead ID matches the expected br-NNN pattern.
 * The br CLI generates IDs like "br-1", "br-42", "br-123".
 * Non-conforming IDs may break Agent Mail thread_id conventions.
 */
export declare function isValidBeadId(id: string): boolean;
/**
 * Find beads with non-standard IDs in a list.
 */
export declare function findNonStandardIds(beads: Bead[]): string[];
export interface TemplateHygieneIssue {
    beadId: string;
    issueType: "raw-template-marker" | "template-shorthand" | "unresolved-placeholder" | "template-missing-structure";
    excerpt: string;
    reason: string;
}
export interface PlanAuditMatch {
    beadId: string;
    title: string;
    score: number;
}
export interface PlanAuditSection {
    heading: string;
    summary: string;
    matches: PlanAuditMatch[];
}
export interface PlanToBeadAudit {
    sections: PlanAuditSection[];
    uncoveredSections: PlanAuditSection[];
    weakMappings: PlanAuditSection[];
}
export type BeadDuplicateReason = "near-duplicate-title" | "shared-files-similar-intent";
export interface BeadDuplicateCandidate {
    beadIds: [string, string];
    canonicalBeadId: string;
    duplicateBeadId: string;
    reasons: BeadDuplicateReason[];
    sharedFiles: string[];
}
export interface BeadCreationAudit {
    planCoverage: (PlanToBeadAudit & {
        totalSections: number;
        coveredSections: number;
    }) | null;
    duplicateCandidates: BeadDuplicateCandidate[];
}
export declare function auditPlanToBeads(plan: string, beads: Bead[]): PlanToBeadAudit;
/**
 * Audits a newly-created bead set once, so every caller uses the same
 * coverage and duplicate heuristics instead of reimplementing them in prose.
 */
export declare function auditBeadCreation(plan: string | undefined, beads: Bead[]): BeadCreationAudit;
/**
 * Reads every ready bead (unblocked) via `br ready --limit 0 --json`.
 */
export declare function readyBeads(exec: ExecFn, cwd: string): Promise<Bead[]>;
/**
 * Normalize the shape of `br show --json` output across br versions.
 *
 * br has returned the bead in several shapes historically:
 *   - `{...}`              (object)                — older br
 *   - `[{...}]`            (single-element array)  — current br v0.1.x
 *   - `{ bead: {...} }`    (wrapped)               — observed in some forks
 *   - `{ issues: [{...}] }` (plural wrapper)       — older parser adapters
 *
 * This helper unwraps any of the above to a single bead object. Returns the
 * input unchanged if no known wrapper matches, letting `parseBead` make the
 * final call on shape validity.
 */
export declare function unwrapBrShowValue(raw: unknown): unknown;
/**
 * Extracts artifact file paths from a bead's description.
 * Looks for a '### Files:' section or bullet lines starting with known prefixes
 * (src/, lib/, test/, tests/, dist/, docs/). Files outside these directories
 * won't be detected unless they appear in a '### Files:' section.
 */
export declare function extractArtifacts(bead: Bead): string[];
/**
 * Quality check result for a single bead.
 */
export interface QualityFailure {
    beadId: string;
    check: string;
    reason: string;
}
/**
 * Returns a human-readable summary of bead states.
 */
export declare function getBeadsSummary(beads: Bead[]): string;
export interface BeadStraggler {
    id: string;
    status: Bead["status"];
}
export interface VerifyBeadsClosedReport {
    /** Bead IDs whose `br show` returned status === "closed". */
    closed: string[];
    /** Bead IDs that are still open / in_progress / deferred. */
    stragglers: BeadStraggler[];
    /** Bead IDs whose `br show` failed, mapped to error message. */
    errors: Record<string, string>;
}
/**
 * Verify a list of beads are closed. Returns each bead classified as
 * closed / straggler / errored. Bypasses the read cache so reconciliation
 * sees freshly-updated state.
 */
export declare function verifyBeadsClosed(exec: ExecFn, cwd: string, beadIds: string[]): Promise<VerifyBeadsClosedReport>;
//# sourceMappingURL=beads.d.ts.map