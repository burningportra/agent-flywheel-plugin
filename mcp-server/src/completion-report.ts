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

import { randomUUID } from "node:crypto";
import { access, readFile, writeFile, mkdir, open, link, unlink } from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

import type { FlywheelErrorCode } from "./errors.js";
import type { ExecFn } from "./exec.js";

// ─── Constants ──────────────────────────────────────────────

export const COMPLETION_REPORT_DIR = ".pi-flywheel/completion";
export const VERIFICATION_LEDGER_PATH = ".pi-flywheel/ledger.tsv";

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
  .refine(
    (p) => {
      const norm = path.posix.normalize(p.replace(/\\/g, "/"));
      if (norm === ".." || norm.startsWith("../")) return false;
      if (norm.startsWith("/")) return false;
      return true;
    },
    { message: "changed file path must not escape its base (no .. traversal)" },
  );

// ─── Status enum ───────────────────────────────────────────

export const CompletionStatusEnum = z.enum(["closed", "blocked", "partial"]);
export type CompletionStatus = z.infer<typeof CompletionStatusEnum>;

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

const IsoTimestampSchema = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "timestamp must be ISO-8601 parseable",
  });

const GitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,64}$/i, "must be a hex git object id");

const PatchIdSchema = z
  .string()
  .regex(/^[0-9a-f]{40,64}$/i, "must be a `git patch-id --stable` id");

/**
 * The verification state machine: a bead starts at `needs-verification` and a
 * verifier moves it to `verified` or `verification-failed`. The verdict is
 * coupled to `baseSha..headSha` through `patchId`, so a rebase that keeps the
 * same diff keeps the verdict and any content change invalidates it.
 */
export const VerificationVerdictEnum = z.enum([
  "needs-verification",
  "verified",
  "verification-failed",
]);
export type VerificationVerdict = z.infer<typeof VerificationVerdictEnum>;

export const VerificationBlockSchema = z
  .object({
    verdict: VerificationVerdictEnum,
    baseSha: GitShaSchema,
    headSha: GitShaSchema,
    patchId: PatchIdSchema.optional(),
    verifier: z.string().min(1).optional(),
    verifiedAt: IsoTimestampSchema.optional(),
    evidence: z.array(z.string().min(1)).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.verdict === "needs-verification") return;
    for (const field of ["verifier", "verifiedAt"] as const) {
      if (v[field] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `verification.${field} required when verdict=${v.verdict}`,
        });
      }
    }
    if (v.verdict === "verified" && v.patchId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["patchId"],
        message: "verification.patchId required when verdict=verified",
      });
    }
  });
export type VerificationBlock = z.infer<typeof VerificationBlockSchema>;

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
  verification: VerificationBlockSchema.optional(),
  createdAt: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), {
      message: "createdAt must be ISO-8601 parseable",
    }),
});

export type CompletionReportV1 = z.infer<typeof CompletionReportSchemaV1>;

// ─── File path helper ──────────────────────────────────────

export function completionReportPath(cwd: string, beadId: string): string {
  return path.join(cwd, COMPLETION_REPORT_DIR, `${beadId}.json`);
}

// ─── Read / parse ──────────────────────────────────────────

export type CompletionReportReadError =
  | { code: "not_found"; message: string; path: string }
  | { code: "invalid_json"; message: string; path: string }
  | { code: "schema_invalid"; message: string; path: string; issues: z.core.$ZodIssue[] };

export type CompletionReportReadResult =
  | { ok: true; report: CompletionReportV1; path: string }
  | { ok: false; error: CompletionReportReadError };

/**
 * Read + parse + schema-validate `.pi-flywheel/completion/<beadId>.json`.
 *
 * Does NOT cross-check against a bead — call `validateCompletionReport` for
 * that. Use `readCompletionReport` when you only have a beadId; use
 * `validateCompletionReport` when you also have the bead record from `br`.
 */
export async function readCompletionReport(
  cwd: string,
  beadId: string,
): Promise<CompletionReportReadResult> {
  const filePath = completionReportPath(cwd, beadId);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        code: "not_found",
        message: `completion report not found at ${filePath}: ${String(err)}`,
        path: filePath,
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
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

// ─── Validate against a bead ───────────────────────────────

export type ValidationIssue = {
  code:
    | "bead_id_mismatch"
    | "closed_without_verification"
    | "path_escapes_cwd"
    | "status_mismatch";
  message: string;
  field?: string;
};

export type BeadShape = {
  id: string;
  /** Status string from `br show --json`. Optional; only used when present. */
  status?: string;
};

export type CompletionReportValidation =
  | { ok: true }
  | { ok: false; issues: ValidationIssue[] };

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
export function validateCompletionReport(
  report: CompletionReportV1,
  bead: BeadShape,
  opts: { cwd?: string } = {},
): CompletionReportValidation {
  const issues: ValidationIssue[] = [];
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
export function formatCompletionEvidenceSummary(
  report: CompletionReportV1,
): string {
  const ubs = report.ubs.ran
    ? `ubs: clean (${report.ubs.findingsFixed} fixed${report.ubs.deferredBeadIds.length ? `, ${report.ubs.deferredBeadIds.length} deferred` : ""})`
    : `ubs: skipped (${report.ubs.skippedReason ?? "no reason"})`;
  const verify =
    report.verify.length > 0
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
export async function writeCompletionReport(
  cwd: string,
  report: CompletionReportV1,
): Promise<{ path: string }> {
  const filePath = completionReportPath(cwd, report.beadId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { path: filePath };
}

// ─── Patch-id equivalence ──────────────────────────────────

/**
 * `git diff <baseSha>..<headSha> | git patch-id --stable`, or null when the
 * range has no diff. Two ranges with the same patch id carry the same change,
 * so a verdict recorded before a rebase still holds after it.
 *
 * The diff pins prefixes and turns off external diff drivers and textconv so
 * the user's git config can't change the id. Throws when either SHA is not a
 * hex object id or git fails.
 */
export async function computePatchId(
  exec: ExecFn,
  cwd: string,
  baseSha: string,
  headSha: string,
  opts: { timeout?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
  for (const sha of [baseSha, headSha]) {
    if (!GitShaSchema.safeParse(sha).success) {
      throw new Error(`computePatchId: ${JSON.stringify(sha)} is not a hex git object id`);
    }
  }
  // No `set -o pipefail`: older dash rejects it. Capturing the diff first
  // still surfaces git diff's exit code.
  const script =
    'd=$(git -c diff.noprefix=false -c diff.mnemonicPrefix=false ' +
    'diff --no-ext-diff --no-textconv --no-color "$1..$2") || exit $?; ' +
    '[ -z "$d" ] || printf \'%s\\n\' "$d" | git patch-id --stable';
  const result = await exec("sh", ["-c", script, "sh", baseSha, headSha], {
    cwd,
    timeout: opts.timeout ?? 30_000,
    signal: opts.signal,
  });
  if (result.code !== 0) {
    throw new Error(
      `computePatchId: git diff ${baseSha}..${headSha} | git patch-id failed (exit ${result.code}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim().split(/\s+/)[0] || null;
}

export type VerificationAssessment =
  | { ok: true; rebased: boolean }
  | {
      ok: false;
      code: Extract<
        FlywheelErrorCode,
        "verification_missing" | "verification_failed" | "verification_sha_drift"
      >;
      message: string;
    };

/**
 * Decide whether a recorded verification still covers the current range.
 * `current.patchId` comes from `computePatchId` on the range as it is now; a
 * matching id with a different head means the branch was rebased without
 * changing its content.
 */
export function assessVerification(
  verification: VerificationBlock | undefined,
  current: { headSha: string; patchId: string | null },
): VerificationAssessment {
  if (!verification || verification.verdict === "needs-verification") {
    return {
      ok: false,
      code: "verification_missing",
      message: "no verifier has recorded a verdict for this bead",
    };
  }
  if (verification.verdict === "verification-failed") {
    return {
      ok: false,
      code: "verification_failed",
      message: `verifier ${verification.verifier ?? "unknown"} recorded verification-failed`,
    };
  }
  if (current.patchId === null || verification.patchId?.toLowerCase() !== current.patchId.toLowerCase()) {
    return {
      ok: false,
      code: "verification_sha_drift",
      message: `verified patch-id ${verification.patchId} at ${verification.headSha} does not match ${current.patchId ?? "an empty diff"} at ${current.headSha}`,
    };
  }
  return { ok: true, rebased: verification.headSha !== current.headSha };
}

// ─── Verification ledger ───────────────────────────────────

const LEDGER_COLUMNS = [
  "recorded_at",
  "bead_id",
  "verdict",
  "base_sha",
  "head_sha",
  "patch_id",
  "verifier",
  "evidence",
] as const;

export type VerificationLedgerEntry = {
  beadId: string;
  verification: VerificationBlock;
  /** Defaults to `verification.verifiedAt`, then the current time. */
  recordedAt?: string;
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function tsvField(value: string | undefined): string {
  return (value ?? "").replace(/[\t\r\n]+/g, " ");
}

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
export async function appendVerificationLedger(
  cwd: string,
  entry: VerificationLedgerEntry,
  opts: { ledgerPath?: string } = {},
): Promise<{ path: string }> {
  const filePath = path.resolve(cwd, opts.ledgerPath ?? VERIFICATION_LEDGER_PATH);
  await mkdir(path.dirname(filePath), { recursive: true });

  if (!(await pathExists(filePath))) {
    const tmp = `${filePath}.${randomUUID()}.tmp`;
    const header = await open(tmp, "wx");
    try {
      await header.write(`${LEDGER_COLUMNS.join("\t")}\n`);
      await header.sync();
    } finally {
      await header.close();
    }
    try {
      await link(tmp, filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      await unlink(tmp);
    }
  }

  const v = entry.verification;
  const fields = [
    entry.recordedAt ?? v.verifiedAt ?? new Date().toISOString(),
    entry.beadId,
    v.verdict,
    v.baseSha,
    v.headSha,
    v.patchId,
    v.verifier,
    v.evidence.join(" | "),
  ];
  const row = `${fields.map(tsvField).join("\t")}\n`;

  const handle = await open(filePath, "a+");
  try {
    const { size } = await handle.stat();
    let line = row;
    if (size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) line = `\n${row}`;
    }
    const buf = Buffer.from(line, "utf8");
    const { bytesWritten } = await handle.write(buf);
    if (bytesWritten !== buf.length) {
      throw new Error(
        `appendVerificationLedger: short write to ${filePath} (${bytesWritten}/${buf.length} bytes)`,
      );
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { path: filePath };
}
