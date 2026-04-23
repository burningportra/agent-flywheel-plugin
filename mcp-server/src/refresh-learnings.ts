/**
 * Compound-Engineering refresh sweep — bead `bve`.
 *
 * Purpose (Proposal 2):
 *   The `docs/solutions/` learning store accumulates monotonically. Without
 *   periodic pruning it contradicts itself — lessons for a component that
 *   has since been rewritten sit alongside the post-rewrite lesson, and
 *   nothing flags the drift. This module implements the 5-vector overlap
 *   scorer + Keep/Update/Consolidate/Replace/Delete classifier borrowed
 *   from CE's `ce-compound-refresh` Phase 1.75 "Document-Set Analysis".
 *
 * Shape of the pipeline (pure — I/O is injected so tests can stub it):
 *
 *     listSolutionDocPaths(root, fs) ─┐
 *                                     ├─> readSolutionDocs(fs, parse)
 *     parseSolutionDoc(markdown)   ───┘                │
 *                                                      ▼
 *                                    groupSolutionDocs(by problem_type × component)
 *                                                      │
 *                                                      ▼
 *                                    scoreOverlap(a, b)  — 5-vector cosine-ish
 *                                                      │
 *                                                      ▼
 *                                    classifyGroup(docs, opts) → Keep | Update |
 *                                                                Consolidate |
 *                                                                Replace | Delete
 *
 * Invariants:
 *   R-1: Delete is NEVER emitted without stale-evidence AND crossing an
 *        *explicit* `deleteThreshold`. Callers must additionally gate Delete
 *        behind AskUserQuestion before acting on it.
 *   R-2: The scorer is symmetric — score(a,b) === score(b,a) — up to
 *        floating-point rounding. Tested directly.
 *   R-3: All classifications are additive: the pipeline NEVER mutates the
 *        input SolutionDoc array. Archival is the skill's job, not ours.
 *   R-4: Stale-file detection (a solution doc's `component` has no matching
 *        files in the working tree) is a STRONG signal for Delete, but we
 *        still require rename detection via `git log --follow` before
 *        returning Delete (caller supplies a `staleProbe` for this).
 *
 * Non-goals:
 *   - We do NOT touch CASS here. CASS reconciliation happens via
 *     `entry_id` at a later stage (out of scope for this bead).
 *   - We do NOT write or delete files. Classification is advisory; the
 *     skill owns all filesystem mutations (archival, edits).
 */

import {
  SolutionDocFrontmatterSchema,
  type SolutionDoc,
  type SolutionDocFrontmatter,
} from './solution-doc-schema.js';
import { normalizeText } from './utils/text-normalize.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * The five overlap dimensions CE's Phase 1.75 rubric scores. Each score is
 * in [0, 1]; the final overall score is the mean of the five.
 *
 *   - problem:    similarity of `problem_type` (+ small title influence)
 *   - rootCause:  body sections that discuss root-cause / "why" passages
 *   - solution:   body sections that discuss the fix itself
 *   - files:      overlap of file paths referenced in the body
 *   - prevention: `applies_when` + prevention/guardrail language overlap
 *
 * We surface the per-dimension scores so the skill can show the user *why*
 * two docs were deemed duplicates, not just "they're 0.83 similar".
 */
export interface OverlapScore {
  problem: number;
  rootCause: number;
  solution: number;
  files: number;
  prevention: number;
  overall: number;
}

/** The five classifications CE's refresh rubric produces. */
export type RefreshClassification =
  | 'Keep'
  | 'Update'
  | 'Consolidate'
  | 'Replace'
  | 'Delete';

/**
 * One classification decision attached to a group of related docs.
 *
 * `docs` always has ≥1 member; for Keep on a singleton, it has exactly 1.
 * For Consolidate/Replace it has ≥2, with `primary` indexing the doc the
 * sweep recommends keeping (newest or highest-quality — heuristic).
 */
export interface RefreshDecision {
  classification: RefreshClassification;
  /** Docs implicated in this decision. Never mutated. */
  docs: SolutionDoc[];
  /** Index into `docs` of the preferred/primary entry. */
  primary: number;
  /** Score matrix: scores[i][j] = scoreOverlap(docs[i], docs[j]). */
  scores: OverlapScore[][];
  /** Short reason surfaced to the user and archived in the decision log. */
  reason: string;
  /**
   * Relative paths recommended for archival (moved to docs/solutions/_archive/).
   * Empty for Keep/Update. Always a subset of docs[].path.
   */
  archiveCandidates: string[];
}

export interface RefreshReport {
  /** One decision per group. */
  decisions: RefreshDecision[];
  /** Docs that could not be parsed — surfaced to the user, never auto-acted on. */
  unparseable: Array<{ path: string; reason: string }>;
  /** Seconds of wall clock the sweep spent. Diagnostic only. */
  elapsedMs: number;
}

export interface RefreshOptions {
  /**
   * Pairwise overall score ≥ this triggers Consolidate/Replace. 0 = everything
   * collapses; 1 = nothing ever does. CE's rubric uses 0.75; we match.
   */
  consolidateThreshold?: number;
  /**
   * Overall ≥ this AND the newer doc's files no longer exist → Replace.
   * Default 0.85 (strictly stronger than Consolidate).
   */
  replaceThreshold?: number;
  /**
   * Single-doc stale evidence strength ≥ this → Delete candidate. Only
   * honoured when `staleProbe` is supplied. Default 0.9.
   */
  deleteThreshold?: number;
  /**
   * Optional probe that, given a SolutionDoc, returns stale evidence in
   * [0, 1]: 0 = component files exist and reference the doc's topic;
   * 1 = component paths are gone AND git log --follow shows no rename.
   *
   * Keeping this injected means the refresh algorithm stays pure and the
   * skill can wire in ripgrep + `git log --follow` without this module
   * having to shell out.
   */
  staleProbe?: (doc: SolutionDoc) => Promise<number>;
}

/**
 * Filesystem adapter — injected so tests can run without a real FS.
 *
 * Only the two operations we actually need; do not grow this interface
 * without checking whether a test stub has to grow in lock-step.
 */
export interface RefreshFs {
  /** Recursively list *.md under `root`. Paths returned are relative to `root`. */
  listMarkdown(root: string): Promise<string[]>;
  /** Read a file's raw text. */
  readFile(absPath: string): Promise<string>;
}

// ─── Frontmatter parser ────────────────────────────────────────

/**
 * Parse the exact YAML shape produced by `renderSolutionDoc` — a fenced
 * `---\n...\n---\n` block where every scalar is JSON-quoted and the only
 * array is `tags: ["a", "b"]`. We don't pull in a full YAML library
 * because (a) the input is machine-generated and (b) sibling beads are
 * modifying package.json, which we're told not to touch.
 *
 * Returns `null` on malformed input; caller surfaces that to the user.
 */
export function parseSolutionDocMarkdown(
  raw: string,
): { frontmatter: SolutionDocFrontmatter; body: string } | null {
  if (!raw.startsWith('---')) return null;
  // Split on first fenced block. Accept LF and CRLF.
  const normalized = raw.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) return null;
  const [, fmRaw, body] = match;

  const obj: Record<string, unknown> = {};
  for (const line of fmRaw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 0) return null;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      // tags array — JSON parse the bracket form. If tags is empty list,
      // JSON.parse("[]") is [], which is what we want.
      try {
        obj[key] = JSON.parse(value);
      } catch {
        return null;
      }
    } else if (value.startsWith('"') && value.endsWith('"')) {
      try {
        obj[key] = JSON.parse(value);
      } catch {
        return null;
      }
    } else {
      // unquoted scalar (created_at — YYYY-MM-DD)
      obj[key] = value;
    }
  }
  const parsed = SolutionDocFrontmatterSchema.safeParse(obj);
  if (!parsed.success) return null;
  return { frontmatter: parsed.data, body: body ?? '' };
}

// ─── 5-vector scorer ───────────────────────────────────────────

/**
 * Token-bag Jaccard — our chosen similarity for string-bag fields. Not as
 * sharp as TF-IDF, but we have ~dozens of docs, not millions; Jaccard is
 * easier to reason about and the algorithm is entirely deterministic.
 *
 * Stopwords are hand-picked for the post-mortem domain (agent-flywheel
 * loves the words "session", "bead", "agent" — they carry no signal).
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'and', 'or', 'for', 'on', 'with',
  'is', 'was', 'are', 'be', 'that', 'this', 'it', 'as', 'by', 'at',
  'from', 'we', 'our', 'us', 'you', 'they', 'session', 'bead', 'agent',
  'flywheel', 'cass', 'step', 'note', 'notes', 'see', 'via',
]);

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9_\-/.]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/**
 * Extract a loose section of the body matching a keyword set. We do not
 * require markdown heading structure — post-mortems from varied authors
 * don't conform — so we fall back to "sentences containing any of these
 * cue words". Returns tokens for Jaccard.
 */
function extractSectionTokens(body: string, cues: readonly string[]): Set<string> {
  const lower = body.toLowerCase();
  const sentences = lower.split(/(?<=[.!?\n])\s+/);
  const hits: string[] = [];
  for (const s of sentences) {
    if (cues.some((cue) => s.includes(cue))) hits.push(s);
  }
  if (hits.length === 0) {
    // Fallback: whole body — better than nothing, lower precision.
    return tokenize(body);
  }
  return tokenize(hits.join(' '));
}

/** Extract file-ish path tokens from a body. */
function extractFileRefs(body: string): Set<string> {
  // Match paths that look like src/foo/bar.ts, docs/x.md, .pi-flywheel/*, etc.
  const matches = body.match(/[\w.\-/]+\.(?:ts|tsx|js|jsx|md|json|yml|yaml|py|rs|go|sh|toml)/gi) ?? [];
  return new Set(matches.map((m) => m.toLowerCase()));
}

/** Normalized-edit-distance-ish similarity for short strings (problem_type). */
function stringSim(a: string, b: string): number {
  if (a === b) return 1;
  const aT = tokenize(a);
  const bT = tokenize(b);
  return jaccard(aT, bT);
}

/**
 * Score the 5-vector overlap between two SolutionDocs.
 *
 * Symmetric (R-2). Returns `overall = mean(problem, rootCause, solution,
 * files, prevention)` — CE's Phase 1.75 uses a straight mean; we preserve
 * that so the numbers are directly comparable to their rubric.
 */
export function scoreOverlap(a: SolutionDoc, b: SolutionDoc): OverlapScore {
  const problem = stringSim(a.frontmatter.problem_type, b.frontmatter.problem_type);

  const rootCauseCues = ['because', 'root cause', 'why', 'caused', 'due to', 'reason'];
  const solutionCues = ['fix', 'solution', 'we ship', 'what shipped', 'resolved', 'by switching', 'instead'];
  const preventionCues = ['prevent', 'guard', 'going forward', 'in future', 'so that', 'avoid', 'applies when'];

  const rootCause = jaccard(
    extractSectionTokens(a.body, rootCauseCues),
    extractSectionTokens(b.body, rootCauseCues),
  );
  const solution = jaccard(
    extractSectionTokens(a.body, solutionCues),
    extractSectionTokens(b.body, solutionCues),
  );
  const files = jaccard(extractFileRefs(a.body), extractFileRefs(b.body));

  // Prevention blends applies_when frontmatter + cued body text.
  const aPrev = new Set([
    ...tokenize(a.frontmatter.applies_when),
    ...extractSectionTokens(a.body, preventionCues),
  ]);
  const bPrev = new Set([
    ...tokenize(b.frontmatter.applies_when),
    ...extractSectionTokens(b.body, preventionCues),
  ]);
  const prevention = jaccard(aPrev, bPrev);

  const overall = (problem + rootCause + solution + files + prevention) / 5;
  return { problem, rootCause, solution, files, prevention, overall };
}

// ─── Grouping ──────────────────────────────────────────────────

/** Group SolutionDocs by (problem_type, component). Pure; stable iteration. */
export function groupSolutionDocs(docs: SolutionDoc[]): SolutionDoc[][] {
  const buckets = new Map<string, SolutionDoc[]>();
  for (const d of docs) {
    const key = `${d.frontmatter.problem_type}\u0000${d.frontmatter.component}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(d);
    else buckets.set(key, [d]);
  }
  return [...buckets.values()];
}

// ─── Classification ────────────────────────────────────────────

function pickPrimary(docs: SolutionDoc[]): number {
  // Primary = newest created_at (YYYY-MM-DD lexicographic sort works).
  let best = 0;
  for (let i = 1; i < docs.length; i++) {
    if (docs[i].frontmatter.created_at > docs[best].frontmatter.created_at) {
      best = i;
    }
  }
  return best;
}

/**
 * Classify a single group of SolutionDocs sharing (problem_type, component).
 *
 * Rules (applied in order, first match wins):
 *   1. Singleton + high stale score  → Delete  (requires staleProbe + deleteThreshold)
 *   2. Singleton                     → Keep
 *   3. Any pair ≥ replaceThreshold AND one is stale → Replace (keep fresh, archive stale)
 *   4. Any pair ≥ consolidateThreshold             → Consolidate (keep primary, archive rest)
 *   5. otherwise                                   → Update (all kept, flagged for merge)
 *
 * The returned `scores` matrix is full (i,j) filled, diagonal = 1.0 self-sim.
 */
export async function classifyGroup(
  docs: SolutionDoc[],
  opts: Required<Omit<RefreshOptions, 'staleProbe'>> & Pick<RefreshOptions, 'staleProbe'>,
): Promise<RefreshDecision> {
  if (docs.length === 0) {
    throw new Error('classifyGroup: empty group — groupSolutionDocs should not emit this');
  }

  // Score matrix. O(n²); fine for n ≤ few dozen.
  const n = docs.length;
  const scores: OverlapScore[][] = Array.from({ length: n }, () => Array(n).fill(null as any));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        scores[i][j] = {
          problem: 1, rootCause: 1, solution: 1, files: 1, prevention: 1, overall: 1,
        };
      } else if (j < i) {
        scores[i][j] = scores[j][i]; // symmetric
      } else {
        scores[i][j] = scoreOverlap(docs[i], docs[j]);
      }
    }
  }

  // ── Singleton path ──
  if (n === 1) {
    let staleness = 0;
    if (opts.staleProbe) {
      try { staleness = await opts.staleProbe(docs[0]); } catch { staleness = 0; }
    }
    if (staleness >= opts.deleteThreshold) {
      return {
        classification: 'Delete',
        docs,
        primary: 0,
        scores,
        reason: `Component "${docs[0].frontmatter.component}" appears gone (stale score ${staleness.toFixed(2)} ≥ ${opts.deleteThreshold}).`,
        archiveCandidates: [docs[0].path],
      };
    }
    return {
      classification: 'Keep',
      docs,
      primary: 0,
      scores,
      reason: 'Singleton with no duplicate or stale evidence — keep as-is.',
      archiveCandidates: [],
    };
  }

  // ── Multi-doc path ──
  const primary = pickPrimary(docs);

  // Find the highest off-diagonal pairwise overall score.
  let maxOverall = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (scores[i][j].overall > maxOverall) maxOverall = scores[i][j].overall;
    }
  }

  // Replace requires BOTH a high score AND at least one doc in the group
  // being stale (component paths gone). This is our R-4 rename-detection gate.
  if (maxOverall >= opts.replaceThreshold && opts.staleProbe) {
    const staleness = await Promise.all(docs.map((d) => opts.staleProbe!(d).catch(() => 0)));
    const staleIdxs = staleness
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => s >= opts.deleteThreshold && i !== primary);
    if (staleIdxs.length > 0) {
      return {
        classification: 'Replace',
        docs,
        primary,
        scores,
        reason: `High overlap (≥${opts.replaceThreshold}) and ${staleIdxs.length} doc(s) in group reference stale components — replace with primary.`,
        archiveCandidates: staleIdxs.map(({ i }) => docs[i].path),
      };
    }
  }

  if (maxOverall >= opts.consolidateThreshold) {
    const archiveCandidates = docs
      .map((d, i) => ({ d, i }))
      .filter(({ i }) => i !== primary)
      .map(({ d }) => d.path);
    return {
      classification: 'Consolidate',
      docs,
      primary,
      scores,
      reason: `Pairwise overlap ≥${opts.consolidateThreshold} — consolidate into primary (${docs[primary].path}).`,
      archiveCandidates,
    };
  }

  return {
    classification: 'Update',
    docs,
    primary,
    scores,
    reason: `Related group (same problem_type + component) but overlap <${opts.consolidateThreshold} — flag for manual merge.`,
    archiveCandidates: [],
  };
}

// ─── Public entry point ────────────────────────────────────────

const DEFAULT_OPTS: Required<Omit<RefreshOptions, 'staleProbe'>> = {
  consolidateThreshold: 0.75,
  replaceThreshold: 0.85,
  deleteThreshold: 0.9,
};

/**
 * Run the full sweep: list → parse → group → classify.
 *
 * Any parse failure on an individual doc is surfaced in `unparseable[]`
 * but does NOT abort the sweep — we prefer a partial report over none.
 */
export async function refreshLearnings(
  root: string,
  fs: RefreshFs,
  options: RefreshOptions = {},
): Promise<RefreshReport> {
  const start = Date.now();
  const opts = { ...DEFAULT_OPTS, ...options };

  const paths = await fs.listMarkdown(root);
  const docs: SolutionDoc[] = [];
  const unparseable: Array<{ path: string; reason: string }> = [];

  for (const rel of paths) {
    // Skip archive — we never re-score archived entries.
    if (rel.startsWith('_archive/') || rel.includes('/_archive/')) continue;
    let raw: string;
    try {
      raw = normalizeText(await fs.readFile(`${root}/${rel}`));
    } catch (err) {
      unparseable.push({
        path: rel,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const parsed = parseSolutionDocMarkdown(raw);
    if (!parsed) {
      unparseable.push({ path: rel, reason: 'frontmatter parse failed' });
      continue;
    }
    // Reconstruct the path-prefixed SolutionDoc shape. The scanner does
    // NOT synthesize paths that fail the schema regex — malformed on-disk
    // names land in unparseable[].
    const fullPath = `docs/solutions/${rel}`;
    if (!/^docs\/solutions\/[a-z0-9-]+\/[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.md$/.test(fullPath)) {
      unparseable.push({ path: rel, reason: 'path does not match docs/solutions schema' });
      continue;
    }
    docs.push({ path: fullPath, frontmatter: parsed.frontmatter, body: parsed.body });
  }

  const groups = groupSolutionDocs(docs);
  const decisions: RefreshDecision[] = [];
  for (const g of groups) {
    decisions.push(await classifyGroup(g, opts));
  }

  return {
    decisions,
    unparseable,
    elapsedMs: Date.now() - start,
  };
}
