/**
 * Convergence math for plan revisions.
 *
 * Multi-signal convergence detector with a ring-buffer of revision metrics
 * and a sign-flip oscillation guard (the "B6" trap from APR-Pro:
 * `1000 → 1200 → 800 → 1100 → 900` looks "stable" by avg-of-halves but is
 * actually oscillating).
 *
 * Schema is `version: 1` — additive forever (mirrors the convention set by
 * `CompletionReportSchemaV1` in `completion-report.ts`). When algorithm
 * behaviour changes in a way that affects gating, bump `scoreVersion`
 * separately so consumers can detect score-version mismatches without
 * reinterpreting old states under new rules.
 *
 * Per Phase 12 final synthesis (docs/research-apr-pro-integration.md §12.4):
 * the score is consumed by both human (Step 5.45 menu hint) and orchestrator
 * (`flywheel_advance_wave` gating). Auto-approve at score ≥0.90 STILL routes
 * through `AskUserQuestion` — no silent advancement. The score never arms
 * menu defaults; it only mentions itself in question text.
 */

import { z } from "zod";

// ─── Constants ──────────────────────────────────────────────

/** Ring-buffer cap. Holds at most N most-recent revisions. */
export const REVISION_BUFFER_SIZE = 5;

/** Score algorithm version. Bump when gating behaviour changes. */
export const SCORE_VERSION = 1 as const;

// ─── Sub-schemas ───────────────────────────────────────────

const SizeSchema = z.object({
  lines: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  chars: z.number().int().nonnegative(),
});

const StructuralSchema = z.object({
  headings: z.number().int().nonnegative(),
  codeBlocks: z.number().int().nonnegative(),
  links: z.number().int().nonnegative(),
  listItems: z.number().int().nonnegative(),
});

const DiffSchema = z.object({
  addedLines: z.number().int().nonnegative(),
  removedLines: z.number().int().nonnegative(),
  /** 0 = unrelated, 1 = identical */
  similarityScore: z.number().min(0).max(1),
});

// ─── RevisionMetrics ───────────────────────────────────────

export const RevisionMetricsSchema = z.object({
  version: z.literal(1),
  revisionId: z.string().min(1),
  timestamp: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), {
      message: "timestamp must be ISO-8601 parseable",
    }),
  size: SizeSchema,
  structural: StructuralSchema,
  diffVsPrior: DiffSchema.nullable(),
});

export type RevisionMetrics = z.infer<typeof RevisionMetricsSchema>;

// ─── ConvergenceState ──────────────────────────────────────

export const ConvergenceStatusEnum = z.enum([
  "diverging",
  "approaching",
  "nearly_converged",
  "converged",
  "oscillating",
]);
export type ConvergenceStatus = z.infer<typeof ConvergenceStatusEnum>;

const SignalsSchema = z.object({
  /** Mean abs-delta of `size.lines` round-to-round, normalised by current size. */
  outputSizeTrend: z.number(),
  /** Mean (added+removed) per round, normalised by current size. */
  changeVelocity: z.number(),
  /** Mean similarityScore across diffs (0..1). */
  similarityTrend: z.number(),
});

const OscillationSchema = z.object({
  signFlips: z.number().int().nonnegative(),
  detected: z.boolean(),
});

export const ConvergenceStateSchema = z.object({
  version: z.literal(1),
  planSlug: z.string().min(1),
  scoreVersion: z.literal(SCORE_VERSION),
  revisions: z.array(RevisionMetricsSchema).max(REVISION_BUFFER_SIZE),
  signals: SignalsSchema,
  oscillation: OscillationSchema,
  score: z.number().min(0).max(1),
  status: ConvergenceStatusEnum,
  estimatedRoundsRemaining: z.number().int().min(1).max(10).nullable(),
  computedAt: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), {
      message: "computedAt must be ISO-8601 parseable",
    }),
});

export type ConvergenceState = z.infer<typeof ConvergenceStateSchema>;

// ─── Pure metric extraction ────────────────────────────────

function countWords(s: string): number {
  const m = s.match(/\S+/g);
  return m ? m.length : 0;
}

function countLines(s: string): number {
  if (s.length === 0) return 0;
  // count newlines + 1 if last char isn't newline
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  return s.endsWith("\n") ? n : n + 1;
}

function structuralCounts(md: string): {
  headings: number;
  codeBlocks: number;
  links: number;
  listItems: number;
} {
  const lines = md.split(/\r?\n/);
  let headings = 0;
  let listItems = 0;
  let inFence = false;
  let fenceCount = 0;
  for (const line of lines) {
    if (/^\s{0,3}```/.test(line)) {
      if (!inFence) {
        inFence = true;
        fenceCount++;
      } else {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    if (/^\s{0,3}#{1,6}\s+\S/.test(line)) headings++;
    if (/^\s*([-*+]|\d+\.)\s+\S/.test(line)) listItems++;
  }
  // Markdown link form: [text](url) — count occurrences across full text (outside fences would
  // be ideal, but additive count is fine for trend signal).
  const linkMatches = md.match(/\[[^\]]+\]\([^)]+\)/g);
  const links = linkMatches ? linkMatches.length : 0;
  return { headings, codeBlocks: fenceCount, links, listItems };
}

/**
 * Cheap shingled-similarity score in [0, 1]. Uses 4-gram character shingles.
 * 1 = identical, 0 = no shingles in common. Does not normalise markdown
 * structure (Phase 13 deferred per §12.7).
 */
function jaccardSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const k = 4;
  const shingle = (s: string): Set<string> => {
    const out = new Set<string>();
    if (s.length < k) {
      out.add(s);
      return out;
    }
    for (let i = 0; i <= s.length - k; i++) {
      out.add(s.slice(i, i + k));
    }
    return out;
  };
  const A = shingle(a);
  const B = shingle(b);
  let intersect = 0;
  for (const x of A) if (B.has(x)) intersect++;
  const union = A.size + B.size - intersect;
  if (union === 0) return 0;
  return intersect / union;
}

function diffLineCounts(prior: string, current: string): {
  addedLines: number;
  removedLines: number;
} {
  const a = prior.split(/\r?\n/);
  const b = current.split(/\r?\n/);
  const aSet = new Map<string, number>();
  for (const line of a) aSet.set(line, (aSet.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of b) {
    const c = aSet.get(line) ?? 0;
    if (c > 0) {
      aSet.set(line, c - 1);
    } else {
      added++;
    }
  }
  let removed = 0;
  for (const c of aSet.values()) removed += c;
  return { addedLines: added, removedLines: removed };
}

export function computeRevisionMetrics(
  currentMd: string,
  priorMd: string | null,
  opts: { revisionId?: string; timestamp?: string } = {},
): RevisionMetrics {
  const revisionId =
    opts.revisionId ?? `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const size = {
    lines: countLines(currentMd),
    words: countWords(currentMd),
    chars: currentMd.length,
  };
  const structural = structuralCounts(currentMd);
  let diffVsPrior: { addedLines: number; removedLines: number; similarityScore: number } | null =
    null;
  if (priorMd !== null) {
    const { addedLines, removedLines } = diffLineCounts(priorMd, currentMd);
    diffVsPrior = {
      addedLines,
      removedLines,
      similarityScore: jaccardSimilarity(priorMd, currentMd),
    };
  }
  return RevisionMetricsSchema.parse({
    version: 1,
    revisionId,
    timestamp,
    size,
    structural,
    diffVsPrior,
  });
}

// ─── Score computation ─────────────────────────────────────

/**
 * Score thresholds (50/75/90 ladder):
 *   <0.50 diverging | 0.50–0.75 approaching | 0.75–0.90 nearly_converged | ≥0.90 converged
 * `oscillation.detected = true` overrides → "oscillating".
 */
function statusForScore(score: number): Exclude<ConvergenceStatus, "oscillating"> {
  if (score >= 0.9) return "converged";
  if (score >= 0.75) return "nearly_converged";
  if (score >= 0.5) return "approaching";
  return "diverging";
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function clampInt(x: number, lo: number, hi: number): number {
  const r = Math.round(x);
  if (r < lo) return lo;
  if (r > hi) return hi;
  return r;
}

function computeSignals(revs: RevisionMetrics[]): {
  outputSizeTrend: number;
  changeVelocity: number;
  similarityTrend: number;
} {
  if (revs.length < 2) {
    return { outputSizeTrend: 0, changeVelocity: 0, similarityTrend: 1 };
  }
  let absSizeDelta = 0;
  let velocity = 0;
  let simSum = 0;
  let simCount = 0;
  for (let i = 1; i < revs.length; i++) {
    const prev = revs[i - 1];
    const cur = revs[i];
    absSizeDelta += Math.abs(cur.size.lines - prev.size.lines);
    if (cur.diffVsPrior) {
      velocity += cur.diffVsPrior.addedLines + cur.diffVsPrior.removedLines;
      simSum += cur.diffVsPrior.similarityScore;
      simCount++;
    }
  }
  const denom = Math.max(1, revs[revs.length - 1].size.lines);
  const pairs = revs.length - 1;
  return {
    outputSizeTrend: absSizeDelta / pairs / denom,
    changeVelocity: velocity / pairs / denom,
    similarityTrend: simCount > 0 ? simSum / simCount : 1,
  };
}

function detectOscillation(revs: RevisionMetrics[]): {
  signFlips: number;
  detected: boolean;
} {
  if (revs.length < 3) return { signFlips: 0, detected: false };
  let prevSign = 0;
  let flips = 0;
  for (let i = 1; i < revs.length; i++) {
    const delta = revs[i].size.lines - revs[i - 1].size.lines;
    const sign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) flips++;
    if (sign !== 0) prevSign = sign;
  }
  // Threshold per §12.5 acceptance: detected when sign-flips exceed ~N/3.
  const threshold = Math.floor(revs.length / 3);
  return { signFlips: flips, detected: flips > threshold };
}

function isMonotonicallyClimbing(scores: number[]): boolean {
  if (scores.length < 2) return false;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] < scores[i - 1]) return false;
  }
  // require at least one strict increase
  return scores[scores.length - 1] > scores[0];
}

/**
 * Score = weighted blend of the three signals, mapped into [0,1].
 *   - similarityTrend (high = converging): weight 0.5
 *   - inverse outputSizeTrend (low churn = converging): weight 0.3
 *   - inverse changeVelocity (low diff churn = converging): weight 0.2
 *
 * With <2 revisions there's no signal to blend — score is 0 (diverging).
 */
function computeScore(signals: ReturnType<typeof computeSignals>, revCount: number): number {
  if (revCount < 2) return 0;
  // Saturate churn metrics: anything ≥ 1.0 (changes equal current size) is "max churn"
  const sizeChurn = clamp01(signals.outputSizeTrend);
  const velChurn = clamp01(signals.changeVelocity);
  const sim = clamp01(signals.similarityTrend);
  const blended = 0.5 * sim + 0.3 * (1 - sizeChurn) + 0.2 * (1 - velChurn);
  return clamp01(blended);
}

// ─── State accumulator ─────────────────────────────────────

export interface AppendRevisionOptions {
  /** Override for tests / reproducibility. */
  computedAt?: string;
}

/**
 * Append a revision to a (possibly null) prior state, recompute signals,
 * score, and oscillation flag. Returns a new state — never mutates input.
 *
 * `state.scoreVersion` is always pinned to the current `SCORE_VERSION`. If
 * `state.scoreVersion` does not match (possible when reading an older
 * persisted state), the caller should reject via the dedicated
 * `score_version_mismatch` error code rather than passing it here.
 */
export function appendRevision(
  state: ConvergenceState | null,
  metrics: RevisionMetrics,
  planSlug: string,
  opts: AppendRevisionOptions = {},
): ConvergenceState {
  if (state && state.scoreVersion !== SCORE_VERSION) {
    throw new Error(
      `appendRevision: state.scoreVersion=${state.scoreVersion} does not match SCORE_VERSION=${SCORE_VERSION}; caller must surface score_version_mismatch`,
    );
  }
  const priorRevs = state?.revisions ?? [];
  const allRevs = [...priorRevs, metrics];
  const ringRevs =
    allRevs.length > REVISION_BUFFER_SIZE
      ? allRevs.slice(allRevs.length - REVISION_BUFFER_SIZE)
      : allRevs;

  const signals = computeSignals(ringRevs);
  const oscillation = detectOscillation(ringRevs);
  const score = computeScore(signals, ringRevs.length);
  let status: ConvergenceStatus;
  let estimatedRoundsRemaining: number | null;
  if (oscillation.detected) {
    status = "oscillating";
    estimatedRoundsRemaining = null;
  } else {
    status = statusForScore(score);
    // Conservative projection: only when buffer is full AND scores climbing.
    // Bead spec: drop the (1-score)*5 default; only emit when revisions.length === N
    // and the trajectory is monotonically climbing — then a clamped linear projection.
    const next: ConvergenceState = {
      version: 1,
      planSlug,
      scoreVersion: SCORE_VERSION,
      revisions: ringRevs,
      signals,
      oscillation,
      score,
      status,
      estimatedRoundsRemaining: null,
      computedAt: opts.computedAt ?? new Date().toISOString(),
    };
    if (ringRevs.length === REVISION_BUFFER_SIZE) {
      // Reconstruct historical scores for the climbing check by computing the
      // score at each suffix prefix-end. Cheap (N ≤ 5).
      const hist: number[] = [];
      for (let i = 2; i <= ringRevs.length; i++) {
        const sub = ringRevs.slice(0, i);
        hist.push(computeScore(computeSignals(sub), sub.length));
      }
      if (hist.length >= 2 && isMonotonicallyClimbing(hist)) {
        const first = hist[0];
        const last = hist[hist.length - 1];
        const slopePerRound = (last - first) / (hist.length - 1);
        if (slopePerRound > 0 && last < 0.9) {
          const roundsToConverge = (0.9 - last) / slopePerRound;
          estimatedRoundsRemaining = clampInt(roundsToConverge, 1, 10);
        } else {
          estimatedRoundsRemaining = null;
        }
      } else {
        estimatedRoundsRemaining = null;
      }
    } else {
      estimatedRoundsRemaining = null;
    }
    return ConvergenceStateSchema.parse({
      ...next,
      estimatedRoundsRemaining,
    });
  }
  return ConvergenceStateSchema.parse({
    version: 1,
    planSlug,
    scoreVersion: SCORE_VERSION,
    revisions: ringRevs,
    signals,
    oscillation,
    score,
    status,
    estimatedRoundsRemaining,
    computedAt: opts.computedAt ?? new Date().toISOString(),
  });
}

// ─── Step 5.45 hint ────────────────────────────────────────

/**
 * Return a *Recommended* label for Step 5.45 — never auto-arms the menu.
 * Per Phase 12 §12.4 + README §Design Philosophy #3, the skill renders all 4
 * options unchanged in label and order; this is hint text only.
 *
 * Note: branches on `status` and `score`, never on `revisions.length`
 * (anti-pattern #3 from Phase 10).
 */
export function defaultStep545Action(
  state: ConvergenceState,
): "validate" | "approve" | "refine" {
  if (state.status === "oscillating") return "refine";
  if (state.status === "diverging") return "refine";
  if (state.score >= 0.9) return "approve";
  if (state.score >= 0.75) return "validate";
  return "refine";
}

// ─── Score-version mismatch helper ─────────────────────────

export type ConvergenceReadError =
  | { code: "invalid_json"; message: string }
  | { code: "schema_invalid"; message: string; issues: z.core.$ZodIssue[] }
  | { code: "score_version_mismatch"; message: string; gotVersion: number };

export type ConvergenceReadResult =
  | { ok: true; state: ConvergenceState }
  | { ok: false; error: ConvergenceReadError };

/**
 * Parse + version-check a persisted state JSON string. Use this when reading
 * `.pi-flywheel/plans/<slug>/convergence.json` from disk; returns a discriminated
 * `score_version_mismatch` error for older states so the orchestrator can refuse
 * to gate on stale-algorithm scores.
 */
export function parseConvergenceState(raw: string): ConvergenceReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    return { ok: false, error: { code: "invalid_json", message: String(err) } };
  }
  // Pre-check scoreVersion before strict schema parse so a bumped state still
  // produces a useful error rather than a generic schema_invalid.
  if (typeof parsed === "object" && parsed !== null && "scoreVersion" in parsed) {
    const sv = (parsed as { scoreVersion: unknown }).scoreVersion;
    if (typeof sv === "number" && sv !== SCORE_VERSION) {
      return {
        ok: false,
        error: {
          code: "score_version_mismatch",
          message: `convergence state scoreVersion=${sv}, current SCORE_VERSION=${SCORE_VERSION}`,
          gotVersion: sv,
        },
      };
    }
  }
  const result = ConvergenceStateSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "schema_invalid",
        message: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        issues: result.error.issues,
      },
    };
  }
  return { ok: true, state: result.data };
}

// ─── Internal helpers exported for test introspection ──────

/** @internal exposed for test inspection only */
export const __test = {
  computeSignals,
  detectOscillation,
  computeScore,
  statusForScore,
  jaccardSimilarity,
  diffLineCounts,
  countLines,
  countWords,
  structuralCounts,
};
