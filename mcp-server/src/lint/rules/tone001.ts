import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { Finding, ParsedDocument, Rule, RuleContext } from "../types.js";

/**
 * TONE001 — per-file count of all-caps directive tokens and quota phrases in
 * flywheel skill prose. The rule is a ratchet: a count equal to or lower than
 * the committed baseline passes; a count that rises above the baseline fails.
 * The point is to shrink the shouty surface over time without rewriting every
 * file in one sweep. See docs/skill-style.md for the written rationale.
 *
 * Scope:
 * - Prose only. Everything inside fenced code blocks is ignored, and so is any
 *   section whose header is "Universal Rule 1" (lint and tests depend on the
 *   verbatim phrasing of that rule).
 * - The baseline file (default `mcp-server/.lintskill-tone-baseline.json`) is
 *   keyed by repo-relative POSIX path. A missing entry means baseline=0 — new
 *   skill files start with no shouting budget.
 */

export interface Tone001Context extends RuleContext {
  repoRoot?: string;
  /** Override the baseline path (tests inject a fixture). */
  toneBaselinePath?: string;
  /** Override the loaded baseline directly (tests inject a map). */
  toneBaseline?: Record<string, number>;
}

export interface ToneBaselineFile {
  schemaVersion: 1;
  generated: string;
  /** Per-file maximum count; keyed by repo-relative POSIX path. */
  counts: Record<string, number>;
}

/**
 * Discouraged directive words. Match on word boundaries, case-sensitive —
 * calm sentences that happen to contain "must" (lowercase) are fine; the rule
 * targets the shouty register.
 */
const CAPS_WORDS = [
  "MUST",
  "NEVER",
  "MANDATORY",
  "STOP",
  "CRITICAL",
  "IMPORTANT",
];

const CAPS_WORD_RE = new RegExp(`\\b(?:${CAPS_WORDS.join("|")})\\b`, "g");

/**
 * Mixed-case directive phrases. "Do NOT" and "Hard rule" are two patterns the
 * surveyors flagged as common pile-ons; both read as shouting even though they
 * aren't purely uppercase.
 */
const DO_NOT_RE = /\bDo NOT\b/g;
const HARD_RULE_RE = /\bHard rule\b/g;

/**
 * Quota phrases. "AT LEAST" and "80+" are the two shapes the bead calls out;
 * the quota pattern also catches "at least 10x" family that the surveyors saw
 * drifting past the first-pass fixes.
 */
const AT_LEAST_RE = /\bAT LEAST\b/g;
const NUMERIC_QUOTA_RE = /\b\d{2,}\+/g; // "80+", "100+", etc. (trailing + is non-word)

const RULE_ID = "TONE001";

export function countToneTokens(prose: string): number {
  let n = 0;
  for (const re of [CAPS_WORD_RE, DO_NOT_RE, HARD_RULE_RE, AT_LEAST_RE, NUMERIC_QUOTA_RE]) {
    re.lastIndex = 0;
    const matches = prose.match(re);
    if (matches) n += matches.length;
  }
  return n;
}

/**
 * Remove ranges from `source` by replacing them with equal-length runs of
 * spaces so line/column information in the remaining text is preserved.
 */
function blankRanges(source: string, ranges: Array<{ start: number; end: number }>): string {
  if (ranges.length === 0) return source;
  const chars = source.split("");
  for (const r of ranges) {
    for (let i = r.start; i < r.end && i < chars.length; i++) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  }
  return chars.join("");
}

/**
 * Find "Universal Rule 1" (or similar) sections. We treat any heading whose
 * text matches `/^universal rule(?:\s+\d+)?\b/i` as a protected block and
 * strip the lines from the heading up to (but not including) the next heading
 * at the same or shallower level. This mirrors the carve-out tests and lint
 * rules already apply to that section.
 */
function universalRuleRanges(doc: ParsedDocument): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const headers = doc.headers;
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    if (!/^universal rule(?:\s+\d+)?\b/i.test(h.text)) continue;
    const startOffset = h.span.start.offset ?? 0;
    let endOffset = doc.source.length;
    for (let j = i + 1; j < headers.length; j++) {
      const next = headers[j]!;
      if (next.level <= h.level) {
        endOffset = next.span.start.offset ?? endOffset;
        break;
      }
    }
    ranges.push({ start: startOffset, end: endOffset });
  }
  return ranges;
}

function proseFrom(doc: ParsedDocument): string {
  const codeRanges = doc.fences
    .map((f) => ({
      start: f.span.start.offset ?? 0,
      end: f.span.end.offset ?? (f.span.start.offset ?? 0),
    }))
    .filter((r) => r.end > r.start);
  const urRanges = universalRuleRanges(doc);
  return blankRanges(doc.source, [...codeRanges, ...urRanges]);
}

async function loadBaseline(ctx: Tone001Context): Promise<Record<string, number>> {
  if (ctx.toneBaseline) return ctx.toneBaseline;
  const basePath =
    ctx.toneBaselinePath ??
    (ctx.repoRoot
      ? path.join(ctx.repoRoot, "mcp-server", ".lintskill-tone-baseline.json")
      : null);
  if (!basePath) return {};
  try {
    const text = await readFile(basePath, "utf8");
    const parsed = JSON.parse(text) as ToneBaselineFile;
    return parsed.counts ?? {};
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

function toRepoRelPosix(file: string, repoRoot?: string): string {
  if (!repoRoot) return file;
  const abs = path.isAbsolute(file) ? file : path.resolve(repoRoot, file);
  const rel = path.relative(repoRoot, abs);
  return rel.split(path.sep).join("/");
}

export const tone001: Rule = {
  id: RULE_ID,
  description:
    "Per-file ratchet count of all-caps directives and quota phrases in skill prose (see docs/skill-style.md)",
  severity: "error",
  async check(doc, ctx) {
    const parsed = doc as ParsedDocument;
    const toneCtx = ctx as Tone001Context;
    const prose = proseFrom(parsed);
    const count = countToneTokens(prose);

    const baselineMap = await loadBaseline(toneCtx);
    const rel = toRepoRelPosix(parsed.filePath, toneCtx.repoRoot);
    const ceiling = baselineMap[rel] ?? 0;

    if (count <= ceiling) return [];

    const finding: Finding = {
      ruleId: RULE_ID,
      severity: "error",
      file: parsed.filePath,
      line: 1,
      column: 1,
      message: `tone budget: ${count} discouraged tokens (ceiling ${ceiling}). The baseline is a ratchet; a rise above it means the pass added shouting rather than removing it. See docs/skill-style.md.`,
    };
    return [finding];
  },
};
