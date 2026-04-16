import type { ExecFn } from "./exec.js";
import type { Bead, BvInsights, BvNextPick } from "./types.js";
/** Clear all session caches. Call after bead mutations (create/update/close). */
export declare function invalidateBeadCache(): void;
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
export declare function auditPlanToBeads(plan: string, beads: Bead[]): PlanToBeadAudit;
/**
 * Detects whether the `bv` CLI is available. Result is cached.
 */
export declare function detectBv(exec: ExecFn): Promise<boolean>;
/** Reset bv detection cache (for testing). */
export declare function resetBvCache(): void;
/**
 * Runs `bv --robot-insights` and returns typed graph health data.
 * Returns null if bv is unavailable or output can't be parsed.
 */
export declare function bvInsights(exec: ExecFn, cwd: string): Promise<BvInsights | null>;
/**
 * Runs `bv --robot-triage` and returns a prioritised list of beads for
 * multiple parallel agents, each routed to a graph-safe non-contending bead.
 * Distinct from --robot-next (which picks one bead for one agent):
 * --robot-triage accounts for which beads can be worked on in parallel
 * without contending on the same bottleneck node.
 * Returns null if bv is unavailable or output can't be parsed.
 */
export declare function bvTriage(exec: ExecFn, cwd: string): Promise<BvNextPick[] | null>;
/**
 * Runs `bv --robot-next` and returns the highest-priority next bead.
 * Returns null if bv is unavailable, no actionable items, or parse error.
 */
export declare function bvNext(exec: ExecFn, cwd: string): Promise<BvNextPick | null>;
/**
 * Runs `bv --robot-plan` and returns the raw output string.
 * Returns null if bv is unavailable, empty output, or error.
 */
export declare function bvPlan(exec: ExecFn, cwd: string): Promise<string | null>;
/**
 * Reads all beads via `br list --json`.
 */
export declare function readBeads(exec: ExecFn, cwd: string): Promise<Bead[]>;
/**
 * Reads ready beads (unblocked) via `br ready --json`.
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
 * Gets a single bead by ID via `br show <id> --json`.
 */
export declare function getBeadById(exec: ExecFn, cwd: string, id: string): Promise<Bead | null>;
/**
 * Lists dependency IDs for a bead via `br dep list <id>`.
 */
export declare function beadDeps(exec: ExecFn, cwd: string, id: string): Promise<string[]>;
/**
 * Extracts artifact file paths from a bead's description.
 * Looks for a '### Files:' section or bullet lines starting with known prefixes
 * (src/, lib/, test/, tests/, dist/, docs/). Files outside these directories
 * won't be detected unless they appear in a '### Files:' section.
 */
export declare function extractArtifacts(bead: Bead): string[];
/**
 * Updates the status of a bead.
 */
export declare function updateBeadStatus(exec: ExecFn, cwd: string, beadId: string, status: "in_progress" | "closed" | "deferred"): Promise<void>;
/**
 * Syncs beads to disk.
 */
export declare function syncBeads(exec: ExecFn, cwd: string): Promise<void>;
/**
 * Closes orphaned beads by setting their status to "closed".
 * Returns the list of IDs that were successfully closed.
 */
export declare function remediateOrphans(exec: ExecFn, cwd: string, orphanIds: string[]): Promise<{
    closed: string[];
    failed: string[];
}>;
/**
 * Validates beads — checks for dependency cycles, orphaned open beads, and graph health.
 * When bv is available, uses graph-theoretic analysis for richer validation.
 */
export declare function validateBeads(exec: ExecFn, cwd: string): Promise<{
    ok: boolean;
    orphaned: string[];
    cycles: boolean;
    warnings: string[];
    shallowBeads: {
        id: string;
        reason: string;
    }[];
    templateIssues: TemplateHygieneIssue[];
}>;
/**
 * Quality check result for a single bead.
 */
export interface QualityFailure {
    beadId: string;
    check: string;
    reason: string;
}
/**
 * Validates each open bead against automated quality checks.
 */
export declare function qualityCheckBeads(exec: ExecFn, cwd: string): Promise<{
    passed: boolean;
    failures: QualityFailure[];
}>;
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