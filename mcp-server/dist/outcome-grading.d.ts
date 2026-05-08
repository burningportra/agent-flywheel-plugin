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
import type { ToolContext, FlywheelState, ExecFn } from './types.js';
/** Pinned forever within the v1 generation. See module header for the v2 ladder. */
export declare const RUBRIC_SCHEMA_VERSION: 1;
/** Pinned forever within the v1 generation. See module header for the v2 ladder. */
export declare const GRADER_VERDICT_SCHEMA_VERSION: 1;
/** Lower bound for `state.maxOutcomeIterations`. */
export declare const MIN_OUTCOME_ITERATIONS = 1;
/** Upper bound for `state.maxOutcomeIterations`. Matches MA's `max_iterations` default ceiling. */
export declare const MAX_OUTCOME_ITERATIONS = 5;
/** Fallback when `state.maxOutcomeIterations` is unset. Matches MA's documented default. */
export declare const DEFAULT_OUTCOME_ITERATIONS = 3;
/**
 * Read the active iteration cap from session state, clamped to
 * `[MIN_OUTCOME_ITERATIONS, MAX_OUTCOME_ITERATIONS]`. Operators may set
 * `FW_MAX_OUTCOME_ITERATIONS` env to seed a different default at the call
 * site that writes to state (caller's responsibility).
 */
export declare function getMaxOutcomeIterations(state: Pick<FlywheelState, 'maxOutcomeIterations'>): number;
declare const RubricCriterionSchemaV1: z.ZodObject<{
    id: z.ZodString;
    description: z.ZodString;
    weight: z.ZodOptional<z.ZodNumber>;
    evidenceHint: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const RubricSchemaV1: z.ZodObject<{
    version: z.ZodLiteral<1>;
    source: z.ZodEnum<{
        auto: "auto";
        user: "user";
        edited: "edited";
    }>;
    generatedAt: z.ZodString;
    planSlug: z.ZodString;
    goal: z.ZodString;
    engine: z.ZodOptional<z.ZodString>;
    criteria: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        description: z.ZodString;
        weight: z.ZodOptional<z.ZodNumber>;
        evidenceHint: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type Rubric = z.infer<typeof RubricSchemaV1>;
export type RubricCriterion = z.infer<typeof RubricCriterionSchemaV1>;
export declare const PerCriterionVerdictSchema: z.ZodObject<{
    criterionId: z.ZodString;
    status: z.ZodEnum<{
        partial: "partial";
        met: "met";
        unmet: "unmet";
    }>;
    evidence: z.ZodString;
    gaps: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
export type PerCriterionVerdict = z.infer<typeof PerCriterionVerdictSchema>;
export declare const GraderVerdictSchemaV1: z.ZodObject<{
    version: z.ZodLiteral<1>;
    status: z.ZodEnum<{
        satisfied: "satisfied";
        needs_revision: "needs_revision";
        max_iterations_reached: "max_iterations_reached";
        failed: "failed";
    }>;
    iteration: z.ZodNumber;
    perCriterion: z.ZodArray<z.ZodObject<{
        criterionId: z.ZodString;
        status: z.ZodEnum<{
            partial: "partial";
            met: "met";
            unmet: "unmet";
        }>;
        evidence: z.ZodString;
        gaps: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
    explanation: z.ZodString;
    modelUsed: z.ZodEnum<{
        codex: "codex";
        claude: "claude";
    }>;
    durationMs: z.ZodNumber;
    timestamp: z.ZodString;
    details: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    persistence: z.ZodOptional<z.ZodEnum<{
        ok: "ok";
        failed: "failed";
    }>>;
}, z.core.$strip>;
export type GraderVerdict = z.infer<typeof GraderVerdictSchemaV1>;
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
export declare function isGradeSkipped(result: GraderVerdict | GradeSkippedSentinel): result is GradeSkippedSentinel;
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
export declare function parseRubricFrontmatter(raw: string): Rubric;
/**
 * Render a {@link Rubric} object as a YAML frontmatter string suitable for
 * embedding in `rubric.md`. Inverse of `parseRubricFrontmatter`. The
 * round-trip `parse → render → parse` is required to be deepEqual; tests
 * enforce this.
 */
export declare function renderRubricFrontmatter(rubric: Rubric): string;
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
export declare function planSlugFromIdentifier(planPathOrId: string): string;
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
export declare function renderVerdictTable(verdict: GraderVerdict): string;
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
 * Repo-relative path to `.pi-flywheel/plans/<slug>/rubric.md`. Tools
 * persist this string into `state.outcomeRubricPath`; the doctor and
 * Step 0c banner both read it back from there.
 */
export declare function rubricPathForSlug(slug: string): string;
/** Sidecar path that records the planContentSha → rubric pairing. */
export declare function rubricLockPathForSlug(slug: string): string;
/**
 * Pluggable synthesizer driver. Default invokes `claude --print` against
 * a tmp task-file, mirroring the pattern in `deep-plan.ts`. Tests inject
 * their own driver via the `synthesizer` arg on `synthesizeRubric` so
 * the LLM call is fully mockable.
 */
export type SynthesizerDriver = (input: {
    exec: ExecFn;
    cwd: string;
    signal?: AbortSignal;
    prompt: string;
}) => Promise<string>;
/** Default synthesizer — `claude --print --tools read` against a tmp task file. */
export declare const defaultSynthesizerDriver: SynthesizerDriver;
export interface SynthesizeRubricOptions {
    /** Test-only injection point. Defaults to `defaultSynthesizerDriver`. */
    synthesizer?: SynthesizerDriver;
    /** Test-only clock. Defaults to `Date.now`. */
    now?: () => number;
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
export declare function synthesizeRubric(ctx: ToolContext, args: SynthesizeRubricArgs, opts?: SynthesizeRubricOptions): Promise<SynthesizeRubricResult>;
export interface GradeOutcomeArgs {
    cwd: string;
    planSlug?: string;
    /** Bypass the `iteration-<N>.json`-exists guard and the in-memory mutex. */
    force?: boolean;
}
/**
 * Pluggable grader driver. The default invokes `codex exec` (or the
 * fresh-CC fallback) and returns the raw stdout for Zod parsing. Tests
 * inject a mock driver that returns a canned JSON string.
 */
export type GraderDriver = (input: {
    exec: ExecFn;
    cwd: string;
    signal?: AbortSignal;
    prompt: string;
    preferModel: 'codex' | 'claude';
    timeoutMs: number;
}) => Promise<{
    stdout: string;
    modelUsed: 'codex' | 'claude';
}>;
/**
 * Default grader driver — codex primary (when present), fresh CC fallback.
 *
 * Doctor health is treated as advisory: if `codex` is not on PATH the
 * exec call fails with ENOENT and we fall through to claude. The grader
 * never embeds the impl conversation; only the rubric + diff + tests.
 */
export declare const defaultGraderDriver: GraderDriver;
/** Build the grader prompt body. Pure (no exec); exposed for tests. */
export declare function buildGraderPrompt(input: {
    rubricFrontmatter: string;
    goal: string;
    iteration: number;
    cap: number;
    gitLog: string;
    diffStat: string;
    diffBody: string;
    diffTruncated: boolean;
    testOutput: string | undefined;
    testOutputTruncated: boolean;
}): string;
export interface GradeOutcomeOptions {
    /** Test-only injection point. Defaults to `defaultGraderDriver`. */
    grader?: GraderDriver;
    /** Test-only clock. Defaults to `Date.now`. */
    now?: () => number;
}
/**
 * Grade the cycle outcome with a model strictly decorrelated from the
 * implementation swarm — codex primary, fresh-CC fallback.
 *
 * Bead: claude-orchestrator-2ma (T6).
 */
export declare function gradeOutcome(ctx: ToolContext, args: GradeOutcomeArgs, opts?: GradeOutcomeOptions): Promise<GraderVerdict | GradeSkippedSentinel>;
/** Test-only — reset the in-memory grader-mutex map. */
export declare function _resetGraderMutex(): void;
export {};
//# sourceMappingURL=outcome-grading.d.ts.map