/**
 * Outcome grading — whole-cycle rubric synthesis, decorrelated grader, and
 * iteration-loop primitives (v3.13.0).
 *
 * Borrows the Anthropic Managed Agents API's "rubric + decorrelated grader +
 * iteration loop" pattern locally without adopting the MA API itself.
 *
 *   - `flywheel_synthesize_rubric` (T7) calls `synthesizeRubric()` (T5) at
 *     plan-approve time to author `.pi-flywheel/plans/<slug>/rubric.md`.
 *   - `flywheel_grade_outcome` (T8) calls `gradeOutcome()` (T6) at wrap-up
 *     time to spawn a decorrelated grader (codex primary, fresh-CC fallback)
 *     and persist the verdict to `.pi-flywheel/plans/<slug>/grading/iteration-<N>.json`.
 *   - The iteration loop is gated by `state.maxOutcomeIterations`
 *     (default 3, bounded [1,5]) — see `getMaxOutcomeIterations`.
 *
 * # Schema versioning — the v2 ladder
 *
 * Both `RubricSchemaV1` and `GraderVerdictSchemaV1` are pinned at
 * `version: z.literal(1)` and **additive forever** within the v1 generation:
 * new fields land as `.optional()` or with safe defaults; existing fields are
 * never removed.
 *
 * When the schema needs a breaking change (a non-additive constraint, a
 * required field, a renamed key), do NOT mutate `RubricSchemaV1` /
 * `GraderVerdictSchemaV1`. Instead:
 *
 *   1. Define `RubricSchemaV2` (or `GraderVerdictSchemaV2`) with the new
 *      shape and a fresh `version: z.literal(2)` discriminator.
 *   2. Compose a discriminated union for the *reader* path:
 *        const RubricSchema = z.discriminatedUnion('version', [
 *          RubricSchemaV1, RubricSchemaV2
 *        ]);
 *   3. Add a `readRubric()` helper that returns the parsed envelope tagged
 *      by version and lets callers branch on `rubric.version`.
 *   4. Writers stay version-aware — emit V2 only on freshly synthesised
 *      rubrics; preserve V1 when re-reading existing on-disk files.
 *
 * This freezes the v1 fixtures in `outcome-grading.test.ts` as a perpetual
 * regression corpus (see Risk R1).
 *
 * # `evidenceHint` threat model
 *
 * Each criterion may carry an `evidenceHint` string — a freeform pointer
 * like `"mcp-server/src/outcome-grading.ts"`. Hints are **never read or
 * exec'd** by either `synthesizeRubric` or `gradeOutcome`. They are
 * displayed in the rubric body and embedded as plain text in the grader
 * prompt. Path-traversal payloads (`"../../../etc/passwd"`) are
 * therefore harmless — there is no I/O surface for them to escape into
 * (Risk R8).
 *
 * # Bead provenance
 *
 *   - T1 (claude-orchestrator-25w): error codes the module throws.
 *   - T2 (claude-orchestrator-144): this module's schemas + parser.
 *   - T3 (claude-orchestrator-3u4): atomic-write helper this module uses.
 *   - T5 (claude-orchestrator-1s9): `synthesizeRubric()` body.
 *   - T6 (claude-orchestrator-2ma): `gradeOutcome()` body.
 */

import { z } from 'zod';

import { FlywheelError, sanitizeCause } from './errors.js';
import type { ToolContext, FlywheelState } from './types.js';

// ─── Schema versions ─────────────────────────────────────────────────────

/** Pinned forever within the v1 generation. See module header for the v2 ladder. */
export const RUBRIC_SCHEMA_VERSION = 1 as const;
/** Pinned forever within the v1 generation. See module header for the v2 ladder. */
export const GRADER_VERDICT_SCHEMA_VERSION = 1 as const;

// ─── Iteration-cap bounds + helper ───────────────────────────────────────

/** Lower bound for `state.maxOutcomeIterations`. */
export const MIN_OUTCOME_ITERATIONS = 1;
/** Upper bound for `state.maxOutcomeIterations`. Matches MA's `max_iterations` default ceiling. */
export const MAX_OUTCOME_ITERATIONS = 5;
/** Fallback when `state.maxOutcomeIterations` is unset. Matches MA's documented default. */
export const DEFAULT_OUTCOME_ITERATIONS = 3;

/**
 * Read the active iteration cap from session state, clamped to
 * `[MIN_OUTCOME_ITERATIONS, MAX_OUTCOME_ITERATIONS]`. Operators may set
 * `FW_MAX_OUTCOME_ITERATIONS` env to seed a different default at the call
 * site that writes to state (caller's responsibility).
 */
export function getMaxOutcomeIterations(state: Pick<FlywheelState, 'maxOutcomeIterations'>): number {
  const raw = state.maxOutcomeIterations ?? DEFAULT_OUTCOME_ITERATIONS;
  return Math.min(MAX_OUTCOME_ITERATIONS, Math.max(MIN_OUTCOME_ITERATIONS, raw));
}

// ─── RubricSchemaV1 ──────────────────────────────────────────────────────

const CRITERION_ID_RE = /^c\d+$/;

const RubricCriterionSchemaV1 = z.object({
  /** Stable id, regex `/^c\d+$/`. */
  id: z.string().regex(CRITERION_ID_RE, {
    message: 'criterion id must match /^c\\d+$/ (e.g. c1, c2, c10)',
  }),
  /** Human-readable description ≥10 chars; synthesizer is asked for <140. */
  description: z.string().min(10),
  /** Optional 0..1 weight. Sum-to-1 invariant is NOT enforced — operators may edit one criterion at a time. */
  weight: z.number().min(0).max(1).optional(),
  /**
   * Optional pointer to where the grader should look for evidence
   * (file path, function name, etc.). Never read or exec'd by this
   * module — see threat-model note in the file header.
   */
  evidenceHint: z.string().optional(),
});

export const RubricSchemaV1 = z.object({
  version: z.literal(RUBRIC_SCHEMA_VERSION),
  /** Origin of the current rubric body. `auto` = synthesizer. `edited` = operator edit applied via `action: 'edit'`. `user` = hand-authored from scratch. */
  source: z.enum(['auto', 'user', 'edited']),
  /** ISO-8601 timestamp the rubric was last synthesised or edited. */
  generatedAt: z.string().datetime(),
  /** Plan slug the rubric corresponds to (filesystem-safe). */
  planSlug: z.string().min(1),
  /** The selected goal — copied verbatim from `state.selectedGoal` at synth time. */
  goal: z.string().min(1),
  /** Synthesizer engine identifier (e.g. `claude-opus-4-7`, `codex-gpt-5.5`). Optional for v3.11.x checkpoints that lack the field. */
  engine: z.string().optional(),
  /** 3..15 criteria — bounds enforced at parse time. */
  criteria: z.array(RubricCriterionSchemaV1).min(3).max(15),
});
export type Rubric = z.infer<typeof RubricSchemaV1>;
export type RubricCriterion = z.infer<typeof RubricCriterionSchemaV1>;

// ─── PerCriterionVerdictSchema ───────────────────────────────────────────

export const PerCriterionVerdictSchema = z.object({
  criterionId: z.string(),
  status: z.enum(['met', 'unmet', 'partial']),
  /** Commit shas, file paths, quoted code, etc. — the grader's evidence trace. */
  evidence: z.string(),
  /** Empty when status is `met`; non-empty when `unmet` or `partial`. Each gap becomes an acceptance-criterion bullet on the remediation bead. */
  gaps: z.array(z.string()),
});
export type PerCriterionVerdict = z.infer<typeof PerCriterionVerdictSchema>;

// ─── GraderVerdictSchemaV1 ───────────────────────────────────────────────

export const GraderVerdictSchemaV1 = z.object({
  version: z.literal(GRADER_VERDICT_SCHEMA_VERSION),
  status: z.enum(['satisfied', 'needs_revision', 'max_iterations_reached', 'failed']),
  iteration: z.number().int().min(1),
  perCriterion: z.array(PerCriterionVerdictSchema),
  /** Free-text grader summary — also surfaces grader self-flags (e.g. "diff was truncated"). */
  explanation: z.string(),
  modelUsed: z.enum(['codex', 'claude']),
  durationMs: z.number().int().min(0),
  timestamp: z.string().datetime(),
  /**
   * Open-ended breadcrumb map. Used for non-load-bearing context that
   * downstream tools may render but never branch on. Reserved keys:
   *   - `cycleStartShaSource`: 'state' | 'checkpoint' | 'git-log-by-time' | 'fallback_head_minus_50'
   *   - `diffTruncated`: boolean
   *   - `testOutputTruncated`: boolean
   *   - `graderRetried`: boolean
   *   - `fallbackReason`: string (set when `modelUsed === 'claude'`)
   */
  details: z.record(z.string(), z.unknown()).optional(),
  /**
   * Set to `'failed'` when the verdict was computed but `writeVerdictFile`
   * threw ENOSPC / EROFS / similar (Risk R14). Caller surfaces a warning
   * and proceeds with the in-memory verdict; the verdict is not on disk.
   */
  persistence: z.enum(['ok', 'failed']).optional(),
});
export type GraderVerdict = z.infer<typeof GraderVerdictSchemaV1>;

// ─── Skip sentinel ───────────────────────────────────────────────────────

/**
 * Returned by `gradeOutcome` when the operator picked "Skip rubric" at the
 * Step 5.6 rubric gate. NOT a `GraderVerdict`: callers branch on the
 * presence of the `'skipped' in result` discriminator before reading
 * verdict fields.
 */
export interface GradeSkippedSentinel {
  status: 'skipped';
  reason: 'operator-skipped-at-plan-approve';
  iteration: 0;
}

/** Type-guard for the skip sentinel. */
export function isGradeSkipped(
  result: GraderVerdict | GradeSkippedSentinel,
): result is GradeSkippedSentinel {
  return result.status === 'skipped';
}

// ─── Frontmatter parser ──────────────────────────────────────────────────

/**
 * Parse the YAML-frontmatter block of a `rubric.md` file and validate it
 * against {@link RubricSchemaV1}. Throws a {@link FlywheelError} with code
 * `rubric_synth_invalid` on either parse-shape failure or Zod failure.
 *
 * The accepted YAML subset is intentionally narrow: the synthesizer prompt
 * pins the shape (flat scalars + a `criteria:` list of mappings with
 * scalar fields). Anything outside that subset surfaces as a structured
 * error and routes through the edit-failure recovery flow.
 *
 * Recognised constructs:
 *   - `key: value` (top-level scalar; unquoted, single-quoted, or double-quoted)
 *   - `key:` followed by indented `- ` list items
 *   - `- key: value` (list-item with first key inline)
 *   - `  key: value` (subsequent keys on a list item, indented further)
 *   - `# comment` lines and blank lines (ignored)
 *
 * Numeric, boolean, and ISO-8601 datetime scalars are auto-coerced. All
 * other values stay strings.
 */
export function parseRubricFrontmatter(raw: string): Rubric {
  const normalised = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalised.split('\n');

  if (lines.length === 0 || lines[0].trim() !== '---') {
    throw new FlywheelError({
      code: 'rubric_synth_invalid',
      message: 'rubric.md is missing the opening `---` frontmatter delimiter',
      cause: sanitizeCause('first line was: ' + (lines[0] ?? '<empty>')),
    });
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    throw new FlywheelError({
      code: 'rubric_synth_invalid',
      message: 'rubric.md is missing the closing `---` frontmatter delimiter',
    });
  }

  const fmLines = lines.slice(1, closeIdx);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseRubricYamlSubset(fmLines);
  } catch (err) {
    throw new FlywheelError({
      code: 'rubric_synth_invalid',
      message: 'rubric.md frontmatter could not be parsed as the expected YAML subset',
      cause: sanitizeCause(err instanceof Error ? err.message : String(err)),
    });
  }

  const result = RubricSchemaV1.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new FlywheelError({
      code: 'rubric_synth_invalid',
      message: 'rubric.md frontmatter failed RubricSchemaV1 validation',
      cause: sanitizeCause(issues),
    });
  }
  return result.data;
}

/**
 * Deliberately small YAML subset parser scoped to the rubric frontmatter
 * shape. Pure (no I/O), defensive, and well-tested — see
 * `outcome-grading.test.ts`.
 *
 * Out of scope: anchors, references, multi-line block scalars (`|`, `>`),
 * inline flow style (`{a: 1, b: 2}`, `[1, 2]`), nested lists. The
 * synthesizer prompt is constrained to emit only the subset we accept; any
 * deviation surfaces as `rubric_synth_invalid` and routes through the
 * edit-failure recovery loop.
 */
function parseRubricYamlSubset(lines: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      continue;
    }

    // Top-level key.
    const colon = raw.indexOf(':');
    if (colon === -1) {
      throw new Error(`expected "key: value" or "key:" at line ${i + 1}, got: ${raw}`);
    }
    const indentMatch = /^\s*/.exec(raw);
    const indent = indentMatch ? indentMatch[0].length : 0;
    if (indent !== 0) {
      throw new Error(`unexpected indentation at top-level line ${i + 1}: ${raw}`);
    }
    const key = raw.slice(0, colon).trim();
    const after = raw.slice(colon + 1);
    const value = after.trim();

    if (value === '') {
      // Block — peek next non-blank line. If it's a `- ` list item, consume
      // the list. Otherwise treat as empty string.
      const next = peekNextNonBlank(lines, i + 1);
      if (next !== null && /^\s*-\s/.test(next.line)) {
        const { items, advanceTo } = parseListItems(lines, i + 1);
        out[key] = items;
        i = advanceTo;
        continue;
      }
      out[key] = '';
      i++;
      continue;
    }

    out[key] = coerceScalar(stripQuotes(value));
    i++;
  }

  return out;
}

interface PeekedLine {
  line: string;
  index: number;
}

function peekNextNonBlank(lines: string[], from: number): PeekedLine | null {
  for (let j = from; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t === '' || t.startsWith('#')) continue;
    return { line: lines[j], index: j };
  }
  return null;
}

interface ParsedList {
  items: Array<Record<string, unknown>>;
  advanceTo: number;
}

function parseListItems(lines: string[], from: number): ParsedList {
  const items: Array<Record<string, unknown>> = [];
  let i = from;
  let listIndent = -1;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      continue;
    }
    const indentMatch = /^\s*/.exec(raw);
    const indent = indentMatch ? indentMatch[0].length : 0;
    if (indent === 0) break; // back to top-level

    const dashMatch = /^(\s*)-\s+(.*)$/.exec(raw);
    if (dashMatch && (listIndent === -1 || indent === listIndent)) {
      listIndent = indent;
      const item: Record<string, unknown> = {};
      const inline = dashMatch[2];
      // `- key: value` or `- value`
      const inlineColon = inline.indexOf(':');
      if (inlineColon !== -1 && !/^["'][^"']*$/.test(inline)) {
        const k = inline.slice(0, inlineColon).trim();
        const v = inline.slice(inlineColon + 1).trim();
        item[k] = coerceScalar(stripQuotes(v));
      } else {
        // Bare scalar list item — not used in our shape but tolerated.
        item.__value__ = coerceScalar(stripQuotes(inline));
      }
      i++;
      // Consume continuation keys at deeper indent.
      while (i < lines.length) {
        const contRaw = lines[i];
        const contTrimmed = contRaw.trim();
        if (contTrimmed === '' || contTrimmed.startsWith('#')) {
          i++;
          continue;
        }
        const contIndentMatch = /^\s*/.exec(contRaw);
        const contIndent = contIndentMatch ? contIndentMatch[0].length : 0;
        if (contIndent <= indent) break;
        if (/^\s*-\s/.test(contRaw)) break;
        const cColon = contRaw.indexOf(':');
        if (cColon === -1) {
          throw new Error(
            `expected "key: value" continuation on list item at line ${i + 1}, got: ${contRaw}`,
          );
        }
        const ck = contRaw.slice(0, cColon).trim();
        const cv = contRaw.slice(cColon + 1).trim();
        item[ck] = coerceScalar(stripQuotes(cv));
        i++;
      }
      items.push(item);
      continue;
    }
    break;
  }

  return { items, advanceTo: i };
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\');
    }
  }
  return value;
}

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

function coerceScalar(value: string): string | number | boolean {
  if (value === '') return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (ISO_DATETIME_RE.test(value)) return value; // keep ISO strings as strings
  if (/^-?\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return value;
}

// ─── Frontmatter writer ──────────────────────────────────────────────────

/**
 * Render a {@link Rubric} object as a YAML frontmatter string suitable for
 * embedding in `rubric.md`. Inverse of `parseRubricFrontmatter`. The
 * round-trip `parse → render → parse` is required to be deepEqual; tests
 * enforce this.
 */
export function renderRubricFrontmatter(rubric: Rubric): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`version: ${rubric.version}`);
  lines.push(`source: ${rubric.source}`);
  lines.push(`generatedAt: ${rubric.generatedAt}`);
  lines.push(`planSlug: ${yamlScalar(rubric.planSlug)}`);
  lines.push(`goal: ${yamlScalar(rubric.goal)}`);
  if (rubric.engine !== undefined) {
    lines.push(`engine: ${yamlScalar(rubric.engine)}`);
  }
  lines.push('criteria:');
  for (const c of rubric.criteria) {
    lines.push(`  - id: ${c.id}`);
    lines.push(`    description: ${yamlScalar(c.description)}`);
    if (c.weight !== undefined) {
      lines.push(`    weight: ${c.weight}`);
    }
    if (c.evidenceHint !== undefined) {
      lines.push(`    evidenceHint: ${yamlScalar(c.evidenceHint)}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

/**
 * Quote a scalar for safe re-parsing — anything that contains a `:`,
 * `#`, leading/trailing whitespace, a leading `-`, or looks like a
 * number/bool/datetime gets double-quoted with `\\` and `"` escapes.
 */
function yamlScalar(value: string): string {
  const needsQuote =
    value === '' ||
    /^\s|\s$/.test(value) ||
    /[:#"']/.test(value) ||
    /^-/.test(value) ||
    value === 'true' ||
    value === 'false' ||
    /^-?\d+$/.test(value) ||
    /^-?\d+\.\d+$/.test(value) ||
    ISO_DATETIME_RE.test(value);
  if (!needsQuote) return value;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// ─── Plan-slug helper ────────────────────────────────────────────────────

/**
 * Slugify a plan path or freeform identifier into a filesystem-safe slug.
 * Mirrors the slug derivation used by `flywheel_convergence` so the
 * `.pi-flywheel/plans/<slug>/` directory carries the same name across
 * tools.
 */
export function planSlugFromIdentifier(planPathOrId: string): string {
  const base = planPathOrId
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.md$/i, '') ?? planPathOrId;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ─── Verdict-table renderer (used by Step 9.5 surface) ───────────────────

/**
 * Render a markdown table of `criterion | status | gap` rows for the
 * unmet/partial criteria in a verdict. Each gap is truncated to 120 chars
 * and only the **first** gap per criterion is shown — the full list lives
 * in `iteration-<N>.json`.
 *
 * Wrap-up step 9.5 prints this immediately under the verdict-summary line
 * so operators see what failed before answering the Iterate / Accept /
 * Abort question.
 */
export function renderVerdictTable(verdict: GraderVerdict): string {
  const failing = verdict.perCriterion.filter((c) => c.status !== 'met');
  if (failing.length === 0) {
    return 'All criteria met — no failing rows.';
  }
  const lines = [
    '| Criterion | Status | Gap |',
    '|---|---|---|',
  ];
  for (const c of failing) {
    const firstGap = c.gaps[0] ?? '';
    const trimmed = firstGap.length > 120 ? `${firstGap.slice(0, 117)}...` : firstGap;
    lines.push(`| ${c.criterionId} | ${c.status} | ${escapePipes(trimmed)} |`);
  }
  return lines.join('\n');
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, '\\|');
}

// ─── Function signatures (bodies land in T5/T6) ─────────────────────────

export interface SynthesizeRubricArgs {
  cwd: string;
  planSlug?: string;
  planPath?: string;
  /**
   * Default `'synthesize'` runs the full synth → write path with the
   * `source: 'edited' || 'user'` guard. `'validate'` parses the current
   * `rubric.md` and returns it without writing. `'edit'` applies an
   * `editIntent` to the current rubric. `'regenerate'` is `'synthesize'`
   * with `force: true` semantics (overrides the edited-source guard).
   */
  action?: 'synthesize' | 'validate' | 'edit' | 'regenerate';
  /** Required when `action === 'edit'`. Ignored otherwise. */
  editIntent?: {
    kind: 'tighten' | 'add' | 'remove' | 'custom';
    text: string;
  };
  /** Bypass the `planContentSha` cache and the `source: 'edited' || 'user'` guard. */
  force?: boolean;
}

export interface SynthesizeRubricResult {
  rubricPath: string;
  rubric: Rubric;
  /** `'cached'` when the prior file was reused; otherwise mirrors `rubric.source`. */
  source: Rubric['source'] | 'cached';
}

/**
 * Synthesize (or load, edit, regenerate) the cycle-level outcome rubric.
 *
 * The body lands in T5 (claude-orchestrator-1s9). T2 ships only the
 * signature so downstream tool wrappers (T7) can typecheck against it.
 */
export function synthesizeRubric(
  _ctx: ToolContext,
  _args: SynthesizeRubricArgs,
): Promise<SynthesizeRubricResult> {
  return Promise.reject(
    new FlywheelError({
      code: 'internal_error',
      message: 'synthesizeRubric not yet implemented — landing in T5 (claude-orchestrator-1s9)',
      retryable: false,
    }),
  );
}

export interface GradeOutcomeArgs {
  cwd: string;
  planSlug?: string;
  /** Bypass the `iteration-<N>.json`-exists guard and the in-memory mutex. */
  force?: boolean;
}

/**
 * Grade the cycle outcome with a model strictly decorrelated from the
 * implementation swarm — codex primary, fresh-CC fallback.
 *
 * The body lands in T6 (claude-orchestrator-2ma). T2 ships only the
 * signature so downstream tool wrappers (T8) can typecheck against it.
 */
export function gradeOutcome(
  _ctx: ToolContext,
  _args: GradeOutcomeArgs,
): Promise<GraderVerdict | GradeSkippedSentinel> {
  return Promise.reject(
    new FlywheelError({
      code: 'internal_error',
      message: 'gradeOutcome not yet implemented — landing in T6 (claude-orchestrator-2ma)',
      retryable: false,
    }),
  );
}
