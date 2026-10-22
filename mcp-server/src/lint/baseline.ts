import { createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { Finding, Severity } from "./types.js";
import { normalizeText } from "../utils/text-normalize.js";

const BASELINE_SCHEMA_VERSION = 1;
export const RULESET_VERSION = 1;

// Convert any path (absolute, relative, mixed-separator) to a POSIX-style
// path relative to repoRoot. Baseline entries store paths in this form so a
// baseline generated in worktree A still matches findings emitted in worktree
// B or in a fresh clone. Without this, absolute paths embedded in the JSON
// would differ across machines/worktrees and the baseline would never apply.
export function toRepoRelativePosix(file: string, repoRoot: string): string {
  const abs = path.isAbsolute(file) ? file : path.resolve(repoRoot, file);
  const rel = path.relative(repoRoot, abs);
  return rel.split(path.sep).join("/");
}

export interface BaselineEntry {
  ruleId: string;
  rulesetVersion: number;
  file: string;
  line: number;
  fingerprint: string;
  reason: string;
}

export interface BaselineFile {
  schemaVersion: 1;
  rulesetVersion: number;
  generated: string;
  entries: BaselineEntry[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function readEntry(v: unknown): BaselineEntry | null {
  if (!isRecord(v)) return null;
  const { ruleId, rulesetVersion, file, line, fingerprint, reason = "" } = v;
  if (typeof ruleId !== "string" || !isCount(rulesetVersion) || typeof file !== "string") return null;
  if (!Number.isSafeInteger(line) || (line as number) <= 0) return null;
  if (typeof fingerprint !== "string" || typeof reason !== "string") return null;
  return { ruleId, rulesetVersion, file, line: line as number, fingerprint, reason };
}

// Accepts exactly what BaselineFileSchema accepts and returns the same shape,
// without zod. Anything it can't vouch for goes to zod for the real error.
function readBaselineFile(v: unknown): BaselineFile | null {
  if (!isRecord(v)) return null;
  const { schemaVersion, rulesetVersion, generated, entries } = v;
  if (schemaVersion !== 1 || !isCount(rulesetVersion) || typeof generated !== "string" || !Array.isArray(entries)) return null;
  const read: BaselineEntry[] = [];
  for (const e of entries) {
    const entry = readEntry(e);
    if (!entry) return null;
    read.push(entry);
  }
  return { schemaVersion, rulesetVersion, generated, entries: read };
}

// CRLF -> LF MUST run BEFORE fingerprint computation. Otherwise mac dev vs
// linux CI produce different fingerprints for identical content.
export function normalizeSourceForFingerprint(source: string): string {
  return source.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
}

export function computeFingerprint(source: string, line: number): string {
  const normalized = normalizeSourceForFingerprint(source);
  const lines = normalized.split("\n");
  const idx = line - 1;
  const prev = (lines[idx - 1] ?? "").trim();
  const curr = (lines[idx] ?? "").trim();
  const next = (lines[idx + 1] ?? "").trim();
  const concat = `${prev}\n${curr}\n${next}`;
  return "sha256:" + createHash("sha256").update(concat, "utf8").digest("hex");
}

export async function loadBaseline(path: string): Promise<BaselineFile | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed: unknown = JSON.parse(normalizeText(text));
  const baseline = readBaselineFile(parsed);
  if (baseline) return baseline;
  const { BaselineFileSchema } = await import("./baseline-schema.js");
  return BaselineFileSchema.parse(parsed);
}

export async function saveBaseline(path: string, baseline: BaselineFile): Promise<void> {
  // saveBaseline is only invoked via the explicit `--update-baseline` CLI
  // flag — user-initiated, never installer-implicit. Version control is
  // the backup of record for this file (see docs/audits/destructive-io-2026-04-23.md).
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

export function applyBaseline(
  findings: Finding[],
  baseline: BaselineFile | null,
  source: string,
  repoRoot?: string,
): { live: Finding[]; baselined: Finding[] } {
  if (!baseline) return { live: findings.slice(), baselined: [] };

  const fpCache = new Map<number, string>();
  const fpFor = (line: number): string => {
    let cached = fpCache.get(line);
    if (cached === undefined) {
      cached = computeFingerprint(source, line);
      fpCache.set(line, cached);
    }
    return cached;
  };

  // Normalize both sides to repo-relative POSIX paths when repoRoot is known.
  // Without repoRoot we fall back to raw equality (used by older callers/tests).
  const normalize = (file: string): string =>
    repoRoot ? toRepoRelativePosix(file, repoRoot) : file;

  const baselineMatches = (f: Finding): boolean => {
    const fNorm = normalize(f.file);
    return baseline.entries.some(
      (e) =>
        e.ruleId === f.ruleId &&
        normalize(e.file) === fNorm &&
        (e.line === f.line || e.fingerprint === fpFor(f.line)),
    );
  };

  const live: Finding[] = [];
  const baselined: Finding[] = [];
  for (const f of findings) {
    if (baselineMatches(f)) {
      baselined.push({ ...f, severity: "info" as Severity, message: `[baselined] ${f.message}` });
    } else {
      live.push(f);
    }
  }
  return { live, baselined };
}

export function generateBaseline(
  findings: Finding[],
  source: string,
  generated: string = new Date().toISOString(),
  repoRoot?: string,
): BaselineFile {
  const entries = findings.map<BaselineEntry>((f) => ({
    ruleId: f.ruleId,
    rulesetVersion: RULESET_VERSION,
    file: repoRoot ? toRepoRelativePosix(f.file, repoRoot) : f.file,
    line: f.line,
    fingerprint: computeFingerprint(source, f.line),
    reason: "",
  }));
  return {
    schemaVersion: 1,
    rulesetVersion: RULESET_VERSION,
    generated,
    entries,
  };
}
