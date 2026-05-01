/**
 * Completion Evidence Attestation — Stage 1 schema + parser.
 *
 * Every NTM-spawned implementor writes a versioned `CompletionReport` JSON to
 * `.pi-flywheel/completion/<beadId>.json` before closing its bead. The
 * coordinator-side validators (`flywheel_verify_beads` /
 * `flywheel_advance_wave`, T2) read these files to gate wave advancement.
 *
 * Schema is `version: 1` and additive forever — never remove keys; new fields
 * must be optional. See `docs/duels/2026-04-30.md` Consensus Winner #1 for the
 * full design rationale (PI1 reaction-phase concession on additive-only
 * evolution; PI2 reveal-phase concession that Stage 1 ships JSON-only).
 */
import { z } from "zod";
export declare const COMPLETION_REPORT_DIR = ".pi-flywheel/completion";
export declare const CompletionStatusEnum: z.ZodEnum<{
    partial: "partial";
    blocked: "blocked";
    closed: "closed";
}>;
export type CompletionStatus = z.infer<typeof CompletionStatusEnum>;
/**
 * `CompletionReportSchemaV1` — additive forever; never remove keys.
 *
 * Required fields are the duel-agreed minimum. Optional fields (`paneName`,
 * `ubs.skippedReason`, `reservationsReleased`) carry context useful to
 * downstream tools but are not strictly load-bearing.
 */
export declare const CompletionReportSchemaV1: z.ZodObject<{
    version: z.ZodLiteral<1>;
    beadId: z.ZodString;
    agentName: z.ZodString;
    paneName: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<{
        partial: "partial";
        blocked: "blocked";
        closed: "closed";
    }>;
    changedFiles: z.ZodArray<z.ZodString>;
    commits: z.ZodArray<z.ZodString>;
    ubs: z.ZodObject<{
        ran: z.ZodBoolean;
        summary: z.ZodString;
        findingsFixed: z.ZodDefault<z.ZodNumber>;
        deferredBeadIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
        skippedReason: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    verify: z.ZodArray<z.ZodObject<{
        command: z.ZodString;
        exitCode: z.ZodNumber;
        summary: z.ZodString;
    }, z.core.$strip>>;
    selfReview: z.ZodObject<{
        ran: z.ZodBoolean;
        summary: z.ZodString;
    }, z.core.$strip>;
    beadClosedVerified: z.ZodBoolean;
    reservationsReleased: z.ZodOptional<z.ZodBoolean>;
    createdAt: z.ZodString;
}, z.core.$strip>;
export type CompletionReportV1 = z.infer<typeof CompletionReportSchemaV1>;
export declare function completionReportPath(cwd: string, beadId: string): string;
export type CompletionReportReadError = {
    code: "not_found";
    message: string;
    path: string;
} | {
    code: "invalid_json";
    message: string;
    path: string;
} | {
    code: "schema_invalid";
    message: string;
    path: string;
    issues: z.core.$ZodIssue[];
};
export type CompletionReportReadResult = {
    ok: true;
    report: CompletionReportV1;
    path: string;
} | {
    ok: false;
    error: CompletionReportReadError;
};
/**
 * Read + parse + schema-validate `.pi-flywheel/completion/<beadId>.json`.
 *
 * Does NOT cross-check against a bead — call `validateCompletionReport` for
 * that. Use `readCompletionReport` when you only have a beadId; use
 * `validateCompletionReport` when you also have the bead record from `br`.
 */
export declare function readCompletionReport(cwd: string, beadId: string): Promise<CompletionReportReadResult>;
export type ValidationIssue = {
    code: "bead_id_mismatch" | "closed_without_verification" | "path_escapes_cwd" | "status_mismatch";
    message: string;
    field?: string;
};
export type BeadShape = {
    id: string;
    /** Status string from `br show --json`. Optional; only used when present. */
    status?: string;
};
export type CompletionReportValidation = {
    ok: true;
} | {
    ok: false;
    issues: ValidationIssue[];
};
/**
 * Cross-check a parsed `CompletionReportV1` against the bead it claims to
 * cover, plus optional cwd-escape verification of `changedFiles`.
 *
 * Invariants enforced:
 *   - report.beadId === bead.id
 *   - status === "closed" implies beadClosedVerified === true
 *   - if cwd is provided, every changedFile resolves inside cwd
 *
 * The schema-level validation in `CompletionReportSchemaV1` already rejects
 * absolute paths and obvious `..` traversal — the cwd-resolve check here
 * catches the residual escape cases (e.g. symlink-shaped paths whose textual
 * form looks safe).
 */
export declare function validateCompletionReport(report: CompletionReportV1, bead: BeadShape, opts?: {
    cwd?: string;
}): CompletionReportValidation;
/**
 * Render a one-line evidence summary for log lines, completion-message
 * acknowledgements, and `flywheel_observe.hints[]` rendering. Stable
 * format — downstream tools may grep this.
 */
export declare function formatCompletionEvidenceSummary(report: CompletionReportV1): string;
/**
 * Write a completion report to disk. Creates the parent directory if needed.
 * Caller is responsible for serialising the report against the schema first;
 * pass a `CompletionReportV1` that has already been parsed/validated.
 */
export declare function writeCompletionReport(cwd: string, report: CompletionReportV1): Promise<{
    path: string;
}>;
//# sourceMappingURL=completion-report.d.ts.map