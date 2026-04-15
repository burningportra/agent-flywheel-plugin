import { createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { z } from "zod";
import type { Finding, Severity } from "./types.js";

export const BASELINE_SCHEMA_VERSION = 1;
export const RULESET_VERSION = 1;

const BaselineEntrySchema = z.object({
  ruleId: z.string(),
  rulesetVersion: z.number().int().nonnegative(),
  file: z.string(),
  line: z.number().int().positive(),
  fingerprint: z.string(),
  reason: z.string().default(""),
});

const BaselineFileSchema = z.object({
  schemaVersion: z.literal(1),
  rulesetVersion: z.number().int().nonnegative(),
  generated: z.string(),
  entries: z.array(BaselineEntrySchema),
});

export type BaselineEntry = z.infer<typeof BaselineEntrySchema>;
export type BaselineFile = z.infer<typeof BaselineFileSchema>;

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
  const parsed = JSON.parse(text);
  return BaselineFileSchema.parse(parsed);
}

export async function saveBaseline(path: string, baseline: BaselineFile): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

export function applyBaseline(
  findings: Finding[],
  baseline: BaselineFile | null,
  source: string,
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

  const baselineMatches = (f: Finding): boolean =>
    baseline.entries.some(
      (e) =>
        e.ruleId === f.ruleId &&
        e.file === f.file &&
        (e.line === f.line || e.fingerprint === fpFor(f.line)),
    );

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
): BaselineFile {
  const entries = findings.map<BaselineEntry>((f) => ({
    ruleId: f.ruleId,
    rulesetVersion: RULESET_VERSION,
    file: f.file,
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
