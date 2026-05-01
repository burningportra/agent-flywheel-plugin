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
import { readFile, writeFile, mkdir } from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
// ─── Constants ──────────────────────────────────────────────
export const COMPLETION_REPORT_DIR = ".pi-flywheel/completion";
// ─── Path validation primitives ────────────────────────────
/**
 * A relative path that does not escape its base. Rejects:
 *   - empty strings
 *   - absolute paths (`/foo`, drive letters via `path.isAbsolute`)
 *   - paths whose POSIX-normalised form starts with `..`
 *
 * Note: `foo/../bar` is allowed because it normalises to `bar` (still inside
 * cwd). `validateCompletionReport` does the cwd-aware path.resolve check as
 * defense in depth.
 */
const ChangedFilePathSchema = z
    .string()
    .min(1, "changed file path must be non-empty")
    .refine((p) => !path.isAbsolute(p), {
    message: "changed file path must be relative (no absolute paths)",
})
    .refine((p) => {
    const norm = path.posix.normalize(p.replace(/\\/g, "/"));
    if (norm === ".." || norm.startsWith("../"))
        return false;
    if (norm.startsWith("/"))
        return false;
    return true;
}, { message: "changed file path must not escape its base (no .. traversal)" });
// ─── Status enum ───────────────────────────────────────────
export const CompletionStatusEnum = z.enum(["closed", "blocked", "partial"]);
// ─── Sub-schemas ───────────────────────────────────────────
const UbsBlockSchema = z
    .object({
    ran: z.boolean(),
    summary: z.string(),
    findingsFixed: z.number().int().nonnegative().default(0),
    deferredBeadIds: z.array(z.string().min(1)).default([]),
    skippedReason: z.string().optional(),
})
    .superRefine((v, ctx) => {
    if (!v.ran && (!v.skippedReason || v.skippedReason.trim() === "")) {
        ctx.addIssue({
            code: "custom",
            path: ["skippedReason"],
            message: "ubs.skippedReason required when ubs.ran=false",
        });
    }
});
const VerifyEntrySchema = z.object({
    command: z.string().min(1),
    exitCode: z.number().int(),
    summary: z.string(),
});
const SelfReviewSchema = z.object({
    ran: z.boolean(),
    summary: z.string(),
});
// ─── Top-level schema ──────────────────────────────────────
/**
 * `CompletionReportSchemaV1` — additive forever; never remove keys.
 *
 * Required fields are the duel-agreed minimum. Optional fields (`paneName`,
 * `ubs.skippedReason`, `reservationsReleased`) carry context useful to
 * downstream tools but are not strictly load-bearing.
 */
export const CompletionReportSchemaV1 = z.object({
    version: z.literal(1),
    beadId: z.string().min(1),
    agentName: z.string().min(1),
    paneName: z.string().optional(),
    status: CompletionStatusEnum,
    changedFiles: z.array(ChangedFilePathSchema),
    commits: z.array(z.string().min(1)),
    ubs: UbsBlockSchema,
    verify: z.array(VerifyEntrySchema),
    selfReview: SelfReviewSchema,
    beadClosedVerified: z.boolean(),
    reservationsReleased: z.boolean().optional(),
    createdAt: z
        .string()
        .min(1)
        .refine((s) => !Number.isNaN(Date.parse(s)), {
        message: "createdAt must be ISO-8601 parseable",
    }),
});
// ─── File path helper ──────────────────────────────────────
export function completionReportPath(cwd, beadId) {
    return path.join(cwd, COMPLETION_REPORT_DIR, `${beadId}.json`);
}
/**
 * Read + parse + schema-validate `.pi-flywheel/completion/<beadId>.json`.
 *
 * Does NOT cross-check against a bead — call `validateCompletionReport` for
 * that. Use `readCompletionReport` when you only have a beadId; use
 * `validateCompletionReport` when you also have the bead record from `br`.
 */
export async function readCompletionReport(cwd, beadId) {
    const filePath = completionReportPath(cwd, beadId);
    let raw;
    try {
        raw = await readFile(filePath, "utf8");
    }
    catch (err) {
        return {
            ok: false,
            error: {
                code: "not_found",
                message: `completion report not found at ${filePath}: ${String(err)}`,
                path: filePath,
            },
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        return {
            ok: false,
            error: {
                code: "invalid_json",
                message: `invalid JSON in ${filePath}: ${String(err)}`,
                path: filePath,
            },
        };
    }
    const result = CompletionReportSchemaV1.safeParse(parsed);
    if (!result.success) {
        return {
            ok: false,
            error: {
                code: "schema_invalid",
                message: `completion report failed schema validation: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
                path: filePath,
                issues: result.error.issues,
            },
        };
    }
    return { ok: true, report: result.data, path: filePath };
}
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
export function validateCompletionReport(report, bead, opts = {}) {
    const issues = [];
    if (report.beadId !== bead.id) {
        issues.push({
            code: "bead_id_mismatch",
            message: `report.beadId=${report.beadId} does not match bead.id=${bead.id}`,
            field: "beadId",
        });
    }
    if (report.status === "closed" && !report.beadClosedVerified) {
        issues.push({
            code: "closed_without_verification",
            message: "status=closed requires beadClosedVerified=true",
            field: "beadClosedVerified",
        });
    }
    if (opts.cwd) {
        const cwdResolved = path.resolve(opts.cwd);
        const sep = path.sep;
        for (const file of report.changedFiles) {
            const resolved = path.resolve(cwdResolved, file);
            if (resolved !== cwdResolved && !resolved.startsWith(cwdResolved + sep)) {
                issues.push({
                    code: "path_escapes_cwd",
                    message: `changedFile ${JSON.stringify(file)} resolves outside cwd ${cwdResolved}`,
                    field: "changedFiles",
                });
            }
        }
    }
    return issues.length ? { ok: false, issues } : { ok: true };
}
// ─── Format for log / human output ─────────────────────────
/**
 * Render a one-line evidence summary for log lines, completion-message
 * acknowledgements, and `flywheel_observe.hints[]` rendering. Stable
 * format — downstream tools may grep this.
 */
export function formatCompletionEvidenceSummary(report) {
    const ubs = report.ubs.ran
        ? `ubs: clean (${report.ubs.findingsFixed} fixed${report.ubs.deferredBeadIds.length ? `, ${report.ubs.deferredBeadIds.length} deferred` : ""})`
        : `ubs: skipped (${report.ubs.skippedReason ?? "no reason"})`;
    const verify = report.verify.length > 0
        ? `verify: ${report.verify.map((v) => `${v.command}=${v.exitCode}`).join(", ")}`
        : "verify: none";
    const review = report.selfReview.ran ? "self-review: ran" : "self-review: skipped";
    const closed = report.beadClosedVerified ? "closed=true" : "closed=false";
    return `[${report.beadId}] ${report.status} by ${report.agentName} | ${ubs} | ${verify} | ${review} | ${closed}`;
}
// ─── Write helper (used by implementors when dogfooding) ───
/**
 * Write a completion report to disk. Creates the parent directory if needed.
 * Caller is responsible for serialising the report against the schema first;
 * pass a `CompletionReportV1` that has already been parsed/validated.
 */
export async function writeCompletionReport(cwd, report) {
    const filePath = completionReportPath(cwd, report.beadId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { path: filePath };
}
//# sourceMappingURL=completion-report.js.map