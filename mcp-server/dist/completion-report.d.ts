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
import type { FlywheelErrorCode } from "./errors.js";
import type { ExecFn } from "./exec.js";
export declare const COMPLETION_REPORT_DIR = ".pi-flywheel/completion";
export declare const VERIFICATION_LEDGER_PATH = ".pi-flywheel/ledger.tsv";
export declare const CompletionStatusEnum: z.ZodEnum<{
    blocked: "blocked";
    closed: "closed";
    partial: "partial";
}>;
export type CompletionStatus = z.infer<typeof CompletionStatusEnum>;
/**
 * The verification state machine: a bead starts at `needs-verification` and a
 * verifier moves it to `verified` or `verification-failed`. The verdict is
 * coupled to `baseSha..headSha` through `patchId`, so a rebase that keeps the
 * same diff keeps the verdict and any content change invalidates it.
 */
export declare const VerificationVerdictEnum: z.ZodEnum<{
    "needs-verification": "needs-verification";
    verified: "verified";
    "verification-failed": "verification-failed";
}>;
export type VerificationVerdict = z.infer<typeof VerificationVerdictEnum>;
export declare const VerificationBlockSchema: z.ZodObject<{
    verdict: z.ZodEnum<{
        "needs-verification": "needs-verification";
        verified: "verified";
        "verification-failed": "verification-failed";
    }>;
    baseSha: z.ZodString;
    headSha: z.ZodString;
    patchId: z.ZodOptional<z.ZodString>;
    verifier: z.ZodOptional<z.ZodString>;
    verifiedAt: z.ZodOptional<z.ZodString>;
    evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type VerificationBlock = z.infer<typeof VerificationBlockSchema>;
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
        blocked: "blocked";
        closed: "closed";
        partial: "partial";
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
    verification: z.ZodOptional<z.ZodObject<{
        verdict: z.ZodEnum<{
            "needs-verification": "needs-verification";
            verified: "verified";
            "verification-failed": "verification-failed";
        }>;
        baseSha: z.ZodString;
        headSha: z.ZodString;
        patchId: z.ZodOptional<z.ZodString>;
        verifier: z.ZodOptional<z.ZodString>;
        verifiedAt: z.ZodOptional<z.ZodString>;
        evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
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
/**
 * `git diff <baseSha>..<headSha> | git patch-id --stable`, or null when the
 * range has no diff. Two ranges with the same patch id carry the same change,
 * so a verdict recorded before a rebase still holds after it.
 *
 * The diff pins prefixes and turns off external diff drivers and textconv so
 * the user's git config can't change the id. Throws when either SHA is not a
 * hex object id or git fails.
 */
export declare function computePatchId(exec: ExecFn, cwd: string, baseSha: string, headSha: string, opts?: {
    timeout?: number;
    signal?: AbortSignal;
}): Promise<string | null>;
export type VerificationAssessment = {
    ok: true;
    rebased: boolean;
} | {
    ok: false;
    code: Extract<FlywheelErrorCode, "verification_missing" | "verification_failed" | "verification_sha_drift">;
    message: string;
};
/**
 * Decide whether a recorded verification still covers the current range.
 * `current.patchId` comes from `computePatchId` on the range as it is now; a
 * matching id with a different head means the branch was rebased without
 * changing its content.
 */
export declare function assessVerification(verification: VerificationBlock | undefined, current: {
    headSha: string;
    patchId: string | null;
}): VerificationAssessment;
export type VerificationLedgerEntry = {
    beadId: string;
    verification: VerificationBlock;
    /** Defaults to `verification.verifiedAt`, then the current time. */
    recordedAt?: string;
};
/**
 * Append one verification transition to `.pi-flywheel/ledger.tsv` (or
 * `ledgerPath`, relative to `cwd`).
 *
 * Concurrent writers and crashes are both safe. The header is written to a
 * temp file and `link`ed into place, so the ledger never exists without its
 * header. Each row goes out as one `write` on an O_APPEND handle followed by
 * `fsync`, so rows from different agents never interleave, and a row torn by
 * a crash is closed off with a newline before the next one lands.
 */
export declare function appendVerificationLedger(cwd: string, entry: VerificationLedgerEntry, opts?: {
    ledgerPath?: string;
}): Promise<{
    path: string;
}>;
//# sourceMappingURL=completion-report.d.ts.map