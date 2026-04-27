import { createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { normalizeText } from "../utils/text-normalize.js";
export const BASELINE_SCHEMA_VERSION = 1;
export const RULESET_VERSION = 1;
// Convert any path (absolute, relative, mixed-separator) to a POSIX-style
// path relative to repoRoot. Baseline entries store paths in this form so a
// baseline generated in worktree A still matches findings emitted in worktree
// B or in a fresh clone. Without this, absolute paths embedded in the JSON
// would differ across machines/worktrees and the baseline would never apply.
export function toRepoRelativePosix(file, repoRoot) {
    const abs = path.isAbsolute(file) ? file : path.resolve(repoRoot, file);
    const rel = path.relative(repoRoot, abs);
    return rel.split(path.sep).join("/");
}
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
// CRLF -> LF MUST run BEFORE fingerprint computation. Otherwise mac dev vs
// linux CI produce different fingerprints for identical content.
export function normalizeSourceForFingerprint(source) {
    return source.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
}
export function computeFingerprint(source, line) {
    const normalized = normalizeSourceForFingerprint(source);
    const lines = normalized.split("\n");
    const idx = line - 1;
    const prev = (lines[idx - 1] ?? "").trim();
    const curr = (lines[idx] ?? "").trim();
    const next = (lines[idx + 1] ?? "").trim();
    const concat = `${prev}\n${curr}\n${next}`;
    return "sha256:" + createHash("sha256").update(concat, "utf8").digest("hex");
}
export async function loadBaseline(path) {
    let text;
    try {
        text = await readFile(path, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return null;
        throw err;
    }
    const parsed = JSON.parse(normalizeText(text));
    return BaselineFileSchema.parse(parsed);
}
export async function saveBaseline(path, baseline) {
    // saveBaseline is only invoked via the explicit `--update-baseline` CLI
    // flag — user-initiated, never installer-implicit. Version control is
    // the backup of record for this file (see docs/audits/destructive-io-2026-04-23.md).
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(baseline, null, 2) + "\n", "utf8");
    await rename(tmp, path);
}
export function applyBaseline(findings, baseline, source, repoRoot) {
    if (!baseline)
        return { live: findings.slice(), baselined: [] };
    const fpCache = new Map();
    const fpFor = (line) => {
        let cached = fpCache.get(line);
        if (cached === undefined) {
            cached = computeFingerprint(source, line);
            fpCache.set(line, cached);
        }
        return cached;
    };
    // Normalize both sides to repo-relative POSIX paths when repoRoot is known.
    // Without repoRoot we fall back to raw equality (used by older callers/tests).
    const normalize = (file) => repoRoot ? toRepoRelativePosix(file, repoRoot) : file;
    const baselineMatches = (f) => {
        const fNorm = normalize(f.file);
        return baseline.entries.some((e) => e.ruleId === f.ruleId &&
            normalize(e.file) === fNorm &&
            (e.line === f.line || e.fingerprint === fpFor(f.line)));
    };
    const live = [];
    const baselined = [];
    for (const f of findings) {
        if (baselineMatches(f)) {
            baselined.push({ ...f, severity: "info", message: `[baselined] ${f.message}` });
        }
        else {
            live.push(f);
        }
    }
    return { live, baselined };
}
export function generateBaseline(findings, source, generated = new Date().toISOString(), repoRoot) {
    const entries = findings.map((f) => ({
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
//# sourceMappingURL=baseline.js.map