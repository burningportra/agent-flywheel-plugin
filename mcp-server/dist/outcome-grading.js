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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { writeAtomic } from './atomic-write.js';
import { FlywheelError, sanitizeCause, errMsg } from './errors.js';
import { createLogger } from './logger.js';
import { isCodexIncompatibleModel, parseCodexConfigTopLevelModel } from './tools/doctor.js';
const log = createLogger('outcome-grading');
// ─── Schema versions ─────────────────────────────────────────────────────
/** Pinned forever within the v1 generation. See module header for the v2 ladder. */
export const RUBRIC_SCHEMA_VERSION = 1;
/** Pinned forever within the v1 generation. See module header for the v2 ladder. */
export const GRADER_VERDICT_SCHEMA_VERSION = 1;
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
export function getMaxOutcomeIterations(state) {
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
// ─── PerCriterionVerdictSchema ───────────────────────────────────────────
export const PerCriterionVerdictSchema = z.object({
    criterionId: z.string(),
    status: z.enum(['met', 'unmet', 'partial']),
    /** Commit shas, file paths, quoted code, etc. — the grader's evidence trace. */
    evidence: z.string(),
    /** Empty when status is `met`; non-empty when `unmet` or `partial`. Each gap becomes an acceptance-criterion bullet on the remediation bead. */
    gaps: z.array(z.string()),
});
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
/** Type-guard for the skip sentinel. */
export function isGradeSkipped(result) {
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
export function parseRubricFrontmatter(raw) {
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
    let parsed;
    try {
        parsed = parseRubricYamlSubset(fmLines);
    }
    catch (err) {
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
function parseRubricYamlSubset(lines) {
    const out = {};
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
function peekNextNonBlank(lines, from) {
    for (let j = from; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t === '' || t.startsWith('#'))
            continue;
        return { line: lines[j], index: j };
    }
    return null;
}
function parseListItems(lines, from) {
    const items = [];
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
        if (indent === 0)
            break; // back to top-level
        const dashMatch = /^(\s*)-\s+(.*)$/.exec(raw);
        if (dashMatch && (listIndent === -1 || indent === listIndent)) {
            listIndent = indent;
            const item = {};
            const inline = dashMatch[2];
            // `- key: value` or `- value`
            const inlineColon = inline.indexOf(':');
            if (inlineColon !== -1 && !/^["'][^"']*$/.test(inline)) {
                const k = inline.slice(0, inlineColon).trim();
                const v = inline.slice(inlineColon + 1).trim();
                item[k] = coerceScalar(stripQuotes(v));
            }
            else {
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
                if (contIndent <= indent)
                    break;
                if (/^\s*-\s/.test(contRaw))
                    break;
                const cColon = contRaw.indexOf(':');
                if (cColon === -1) {
                    throw new Error(`expected "key: value" continuation on list item at line ${i + 1}, got: ${contRaw}`);
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
function stripQuotes(value) {
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
function coerceScalar(value) {
    if (value === '')
        return '';
    if (value === 'true')
        return true;
    if (value === 'false')
        return false;
    if (ISO_DATETIME_RE.test(value))
        return value; // keep ISO strings as strings
    if (/^-?\d+$/.test(value)) {
        const n = Number(value);
        if (Number.isFinite(n))
            return n;
    }
    if (/^-?\d+\.\d+$/.test(value)) {
        const n = Number(value);
        if (Number.isFinite(n))
            return n;
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
export function renderRubricFrontmatter(rubric) {
    const lines = [];
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
function yamlScalar(value) {
    const needsQuote = value === '' ||
        /^\s|\s$/.test(value) ||
        /[:#"']/.test(value) ||
        /^-/.test(value) ||
        value === 'true' ||
        value === 'false' ||
        /^-?\d+$/.test(value) ||
        /^-?\d+\.\d+$/.test(value) ||
        ISO_DATETIME_RE.test(value);
    if (!needsQuote)
        return value;
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
}
// ─── Plan-slug helper ────────────────────────────────────────────────────
/**
 * Slugify a plan path or freeform identifier into a filesystem-safe slug.
 * Mirrors the slug derivation used by `flywheel_convergence` so the
 * `.pi-flywheel/plans/<slug>/` directory carries the same name across
 * tools.
 *
 * Special case: when the path matches `.pi-flywheel/plans/<slug>/rubric.md`
 * (or .../grading/iteration-N.json), the slug is the parent directory of
 * `rubric.md` / `grading/`, not the trailing filename. This lets callers
 * thread `state.outcomeRubricPath` straight through without losing the
 * slug.
 */
export function planSlugFromIdentifier(planPathOrId) {
    const segments = planPathOrId.split(/[\\/]/);
    // Detect the `.pi-flywheel/plans/<slug>/rubric.md` and
    // `.pi-flywheel/plans/<slug>/grading/iteration-N.json` shapes — slug is
    // the segment immediately after `plans/`.
    const plansIdx = segments.indexOf('plans');
    if (plansIdx !== -1 && segments[plansIdx - 1] === '.pi-flywheel' && segments[plansIdx + 1]) {
        return slugify(segments[plansIdx + 1]);
    }
    const base = segments.pop()?.replace(/\.md$/i, '') ?? planPathOrId;
    return slugify(base);
}
function slugify(value) {
    return value
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
export function renderVerdictTable(verdict) {
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
function escapePipes(value) {
    return value.replace(/\|/g, '\\|');
}
// ─── Rubric-file path helpers ────────────────────────────────────────────
/**
 * Repo-relative path to `.pi-flywheel/plans/<slug>/rubric.md`. Tools
 * persist this string into `state.outcomeRubricPath`; the doctor and
 * Step 0c banner both read it back from there.
 */
export function rubricPathForSlug(slug) {
    return path.join('.pi-flywheel', 'plans', slug, 'rubric.md');
}
/** Sidecar path that records the planContentSha → rubric pairing. */
export function rubricLockPathForSlug(slug) {
    return path.join('.pi-flywheel', 'plans', slug, '.rubric.lock');
}
function sha256Hex(content) {
    return createHash('sha256').update(content).digest('hex');
}
function readRubricLock(absolutePath) {
    try {
        const raw = readFileSync(absolutePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.planContentSha === 'string' &&
            typeof parsed.generatedAt === 'string' &&
            typeof parsed.source === 'string') {
            return parsed;
        }
        return null;
    }
    catch {
        return null;
    }
}
// ─── Synthesizer prompt ──────────────────────────────────────────────────
/**
 * Verbatim synthesizer instruction prefix. Plan content is appended
 * AFTER this preamble — never spliced into a shell command — so any
 * payload in the plan is treated as the LLM's *user message*, not as
 * an exec argument. Documented in T5 spec.
 */
const SYNTHESIZER_PROMPT = `You are an outcome-rubric synthesizer for the agent-flywheel cycle.

Read the plan that follows the \`PLAN START\` marker and produce a rubric of 5–10 testable
criteria. Each criterion must be:

  (a) testable — a future grader could mark it met / unmet / partial by inspecting the diff
  (b) directly attributable to a specific file or behavior change
  (c) under 140 characters in description

Examples of BAD criteria (do not emit):
  - "code is good"
  - "tests pass"
  - "the implementation is correct"

Examples of GOOD criteria (emit shapes like these):
  - "mcp-server/src/outcome-grading.ts exports RubricSchemaV1 and parses round-trips"
  - "flywheel_synthesize_rubric tool is registered in server.ts and writes rubric.md"

Output ONLY YAML frontmatter (no prose, no code fences) wrapped in \`---\` delimiters,
matching this Zod schema EXACTLY:

  version: 1                # literal int 1
  source: auto              # literal string "auto"
  generatedAt: <ISO-8601 datetime>
  planSlug: <kebab-case slug>
  goal: <one line goal>
  engine: <optional model name>
  criteria:                 # 3..15 items
    - id: c1                # /^c\\d+$/
      description: <≥10 chars>
      weight: <optional 0..1 float>
      evidenceHint: <optional file path>

PLAN START`;
/**
 * Inject the engine and timestamp the synthesizer cannot know on its
 * own. Called after the LLM returns to backfill missing-but-required
 * fields before validation, since the LLM is told to emit
 * `generatedAt: <ISO-8601 datetime>` literally and we want a
 * deterministic timestamp for testing.
 */
function backfillRubricFields(raw, override) {
    // Replace placeholder lines if the synthesizer left them.
    let out = raw;
    const replacements = [
        [/^generatedAt:.*$/m, `generatedAt: ${override.generatedAt}`],
        [/^planSlug:.*$/m, `planSlug: ${override.planSlug}`],
        [/^goal:.*$/m, `goal: ${escapeYamlScalar(override.goal)}`],
        [/^source:.*$/m, `source: ${override.source}`],
    ];
    for (const [re, repl] of replacements) {
        if (re.test(out)) {
            out = out.replace(re, repl);
        }
    }
    if (override.engine !== undefined && !/^engine:/m.test(out)) {
        // Append engine line just before the closing `---`.
        out = out.replace(/^---\s*$/m, `engine: ${escapeYamlScalar(override.engine)}\n---`);
    }
    return out;
}
function escapeYamlScalar(value) {
    if (/^[A-Za-z0-9_./-]+$/.test(value))
        return value;
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
const SYNTH_TIMEOUT_MS = Number(process.env.FW_RUBRIC_SYNTH_TIMEOUT_MS ?? 60_000);
/** Default synthesizer — `claude --print --tools read` against a tmp task file. */
export const defaultSynthesizerDriver = async ({ exec, cwd, signal, prompt }) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flywheel-rubric-'));
    const taskFile = path.join(dir, 'task.md');
    writeFileSync(taskFile, prompt, 'utf8');
    try {
        const res = await exec('claude', ['--print', '--tools', 'read', `@${taskFile}`], {
            cwd,
            timeout: SYNTH_TIMEOUT_MS,
            signal,
        });
        if (res.code !== 0) {
            throw new FlywheelError({
                code: 'rubric_synth_invalid',
                message: `claude synthesizer exited ${res.code}`,
                cause: sanitizeCause(res.stderr || `exit ${res.code}`),
            });
        }
        return res.stdout.trim();
    }
    finally {
        try {
            unlinkSync(taskFile);
        }
        catch { /* best-effort */ }
    }
};
// ─── Edit-intent helper ──────────────────────────────────────────────────
/**
 * Apply a deterministic, parser-driven edit to a rubric. Used by
 * `synthesizeRubric` when `action: 'edit'` arrives WITHOUT spawning a
 * fresh LLM round-trip for the simple cases (tighten/add/remove). The
 * `'custom'` kind requires LLM mediation and is delegated to the
 * synthesizer driver in that case.
 */
function applyDeterministicEdit(rubric, intent) {
    switch (intent.kind) {
        case 'tighten': {
            // Append the operator's tightening note to each criterion's
            // description. Keeps the criterion count stable; lets the next
            // synthesis cycle pick up the operator's intent verbatim.
            const note = ` (operator-tighten: ${intent.text})`;
            const newCriteria = rubric.criteria.map((c) => ({
                ...c,
                description: `${c.description}${note}`,
            }));
            return { ...rubric, criteria: newCriteria, source: 'edited' };
        }
        case 'add': {
            const nextId = `c${rubric.criteria.length + 1}`;
            const description = intent.text.length >= 10
                ? intent.text
                : `${intent.text} (operator-added)`;
            return {
                ...rubric,
                source: 'edited',
                criteria: [
                    ...rubric.criteria,
                    { id: nextId, description },
                ],
            };
        }
        case 'remove': {
            // Remove criteria whose id appears in the intent text or whose
            // description contains the intent text (case-insensitive). After
            // removal, renumber so ids stay /^c\d+$/-contiguous.
            const needle = intent.text.trim().toLowerCase();
            const kept = rubric.criteria.filter((c) => {
                if (c.id.toLowerCase() === needle)
                    return false;
                if (c.description.toLowerCase().includes(needle))
                    return false;
                return true;
            });
            const renumbered = kept.map((c, idx) => ({ ...c, id: `c${idx + 1}` }));
            return { ...rubric, source: 'edited', criteria: renumbered };
        }
        case 'custom':
            // Custom edits land via the LLM driver in synthesizeRubric — the
            // caller branches on `intent.kind === 'custom'` before reaching
            // this helper.
            throw new FlywheelError({
                code: 'internal_error',
                message: 'applyDeterministicEdit does not handle custom edits',
            });
    }
}
/**
 * Synthesize, validate, edit, or regenerate the cycle-level outcome rubric.
 *
 * See `SynthesizeRubricArgs.action` doc for the variant contract:
 *   - `'synthesize'` (default): LLM-spawn unless cache hit OR existing
 *     rubric has `source ∈ {'edited','user'}`. `force=true` bypasses both.
 *   - `'validate'`: parse current rubric.md and return; no LLM, no write.
 *   - `'edit'`: deterministic transform for tighten/add/remove; LLM for
 *     custom. Atomic-write only on successful Zod validation.
 *   - `'regenerate'`: explicit override; ignores the edited-source guard.
 *
 * Bead: claude-orchestrator-1s9 (T5).
 */
export async function synthesizeRubric(ctx, args, opts = {}) {
    const { exec, cwd, state, saveState, signal } = ctx;
    const action = args.action ?? 'synthesize';
    const synthesizer = opts.synthesizer ?? defaultSynthesizerDriver;
    const now = opts.now ?? Date.now;
    // ─ action: 'validate' fast-path — does not need a plan file at all.
    // Resolve slug from either args.planSlug or state.outcomeRubricPath.
    if (action === 'validate') {
        const slugV = args.planSlug
            ?? (state.outcomeRubricPath ? planSlugFromIdentifier(state.outcomeRubricPath) : undefined)
            ?? (args.planPath ? planSlugFromIdentifier(args.planPath) : undefined)
            ?? (state.planDocument ? planSlugFromIdentifier(state.planDocument) : undefined);
        if (!slugV) {
            throw new FlywheelError({
                code: 'invalid_input',
                message: 'synthesizeRubric action=validate requires planSlug or state.outcomeRubricPath',
            });
        }
        const rubricRelV = rubricPathForSlug(slugV);
        const rubricAbsV = path.join(cwd, rubricRelV);
        if (!existsSync(rubricAbsV)) {
            throw new FlywheelError({
                code: 'rubric_missing',
                message: `rubric.md not found at ${rubricRelV}`,
            });
        }
        const rubric = parseRubricFrontmatter(readFileSync(rubricAbsV, 'utf8'));
        state.outcomeRubricPath = rubricRelV;
        saveState(state);
        return { rubricPath: rubricRelV, rubric, source: rubric.source };
    }
    // Resolve plan path + slug for synth/edit/regenerate paths.
    const planPath = args.planPath ?? state.planDocument;
    if (!planPath) {
        throw new FlywheelError({
            code: 'invalid_input',
            message: 'synthesizeRubric requires planPath or state.planDocument',
        });
    }
    const planAbs = path.isAbsolute(planPath) ? planPath : path.join(cwd, planPath);
    const slug = args.planSlug ?? planSlugFromIdentifier(planPath);
    const rubricRel = rubricPathForSlug(slug);
    const rubricAbs = path.join(cwd, rubricRel);
    const lockAbs = path.join(cwd, rubricLockPathForSlug(slug));
    // (action: 'validate' is handled in the fast-path above; if we reach
    // here, action is one of 'synthesize' | 'edit' | 'regenerate'.)
    // Read plan content for cache key + LLM input.
    if (!existsSync(planAbs)) {
        throw new FlywheelError({
            code: 'not_found',
            message: `plan file not found at ${planPath}`,
        });
    }
    const planContent = readFileSync(planAbs, 'utf8');
    const planContentSha = sha256Hex(planContent);
    const goal = state.selectedGoal ?? slug;
    const generatedAt = new Date(now()).toISOString();
    // ─ action: 'edit' — operator-driven edit on existing rubric ─
    if (action === 'edit') {
        if (!args.editIntent) {
            throw new FlywheelError({
                code: 'invalid_input',
                message: "synthesizeRubric action='edit' requires editIntent",
            });
        }
        if (!existsSync(rubricAbs)) {
            throw new FlywheelError({
                code: 'rubric_missing',
                message: `cannot edit: rubric.md missing at ${rubricRel}`,
            });
        }
        const current = parseRubricFrontmatter(readFileSync(rubricAbs, 'utf8'));
        let next;
        if (args.editIntent.kind === 'custom') {
            const prompt = `${SYNTHESIZER_PROMPT}\n\n` +
                `Existing rubric (apply this custom edit and re-emit the full frontmatter):\n` +
                `${renderRubricFrontmatter(current)}\n\n` +
                `Custom edit instructions:\n${args.editIntent.text}\n\nPLAN END\n`;
            const raw = await synthesizer({ exec, cwd, signal, prompt });
            const filled = backfillRubricFields(raw, {
                goal,
                planSlug: slug,
                source: 'edited',
                generatedAt,
                engine: current.engine,
            });
            // Validation throws rubric_synth_invalid; on failure we do NOT write
            // the file — the operator returns to the Step 5.6 edit-recovery menu.
            next = parseRubricFrontmatter(filled);
        }
        else {
            next = applyDeterministicEdit(current, args.editIntent);
            next = { ...next, generatedAt };
            // Run the synthesised body through Zod via the parser (write+parse) so
            // any deterministic-edit invariant violation surfaces consistently.
            const rendered = renderRubricFrontmatter(next);
            next = parseRubricFrontmatter(rendered);
        }
        await writeAtomic(rubricAbs, renderRubricFrontmatter(next));
        state.outcomeRubricPath = rubricRel;
        saveState(state);
        return { rubricPath: rubricRel, rubric: next, source: 'edited' };
    }
    // ─ action: 'synthesize' or 'regenerate' ─
    const force = args.force === true || action === 'regenerate';
    if (existsSync(rubricAbs) && !force) {
        const existing = parseRubricFrontmatter(readFileSync(rubricAbs, 'utf8'));
        if (existing.source === 'edited' || existing.source === 'user') {
            // Operator-edits guard — never overwritten without `force=true`.
            state.outcomeRubricPath = rubricRel;
            saveState(state);
            return { rubricPath: rubricRel, rubric: existing, source: 'cached' };
        }
        const lock = readRubricLock(lockAbs);
        if (lock !== null && lock.planContentSha === planContentSha) {
            // Plan content unchanged since the last auto-synth — reuse.
            state.outcomeRubricPath = rubricRel;
            saveState(state);
            return { rubricPath: rubricRel, rubric: existing, source: 'cached' };
        }
    }
    // Spawn synthesizer.
    const prompt = `${SYNTHESIZER_PROMPT}\n${planContent}\nPLAN END\n`;
    let raw;
    try {
        raw = await synthesizer({ exec, cwd, signal, prompt });
    }
    catch (err) {
        if (err instanceof FlywheelError)
            throw err;
        throw new FlywheelError({
            code: 'rubric_synth_invalid',
            message: 'synthesizer driver threw',
            cause: sanitizeCause(errMsg(err)),
        });
    }
    if (!raw || raw.trim() === '') {
        throw new FlywheelError({
            code: 'rubric_synth_invalid',
            message: 'synthesizer returned empty output',
        });
    }
    // Backfill and validate.
    const filled = backfillRubricFields(raw, {
        goal,
        planSlug: slug,
        source: 'auto',
        generatedAt,
    });
    const rubric = parseRubricFrontmatter(filled);
    // Persist atomically + drop the cache lock alongside.
    await writeAtomic(rubricAbs, renderRubricFrontmatter(rubric));
    const lockBody = {
        planContentSha,
        generatedAt,
        source: rubric.source,
    };
    await writeAtomic(lockAbs, `${JSON.stringify(lockBody, null, 2)}\n`);
    state.outcomeRubricPath = rubricRel;
    saveState(state);
    log.info('rubric synthesised', {
        slug,
        criteria: rubric.criteria.length,
        source: rubric.source,
        action,
    });
    return { rubricPath: rubricRel, rubric, source: rubric.source };
}
// ─── gradeOutcome (T6) ───────────────────────────────────────────────────
const GRADER_TIMEOUT_MS_DEFAULT = 120_000;
/**
 * Default codex model passed via `--model` to `codex exec`.
 *
 * Codex CLI accepts gpt-5* on ChatGPT-account auth via `codex exec`, but the
 * codex-companion app-server transport rejects them (doctor check
 * `codex_config_compat`). For the grader path we only use `codex exec`, which
 * is the compatible route — see `isCodexConfigUsableForExec` below for the
 * pre-flight check that catches misconfigured `~/.codex/config.toml`
 * overrides (gpt-5-xhigh etc.) before we spend 30–120s on a doomed call.
 *
 * Override via env: `FW_GRADER_MODEL=gpt-5` or `FW_GRADER_FORCE_CLAUDE=1`.
 */
const FW_GRADER_MODEL_DEFAULT = 'gpt-5.5';
const DIFF_BODY_LIMIT = 30_000;
const TEST_OUTPUT_LIMIT = 10_000;
const HISTORY_FIFO_CAP = 5;
const BLIND_AUDITOR_PREAMBLE = 'You are a blind auditor. You have not seen the implementation conversation. ' +
    'You see only the rubric, the git diff range, and the test output. ' +
    'Return ONLY a JSON object matching GraderVerdictSchemaV1. ' +
    'Do not include prose. If the diff was truncated, note it in `explanation`.';
/**
 * Pre-flight check: does the user's `~/.codex/config.toml` set a top-level
 * `model = ...` override that is known to fail the codex-companion app-server
 * path? Returns `{ usable: false, configuredModel }` when the override is
 * incompatible so the grader driver can skip codex preemptively instead of
 * wasting the grader budget on a doomed `codex exec` call.
 *
 * Pure file read; no exec/network. Mirrors the doctor's `codex_config_compat`
 * check (see `mcp-server/src/tools/doctor.ts:checkCodexConfigCompat`) so a
 * green doctor always implies usable here. Missing file = usable (codex
 * picks its built-in default).
 */
function isCodexConfigUsableForExec() {
    const configPath = path.join(homedir(), '.codex', 'config.toml');
    let content;
    try {
        content = readFileSync(configPath, 'utf8');
    }
    catch {
        return { usable: true };
    }
    const model = parseCodexConfigTopLevelModel(content);
    if (model === null)
        return { usable: true };
    if (isCodexIncompatibleModel(model))
        return { usable: false, configuredModel: model };
    return { usable: true };
}
/**
 * Default grader driver — codex primary (when present and config-compatible),
 * fresh CC fallback.
 *
 * Doctor health is treated as advisory: if `codex` is not on PATH the
 * exec call fails with ENOENT and we fall through to claude. The grader
 * never embeds the impl conversation; only the rubric + diff + tests.
 *
 * When `~/.codex/config.toml` sets an incompatible top-level model (per
 * `isCodexConfigUsableForExec` / doctor `codex_config_compat`), the codex
 * branch is skipped preemptively with a single warn log so the user can fix
 * the override via `flywheel_remediate({ checkName: 'codex_config_compat',
 * mode: 'execute', autoConfirm: true })` — avoids burning the grader
 * timeout on a request the OpenAI API will reject.
 */
export const defaultGraderDriver = async ({ exec, cwd, signal, prompt, preferModel, timeoutMs }) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flywheel-grader-'));
    const taskFile = path.join(dir, 'task.md');
    writeFileSync(taskFile, prompt, 'utf8');
    try {
        if (preferModel === 'codex') {
            const configCheck = isCodexConfigUsableForExec();
            if (!configCheck.usable) {
                log.warn('codex config incompatible — skipping codex grader, falling back to claude', {
                    configuredModel: configCheck.configuredModel,
                    hint: "flywheel_remediate({ checkName: 'codex_config_compat', mode: 'execute', autoConfirm: true }) — or set FW_GRADER_FORCE_CLAUDE=1 to suppress this preemption",
                });
            }
            else {
                try {
                    const model = process.env.FW_GRADER_MODEL ?? FW_GRADER_MODEL_DEFAULT;
                    const res = await exec('codex', ['exec', '--model', model, '--json', `@${taskFile}`], { cwd, timeout: timeoutMs, signal });
                    if (res.code === 0 && res.stdout.trim().length > 0) {
                        return { stdout: res.stdout.trim(), modelUsed: 'codex' };
                    }
                    log.debug('codex grader returned non-zero or empty', { exitCode: res.code, stderrLen: res.stderr.length });
                }
                catch (err) {
                    log.debug('codex grader threw, falling back to claude', { err: errMsg(err) });
                }
            }
        }
        // Fresh-CC fallback — explicit "blind auditor" guarantee in the prompt
        // already; the new claude process inherits no impl-session memory.
        const res = await exec('claude', ['--print', '--tools', 'read', `@${taskFile}`], { cwd, timeout: timeoutMs, signal });
        if (res.code !== 0) {
            throw new FlywheelError({
                code: 'grader_unavailable',
                message: `claude grader exited ${res.code}`,
                cause: sanitizeCause(res.stderr || `exit ${res.code}`),
            });
        }
        return { stdout: res.stdout.trim(), modelUsed: 'claude' };
    }
    finally {
        try {
            unlinkSync(taskFile);
        }
        catch { /* best-effort */ }
    }
};
// In-memory mutex per planSlug to prevent concurrent grader spawns on the
// same cycle (D13). Cleared in the `finally` block after the call settles.
const _graderLocks = new Map();
/**
 * Resolve the cycle-start SHA via the 4-tier fallback ladder (D1):
 *   1. state.cycleStartSha
 *   2. checkpoint.gitHead (passed in via state.cycleStartSha-equivalent fallbacks)
 *   3. git log -n 1 --before=<checkpoint.timestamp> --format=%H
 *   4. git rev-parse HEAD~50
 *
 * The tier that fires is recorded on `verdict.details.cycleStartShaSource`
 * (cycle_start_sha_unset warn-event when tiers 3 or 4 fire).
 *
 * Never defaults to `HEAD` — that would falsely report `satisfied` from
 * an empty diff (Risk R5).
 */
async function resolveCycleStartSha(ctx, beforeIso) {
    const { exec, cwd, state, signal } = ctx;
    if (state.cycleStartSha) {
        return { sha: state.cycleStartSha, source: 'state' };
    }
    if (state.sessionStartSha) {
        return { sha: state.sessionStartSha, source: 'checkpoint' };
    }
    if (beforeIso) {
        try {
            const res = await exec('git', ['log', '-n', '1', `--before=${beforeIso}`, '--format=%H'], { cwd, timeout: 5000, signal });
            const sha = res.stdout.trim();
            if (res.code === 0 && sha.length > 0) {
                log.warn('cycleStartSha recovered via git-log-by-time', { code: 'cycle_start_sha_unset', beforeIso });
                return { sha, source: 'git_log_by_time' };
            }
        }
        catch (err) {
            log.debug('git-log-by-time fallback threw', { err: errMsg(err) });
        }
    }
    try {
        const res = await exec('git', ['rev-parse', 'HEAD~50'], { cwd, timeout: 5000, signal });
        const sha = res.stdout.trim();
        if (res.code === 0 && sha.length > 0) {
            log.warn('cycleStartSha recovered via HEAD~50 fallback', { code: 'cycle_start_sha_unset' });
            return { sha, source: 'fallback_head_minus_50' };
        }
    }
    catch (err) {
        log.debug('HEAD~50 fallback threw', { err: errMsg(err) });
    }
    // All four tiers exhausted — surface as a structured error so the caller
    // can present an actionable hint instead of false `satisfied`.
    throw new FlywheelError({
        code: 'cycle_start_sha_unset',
        message: 'cycleStartSha could not be recovered through any of the 4 fallback tiers',
    });
}
/** Truncate a diff body per the dynamic budget — 15K head + 15K tail + marker. */
function truncateDiffBody(diff) {
    if (diff.length <= DIFF_BODY_LIMIT) {
        return { body: diff, truncated: false };
    }
    const head = diff.slice(0, 15_000);
    const tail = diff.slice(-15_000);
    return {
        body: `${head}\n[TRUNCATED: 30K limit; full file list below]\n${tail}`,
        truncated: true,
    };
}
function truncateTestOutput(raw) {
    if (!raw)
        return { body: undefined, truncated: false };
    if (raw.length <= TEST_OUTPUT_LIMIT) {
        return { body: raw, truncated: false };
    }
    return {
        body: `${raw.slice(0, TEST_OUTPUT_LIMIT)}\n[TRUNCATED: 10K cap]`,
        truncated: true,
    };
}
/** Build the grader prompt body. Pure (no exec); exposed for tests. */
export function buildGraderPrompt(input) {
    const lines = [];
    lines.push(BLIND_AUDITOR_PREAMBLE);
    lines.push('');
    lines.push(`Goal: ${input.goal}`);
    lines.push(`Iteration: ${input.iteration} of cap ${input.cap}`);
    lines.push('');
    lines.push('## Rubric (frontmatter)');
    lines.push(input.rubricFrontmatter);
    lines.push('');
    lines.push('## git log <range> --oneline');
    lines.push('```');
    lines.push(input.gitLog);
    lines.push('```');
    lines.push('');
    lines.push('## git diff <range> --stat');
    lines.push('```');
    lines.push(input.diffStat);
    lines.push('```');
    lines.push('');
    lines.push('## git diff <range> (body)');
    if (input.diffTruncated) {
        lines.push('Note: diff truncated — first 15K + last 15K shown. Flag in your `explanation`.');
    }
    lines.push('```diff');
    lines.push(input.diffBody);
    lines.push('```');
    if (input.testOutput !== undefined) {
        lines.push('');
        lines.push('## Test output (cycleEndTestOutput)');
        if (input.testOutputTruncated) {
            lines.push('Note: test output truncated at 10K.');
        }
        lines.push('```');
        lines.push(input.testOutput);
        lines.push('```');
    }
    lines.push('');
    lines.push('## Required JSON output shape');
    lines.push('```json');
    lines.push(JSON.stringify({
        version: 1,
        status: 'satisfied | needs_revision | max_iterations_reached | failed',
        iteration: input.iteration,
        perCriterion: [
            {
                criterionId: 'c1',
                status: 'met | unmet | partial',
                evidence: 'commit shas / file paths / quoted code',
                gaps: ['gap line 1'],
            },
        ],
        explanation: 'free-text grader summary',
        modelUsed: 'codex | claude',
        durationMs: 0,
        timestamp: '<ISO-8601>',
    }, null, 2));
    lines.push('```');
    return lines.join('\n');
}
/** Try parse-as-JSON, fall back to first-{...}-block extraction. */
function extractJsonObject(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        /* fall through */
    }
    const match = /\{[\s\S]*\}/.exec(raw);
    if (!match) {
        throw new FlywheelError({
            code: 'verdict_invalid',
            message: 'grader stdout did not contain a JSON object',
            cause: sanitizeCause(raw.slice(0, 200)),
        });
    }
    try {
        return JSON.parse(match[0]);
    }
    catch (err) {
        throw new FlywheelError({
            code: 'verdict_invalid',
            message: 'grader JSON object extracted from prose did not parse',
            cause: sanitizeCause(errMsg(err)),
        });
    }
}
/**
 * Grade the cycle outcome with a model strictly decorrelated from the
 * implementation swarm — codex primary, fresh-CC fallback.
 *
 * Bead: claude-orchestrator-2ma (T6).
 */
export async function gradeOutcome(ctx, args, opts = {}) {
    const { exec, cwd, state, saveState, signal } = ctx;
    const grader = opts.grader ?? defaultGraderDriver;
    const now = opts.now ?? Date.now;
    const force = args.force === true;
    // ─ Skip short-circuit (R2 from spec) ─
    if (state.outcomeGradingSkipped === true) {
        return {
            status: 'skipped',
            reason: 'operator-skipped-at-plan-approve',
            iteration: 0,
        };
    }
    if (!state.outcomeRubricPath) {
        throw new FlywheelError({
            code: 'rubric_missing',
            message: 'state.outcomeRubricPath is unset and outcomeGradingSkipped is not true',
        });
    }
    const slug = args.planSlug ?? planSlugFromIdentifier(state.outcomeRubricPath);
    const lockKey = slug;
    if (_graderLocks.has(lockKey) && !force) {
        throw new FlywheelError({
            code: 'concurrent_grade',
            message: `another grader is already in flight for plan slug "${slug}"`,
        });
    }
    _graderLocks.set(lockKey, true);
    try {
        const rubricAbs = path.join(cwd, state.outcomeRubricPath);
        if (!existsSync(rubricAbs)) {
            throw new FlywheelError({
                code: 'rubric_missing',
                message: `rubric.md not found at ${state.outcomeRubricPath}`,
            });
        }
        const rubricRaw = readFileSync(rubricAbs, 'utf8');
        const rubric = parseRubricFrontmatter(rubricRaw);
        const rubricFrontmatter = renderRubricFrontmatter(rubric);
        const cap = getMaxOutcomeIterations(state);
        const iteration = (state.outcomeGradingHistory?.length ?? 0) + 1;
        // Iteration-N.json existence guard (D6).
        const verdictDirRel = path.join('.pi-flywheel', 'plans', slug, 'grading');
        const verdictRel = path.join(verdictDirRel, `iteration-${iteration}.json`);
        const verdictAbs = path.join(cwd, verdictRel);
        if (existsSync(verdictAbs) && !force) {
            throw new FlywheelError({
                code: 'verdict_invalid',
                message: `verdict file already exists at ${verdictRel}`,
                hint: 'Pass force=true to re-grade, or delete the existing file.',
            });
        }
        // Resolve cycleStartSha via the 4-tier ladder.
        const cycleStartShaResult = await resolveCycleStartSha(ctx);
        // Build prompt artifacts.
        const range = `${cycleStartShaResult.sha}..HEAD`;
        let gitLog = '';
        let diffStat = '';
        let diffBody = '';
        try {
            const r = await exec('git', ['log', range, '--oneline'], { cwd, timeout: 8000, signal });
            gitLog = r.stdout.trim();
        }
        catch (err) {
            log.debug('git log failed', { err: errMsg(err) });
        }
        try {
            const r = await exec('git', ['diff', range, '--stat'], { cwd, timeout: 8000, signal });
            diffStat = r.stdout.trim();
        }
        catch (err) {
            log.debug('git diff --stat failed', { err: errMsg(err) });
        }
        try {
            const r = await exec('git', ['diff', range], { cwd, timeout: 15000, signal });
            diffBody = r.stdout;
        }
        catch (err) {
            log.debug('git diff body failed', { err: errMsg(err) });
        }
        const { body: truncatedDiff, truncated: diffTruncated } = truncateDiffBody(diffBody);
        const { body: testOutput, truncated: testOutputTruncated } = truncateTestOutput(state.cycleEndTestOutput);
        const prompt = buildGraderPrompt({
            rubricFrontmatter,
            goal: state.selectedGoal ?? rubric.goal,
            iteration,
            cap,
            gitLog,
            diffStat,
            diffBody: truncatedDiff,
            diffTruncated,
            testOutput,
            testOutputTruncated,
        });
        // Decide preferred grader (codex when configured, else claude).
        const preferModel = process.env.FW_GRADER_FORCE_CLAUDE === '1' ? 'claude' : 'codex';
        const timeoutMs = Number(process.env.FW_GRADER_TIMEOUT_MS ?? GRADER_TIMEOUT_MS_DEFAULT);
        const startWall = now();
        let stdout;
        let modelUsed;
        try {
            const r = await grader({ exec, cwd, signal, prompt, preferModel, timeoutMs });
            stdout = r.stdout;
            modelUsed = r.modelUsed;
        }
        catch (err) {
            if (err instanceof FlywheelError)
                throw err;
            const msg = errMsg(err);
            if (/Timed out after \d+ms/.test(msg)) {
                throw new FlywheelError({
                    code: 'grader_timeout',
                    message: `grader exceeded ${timeoutMs}ms`,
                    cause: sanitizeCause(msg),
                });
            }
            throw new FlywheelError({
                code: 'grader_unavailable',
                message: 'grader driver threw',
                cause: sanitizeCause(msg),
            });
        }
        const durationMs = now() - startWall;
        // Parse + validate. One auto-retry on Zod failure with a verbatim
        // "JSON only" re-prompt (D11).
        let verdictParsed;
        let graderRetried = false;
        try {
            const obj = extractJsonObject(stdout);
            verdictParsed = GraderVerdictSchemaV1.parse(obj);
        }
        catch (firstErr) {
            // One auto-retry.
            graderRetried = true;
            const retryPrompt = 'Your previous output was not valid JSON. Return ONLY the GraderVerdictSchemaV1 ' +
                'JSON object. Do not include prose.\n\n' + prompt;
            let retryStdout;
            try {
                const r = await grader({ exec, cwd, signal, prompt: retryPrompt, preferModel, timeoutMs });
                retryStdout = r.stdout;
                modelUsed = r.modelUsed;
            }
            catch (err) {
                throw new FlywheelError({
                    code: 'verdict_invalid',
                    message: 'grader retry failed after first parse error',
                    cause: sanitizeCause(errMsg(err)),
                });
            }
            try {
                const obj = extractJsonObject(retryStdout);
                verdictParsed = GraderVerdictSchemaV1.parse(obj);
            }
            catch (err) {
                throw new FlywheelError({
                    code: 'verdict_invalid',
                    message: 'grader retry JSON did not parse against GraderVerdictSchemaV1',
                    cause: sanitizeCause(`first=${errMsg(firstErr)} | retry=${errMsg(err)}`),
                });
            }
        }
        // Backfill server-known fields. The grader is told the iteration
        // index but we authoritatively re-set it; modelUsed is what we
        // actually launched.
        const verdict = {
            ...verdictParsed,
            iteration,
            modelUsed,
            durationMs,
            timestamp: new Date(now()).toISOString(),
            details: {
                ...(verdictParsed.details ?? {}),
                cycleStartShaSource: cycleStartShaResult.source,
                diffTruncated,
                testOutputTruncated,
                graderRetried,
                ...(modelUsed === 'claude' && preferModel === 'codex'
                    ? { fallbackReason: 'codex_unavailable' }
                    : {}),
            },
        };
        // Iteration-cap coercion (D7) — server-side; the LLM cannot bypass.
        if (verdict.iteration >= cap && verdict.status === 'needs_revision') {
            verdict.status = 'max_iterations_reached';
        }
        // Atomic write FIRST, then state append (D4, D12). A crash between
        // file-write and saveState leaves a recoverable on-disk record.
        let persistence = 'ok';
        try {
            await writeAtomic(verdictAbs, `${JSON.stringify(verdict, null, 2)}\n`);
        }
        catch (err) {
            const msg = errMsg(err);
            if (/ENOSPC|EROFS|EDQUOT/i.test(msg)) {
                log.warn('verdict persistence failed (disk full / read-only)', { err: msg });
                persistence = 'failed';
                verdict.persistence = 'failed';
            }
            else {
                throw err;
            }
        }
        if (persistence === 'ok') {
            verdict.persistence = 'ok';
        }
        // Append to history with FIFO cap (Tension #4 — last 5 cycles).
        const entry = { iteration, verdict, timestamp: verdict.timestamp };
        const hist = (state.outcomeGradingHistory ?? []).slice();
        hist.push(entry);
        while (hist.length > HISTORY_FIFO_CAP) {
            hist.shift();
        }
        state.outcomeGradingHistory = hist;
        saveState(state);
        log.info('outcome graded', {
            slug,
            iteration,
            status: verdict.status,
            modelUsed,
            durationMs,
        });
        return verdict;
    }
    finally {
        _graderLocks.delete(lockKey);
    }
}
/** Test-only — reset the in-memory grader-mutex map. */
export function _resetGraderMutex() {
    _graderLocks.clear();
}
//# sourceMappingURL=outcome-grading.js.map