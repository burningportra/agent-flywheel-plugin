import { z } from 'zod';

// ─── Repo Profile ────────────────────────────────────────────
export interface RepoProfile {
  name: string;
  languages: string[];
  frameworks: string[];
  structure: string; // raw file tree
  entrypoints: string[];
  recentCommits: CommitSummary[];
  hasTests: boolean;
  testFramework?: string;
  hasDocs: boolean;
  hasCI: boolean;
  ciPlatform?: string;
  todos: TodoItem[];
  keyFiles: Record<string, string>;
  readme?: string;
  packageManager?: string;
  /** Content snippets from best-practices guides found in the project. */
  bestPracticesGuides?: Array<{ name: string; content: string }>;
}

// ─── Repository Scan Contract ───────────────────────────────
export type ScanSource = "ccc" | "builtin";

export interface ScanInsight {
  title: string;
  detail: string;
}

export interface ScanQualitySignal {
  label: string;
  value: string;
  detail?: string;
}

export type ScanRecommendationPriority = "low" | "medium" | "high";

export interface ScanRecommendation {
  /** Stable identifier for deduping or provider-specific follow-up. */
  id: string;
  /** Short recommendation title. */
  title: string;
  /** Human-readable detail suitable for prompts or UI. */
  detail: string;
  /** Optional structured payload for downstream routing. */
  payload?: Record<string, unknown>;
  priority?: ScanRecommendationPriority;
}

export interface ScanCodebaseAnalysis {
  /** Short scan summary that can be reused in prompts. */
  summary?: string;
  /** Provider-supplied recommendation inputs for discovery and planning. */
  recommendations: ScanRecommendation[];
  /** Structural findings about architecture, boundaries, or hotspots. */
  structuralInsights: ScanInsight[];
  /** Quality signals attached by a scan provider. */
  qualitySignals: ScanQualitySignal[];
}

export interface ScanErrorInfo {
  code?: string;
  message: string;
  recoverable?: boolean;
}

export interface ScanFallbackInfo {
  /** Whether the requested provider path degraded to the built-in profiler. */
  used: boolean;
  /** Provider family originally attempted. */
  from: ScanSource;
  /** Current fallback target. Step 1 only supports builtin fallback. */
  to: "builtin";
  /** Human-readable explanation for the fallback decision. */
  reason: string;
  /** Optional structured error from the failed provider attempt. */
  error?: ScanErrorInfo;
}

/**
 * Normalized repository scan output.
 *
 * `profile` keeps the existing `RepoProfile` shape so current discovery,
 * planning, and implementation code can continue to work unchanged.
 * Providers can attach additional scan metadata alongside it.
 *
 * In practice, Step 1 callers should usually read this as:
 * `const profile = scanResult.profile`.
 */
export interface ScanSourceMetadata {
  /** Friendly provider label for diagnostics/UI. */
  label?: string;
  /** Provider version or implementation tag when known. */
  version?: string;
  /** Non-fatal warnings emitted during scanning. */
  warnings?: string[];
}

export interface ScanResult {
  /** The provider that actually produced the attached RepoProfile. */
  source: ScanSource;
  /** Stable provider identifier for programmatic checks/logging. */
  provider: string;
  profile: RepoProfile;
  codebaseAnalysis: ScanCodebaseAnalysis;
  sourceMetadata?: ScanSourceMetadata;
  fallback?: ScanFallbackInfo;
}

export interface ScanProvider {
  id: string;
  label: string;
  scan(
    exec: import("./exec.js").ExecFn,
    cwd: string,
    signal?: AbortSignal
  ): Promise<ScanResult>;
}

export interface CommitSummary {
  hash: string;
  message: string;
  date: string;
  author: string;
}

export interface TodoItem {
  file: string;
  line: number;
  text: string;
  type: "TODO" | "FIXME" | "HACK" | "XXX";
}

// ─── bv (beads-viewer) types ─────────────────────────────────

export interface BvBottleneck {
  ID: string;
  Value: number;
}

export interface BvInsights {
  Bottlenecks: BvBottleneck[];
  Cycles: string[][] | null;
  Orphans: string[];
  Articulation: string[];
  Slack: { ID: string; Value: number }[];
}

export interface BvNextPick {
  id: string;
  title: string;
  score: number;
  reasons: string[];
  unblocks: string[];
}

// ─── Beads (br CLI types) ────────────────────────────────────

/** Mirrors br list --json output for a single bead/issue. */
export interface Bead {
  id: string;
  title: string;
  description: string;
  status: "open" | "in_progress" | "closed" | "deferred";
  priority: number; // 0-4
  type?: string;     // "task" | "feature" | "bug" etc. (optional: br v0.1.x uses issue_type)
  issue_type?: string; // br v0.1.x field name for type
  labels?: string[];
  estimate?: number; // minutes
  /** Parent bead ID (from --parent flag). */
  parent?: string;
  /** ISO timestamp when bead was created. */
  created_at?: string;
  /** ISO timestamp when bead was last updated. */
  updated_at?: string;
  /** ISO timestamp when bead was closed (if closed). */
  closed_at?: string;
}

export interface BeadResult {
  beadId: string;
  status: "success" | "partial" | "blocked";
  summary: string;
}

export type OpeningCeremonyMode = "animated" | "static" | "skip";

export interface OpeningCeremonyFrame {
  text: string;
  delayMs: number;
}

export interface OpeningCeremonyWriter {
  write(text: string): void | Promise<void>;
}

export interface OpeningCeremonyRuntime {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface OpeningCeremonyOptions {
  enabled?: boolean;
  interactive?: boolean;
  reducedMotion?: boolean;
  quiet?: boolean;
  terminalWidth?: number;
  maxDurationMs?: number;
  runtime?: OpeningCeremonyRuntime;
}

export interface OpeningCeremonyResult {
  rendered: boolean;
  mode: OpeningCeremonyMode;
  frameCount: number;
  durationMs: number;
  error?: string;
}

export interface BeadReview {
  beadId: string;
  passed: boolean;
  feedback: string;
  revisionInstructions?: string;
}

/**
 * Estimated effort for a bead, used by the calibration system.
 * @since v3.7.0
 */
export const EFFORT_LEVELS = ['S', 'M', 'L', 'XL'] as const;
export type EstimatedEffort = (typeof EFFORT_LEVELS)[number];

/**
 * Mapping from effort tier to expected minutes-of-work.
 * @since v3.7.0
 */
export const EFFORT_TO_MINUTES: Record<EstimatedEffort, number> = {
  S: 30,
  M: 90,
  L: 240,
  XL: 720,
};

export interface BeadTemplatePlaceholder {
  name: string;
  description: string;
  example: string;
  required: boolean;
}

export interface BeadTemplateExample {
  description: string;
}

export interface BeadTemplate {
  id: string;
  /**
   * Schema version for this template. Pinned at creation time so plans
   * synthesised against an older template shape continue to expand even when
   * newer versions are added. Defaults to 1 for legacy templates.
   */
  version: number;
  label: string;
  summary: string;
  descriptionTemplate: string;
  placeholders: BeadTemplatePlaceholder[];
  acceptanceCriteria: string[];
  filePatterns: string[];
  dependencyHints?: string;
  examples: BeadTemplateExample[];
  /** @since v3.7.0 */
  estimatedEffort?: EstimatedEffort;
}

/**
 * Structured input passed to `expandTemplate`. Every well-known key is
 * optional here so callers can supply only what the synthesiser produced;
 * the `expandTemplate` implementation validates that all `required: true`
 * placeholders of the resolved template are present.
 *
 * Extra keys (via index signature) are tolerated so templates may declare
 * their own domain-specific placeholders (e.g. `PARENT_WAVE_BEADS`,
 * `TARGET_FILE`) without forcing the caller to stretch this interface.
 */
export interface TemplateExpansionInput {
  title?: string;
  scope?: string;
  acceptance?: string;
  test_plan?: string;
  [key: string]: string | undefined;
}

/**
 * Discriminated result from `expandTemplate`.
 *
 * On success: the fully rendered markdown body.
 *
 * On failure: one of the v3.4.0 FlywheelErrorCode values used to route
 * MCP-boundary error envelopes. `detail` carries human-readable context
 * (missing placeholder names, unknown template id, etc.) for hint rendering
 * at the tool boundary.
 */
export type ExpandTemplateResult =
  | { success: true; description: string }
  | {
      success: false;
      error:
        | "template_not_found"
        | "template_placeholder_missing"
        | "template_expansion_failed";
      detail: string;
    };

// ─── Discovery ───────────────────────────────────────────────
export interface IdeaScores {
  useful: number;     // 1-5: solves a real, frequent pain
  pragmatic: number;  // 1-5: realistic to build in hours/days
  accretive: number;  // 1-5: clearly adds value beyond what exists
  robust: number;     // 1-5: handles edge cases, works reliably
  ergonomic: number;  // 1-5: reduces friction or cognitive load
}

export interface CandidateIdea {
  id: string;
  title: string;
  description: string;
  category: IdeaCategory;
  effort: "low" | "medium" | "high";
  impact: "low" | "medium" | "high";
  /** Why this idea beat other candidates — specific repo evidence and reasoning. */
  rationale: string;
  /** "top" = top 5 picks, "honorable" = next 5-10 worth considering. */
  tier: "top" | "honorable";
  /** What repo signals support this idea. */
  sourceEvidence?: string[];
  /** Known downsides or unknowns. */
  risks?: string[];
  /** IDs of other ideas this complements. */
  synergies?: string[];
  /** Rubric scores (1-5 per axis). */
  scores?: IdeaScores;
}

export type IdeaCategory =
  | "feature"
  | "refactor"
  | "docs"
  | "dx"
  | "performance"
  | "reliability"
  | "security"
  | "testing";

// ─── Session State ───────────────────────────────────────────
export type FlywheelPhase =
  | "idle"
  | "profiling"
  | "discovering"
  | "awaiting_selection"
  | "planning"
  | "researching"
  | "awaiting_plan_approval"
  | "creating_beads"
  | "refining_beads"
  | "awaiting_bead_approval"
  | "implementing"
  | "reviewing"
  | "iterating"
  | "complete"
  | "doctor";

export type CoordinationMode = "worktree" | "single-branch";

export interface FlywheelState {
  phase: FlywheelPhase;
  repoProfile?: RepoProfile;
  scanResult?: ScanResult;
  candidateIdeas?: CandidateIdea[];
  selectedGoal?: string;
  constraints: string[];
  retryCount: number;
  maxRetries: number;
  maxReviewPasses: number;
  iterationRound: number;
  /** Index into the guided gates array — tracks which gate to show next */
  currentGateIndex: number;
  worktreePoolState?: {
    repoRoot: string;
    baseBranch: string;
    worktrees: { path: string; branch: string; stepIndex: number }[];
  };
  sophiaCRId?: number;
  sophiaCRBranch?: string;
  sophiaCRTitle?: string;

  // ─── Coordination backend state ────────────────────────────
  /** Detected coordination backends (beads, agentMail, sophia) */
  coordinationBackend?: import("./coordination.js").CoordinationBackend;
  /** Selected coordination strategy based on available backends */
  coordinationStrategy?: import("./coordination.js").CoordinationStrategy;
  /** Coordination mode: worktree isolation vs single-branch */
  coordinationMode?: CoordinationMode;
  /** Whether agent-mail session was bootstrapped for this flywheel run */
  agentMailSessionActive?: boolean;

  // ─── Bead-centric state (new) ──────────────────────────────
  /** Bead IDs created for this flywheel run (ordered). */
  activeBeadIds?: string[];
  /** Results keyed by bead ID. */
  beadResults?: Record<string, BeadResult>;
  /** Review verdicts keyed by bead ID. */
  beadReviews?: Record<string, BeadReview[]>;
  /** Currently executing bead ID. */
  currentBeadId?: string | null;
  /** Hit-me triggered per bead ID. */
  beadHitMeTriggered?: Record<string, boolean>;
  /** Hit-me completed per bead ID. */
  beadHitMeCompleted?: Record<string, boolean>;
  /** Review pass counts per bead ID. */
  beadReviewPassCounts?: Record<string, number>;

  // ─── Polish loop state ─────────────────────────────────────
  /** Current polish round (0-indexed). */
  polishRound: number;
  /** Change count per round (beads added, removed, or modified). */
  polishChanges: number[];
  /** True when 0 changes detected for 2 consecutive rounds. */
  polishConverged: boolean;
  /** Output size (chars) per refinement round for convergence tracking. */
  polishOutputSizes?: number[];
  /** Convergence score (0-1) computed after 3+ rounds. */
  polishConvergenceScore?: number;
  /** Number of completed beads since last drift check. */
  beadsSinceLastDriftCheck?: number;
  /** How often to auto-trigger drift checks (every N completed beads, default 3). */
  driftCheckInterval?: number;

  // ─── Auto-approve config ───────────────────────────────────
  /** Auto-approve beads when convergence >= 0.90 or polishConverged is true (default: true). */
  autoApproveOnConvergence?: boolean;

  // ─── Plan document state ───────────────────────────────────
  /** Path to generated plan artifact. */
  planDocument?: string;
  /** Current plan refinement round. */
  planRefinementRound?: number;
  /** Plan convergence score (0-1). */
  planConvergenceScore?: number;
  /** Plan quality readiness score from the Plan Quality Oracle. */
  planReadinessScore?: unknown;

  // ─── Research pipeline state ───────────────────────────────
  /**
   * Persisted across phases so a session restart can resume from the last
   * completed phase rather than rerunning the full 7-phase pipeline.
   */
  researchState?: {
    /** GitHub URL being studied. */
    url: string;
    /** Short name extracted from the URL (e.g. "myrepo"). */
    externalName: string;
    /** Session-relative artifact path for the proposal markdown. */
    artifactName: string;
    /** Ordered list of phase names that have already completed. */
    phasesCompleted: string[];
  };

  // ─── Ideation funnel state ─────────────────────────────────
  /** Raw ideas from broad ideation (phase 1 of 30→5→15 funnel). */
  funnelRawIdeas?: CandidateIdea[];
  /** Winnowed top ideas (phase 2 of funnel). */
  funnelWinnowedIds?: string[];
  /** Foregone conclusion score — composite readiness assessment. */
  foregoneScore?: unknown;

  /** Timestamp (ms) when the current phase started — used for phase duration display. */
  phaseStartedAt?: number;

  // ─── Review clean-round tracking ──────────────────────────
  /**
   * Number of consecutive review rounds where flywheel_review was called
   * with verdict="pass" and no revision instructions (guide §08 stop condition).
   * Reset to 0 on any fail or revision-instructions round.
   */
  consecutiveCleanRounds?: number;

  // ─── v3.4.0 additions — telemetry + post-mortem reconstruction ──
  /**
   * Populated at session end with error-code frequency + recent events.
   * Persisted through checkpoint for post-session analysis. Optional for
   * backward-compatibility with v3.3.0 checkpoints.
   */
  errorCodeTelemetry?: ErrorCodeTelemetry;

  /**
   * Git SHA captured at session start. Used by post-mortem reconstruction
   * to compute the diff boundary without consulting reflog. Optional for
   * backward-compatibility with v3.3.0 checkpoints.
   */
  sessionStartSha?: string;
}

// ─── Checkpoint Persistence ─────────────────────────────────

/** On-disk checkpoint envelope — wraps FlywheelState with crash-recovery metadata. */
export interface CheckpointEnvelope {
  /** Schema version for forward compatibility. Start at 1. */
  schemaVersion: 1;
  /** ISO timestamp when this checkpoint was written. */
  writtenAt: string;
  /** Flywheel version that wrote this checkpoint. */
  flywheelVersion: string;
  /** Git HEAD hash at checkpoint time — detects branch changes between crash and resume. */
  gitHead?: string;
  /** The full flywheel state snapshot. */
  state: FlywheelState;
  /** SHA-256 hash of JSON.stringify(state) for integrity validation. */
  stateHash: string;
}

export function createInitialState(): FlywheelState {
  return {
    phase: "idle",
    constraints: [],
    retryCount: 0,
    maxRetries: 3,
    maxReviewPasses: 2,
    iterationRound: 0,
    currentGateIndex: 0,
    polishRound: 0,
    polishChanges: [],
    polishConverged: false,
  };
}

// ─── MCP Tool Context ─────────────────────────────────────────

export type { ExecFn } from './exec.js';

export interface ToolContext {
  exec: import('./exec.js').ExecFn;
  cwd: string;
  state: FlywheelState;
  saveState: (state: FlywheelState) => Promise<boolean> | void;
  clearState: () => void;
  signal?: AbortSignal;
}

export type FlywheelToolName =
  | 'flywheel_profile'
  | 'flywheel_discover'
  | 'flywheel_select'
  | 'flywheel_plan'
  | 'flywheel_approve_beads'
  | 'flywheel_review'
  | 'flywheel_verify_beads'
  | 'flywheel_advance_wave'
  | 'flywheel_memory'
  | 'flywheel_doctor'
  | 'flywheel_get_skill'
  // Deprecated orch_* aliases — kept for back-compat, removed in v4.0.
  | 'orch_profile'
  | 'orch_discover'
  | 'orch_select'
  | 'orch_plan'
  | 'orch_approve_beads'
  | 'orch_review'
  | 'orch_verify_beads'
  | 'orch_advance_wave'
  | 'orch_memory'
  | 'orch_get_skill';

export interface ToolChoiceOption {
  id: string;
  label: string;
  description?: string;
  tool?: FlywheelToolName;
  args?: Record<string, unknown>;
}

export interface ToolNextStep {
  type: 'call_tool' | 'present_choices' | 'generate_artifact' | 'spawn_agents' | 'run_cli' | 'resume_phase' | 'none';
  message: string;
  tool?: FlywheelToolName;
  argsSchemaHint?: Record<string, unknown>;
  options?: ToolChoiceOption[];
}

export type { FlywheelErrorCode, FlywheelToolError, FlywheelStructuredError } from './errors.js';
export { FLYWHEEL_ERROR_CODES, FlywheelStructuredErrorSchema } from './errors.js';

export type McpToolResult<TStructured = unknown> = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: TStructured;
  isError?: boolean;
};

// ─── Tool Arg Interfaces ──────────────────────────────────────

export interface ProfileArgs { cwd: string; goal?: string; force?: boolean }
export interface DiscoverArgs { cwd: string; ideas: CandidateIdea[] }
export interface SelectArgs { cwd: string; goal: string }
export interface PlanArgs { cwd: string; mode?: "standard" | "deep"; planContent?: string; planFile?: string }
export interface ApproveArgs { cwd: string; action: "start" | "polish" | "reject" | "advanced" | "git-diff-review"; advancedAction?: string }
/**
 * Review modes (bead agent-flywheel-plugin-f0j): dispatch the same reviewer
 * personas into four human-shaped workflows. The flag propagates into the
 * reviewer agent prompts via `runReview` so reviewer tone/output matches the
 * chosen mode — no new MCP tools, no new reviewer agents.
 *
 *   - "interactive"  — current default; AskUserQuestion per finding
 *   - "autofix"      — reviewers emit diffs + commit; gated behind green
 *                      doctor + clean `git status` (falls back to interactive)
 *   - "report-only"  — reviewers write docs/reviews/<date>.md and exit
 *   - "headless"     — CI-friendly exit-code signal per error count
 */
export type ReviewMode = "autofix" | "report-only" | "headless" | "interactive";

export interface ReviewArgs {
  cwd: string;
  beadId: string;
  action: "hit-me" | "looks-good" | "skip";
  /** Review-mode matrix (default "interactive"). */
  mode?: ReviewMode;
  /** Hint that reviewers can run in parallel without stepping on each other. */
  parallelSafe?: boolean;
}
export interface VerifyBeadsArgs { cwd: string; beadIds: string[] }
export interface AdvanceWaveArgs { cwd: string; closedBeadIds: string[]; maxNextWave?: number }
export interface MemoryArgs {
  cwd: string;
  query?: string;
  operation?: "search" | "store" | "draft_postmortem" | "draft_solution_doc" | "refresh_learnings";
  content?: string;
  /** CASS entry id for the paired post-mortem. Required when operation="draft_solution_doc". */
  entryId?: string;
  /**
   * Optional override for the docs/solutions/ root scanned by
   * operation="refresh_learnings". Defaults to `<cwd>/docs/solutions`.
   */
  refreshRoot?: string;
}
export interface DoctorArgs { cwd: string }

// ─── Orchestrator Context (shared runtime for extracted modules) ──

export interface HitMeResult {
  text: string;
  diff: string;
}

// ─── Agent Mail RPC Result ────────────────────────────────────

export type AgentMailResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AgentMailError };

export interface AgentMailError {
  kind: "network" | "timeout" | "parse" | "rpc_error" | "empty_response";
  message: string;
  code?: number;
  stderr?: string;
}

// ─── v3.4.0 Shared Contracts (doctor / hotspot / postmortem / template / telemetry) ──

export const DoctorCheckSeveritySchema = z.enum(['green', 'yellow', 'red']);
export type DoctorCheckSeverity = z.infer<typeof DoctorCheckSeveritySchema>;

export const DoctorCheckSchema = z.object({
  name: z.string(),
  severity: DoctorCheckSeveritySchema,
  message: z.string(),
  hint: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;

export const DoctorReportSchema = z.object({
  version: z.literal(1),
  cwd: z.string(),
  overall: DoctorCheckSeveritySchema,
  partial: z.boolean().default(false),
  checks: z.array(DoctorCheckSchema),
  elapsedMs: z.number().int().nonnegative(),
  timestamp: z.string(),
});
export type DoctorReport = z.infer<typeof DoctorReportSchema>;

export const HotspotSeveritySchema = z.enum(['low', 'med', 'high']);
export type HotspotSeverity = z.infer<typeof HotspotSeveritySchema>;

export const HotspotRowSchema = z.object({
  file: z.string(),
  beadIds: z.array(z.string()),
  contentionCount: z.number().int().nonnegative(),
  severity: HotspotSeveritySchema,
  provenance: z.enum(['files-section', 'prose']),
});
export type HotspotRow = z.infer<typeof HotspotRowSchema>;

export const HotspotMatrixSchema = z.object({
  version: z.literal(1),
  // Bounded to prevent DoS from attacker-crafted plans with thousands of fake rows.
  // Real waves top out at ~20 contested files; 500 is an order-of-magnitude headroom.
  rows: z.array(HotspotRowSchema).max(500),
  maxContention: z.number().int().nonnegative(),
  recommendation: z.enum(['swarm', 'coordinator-serial']),
  summaryOnly: z.boolean().default(false),
});
export type HotspotMatrix = z.infer<typeof HotspotMatrixSchema>;

export const PostmortemDraftSchema = z.object({
  version: z.literal(1),
  sessionStartSha: z.string().optional(),
  goal: z.string(),
  phase: z.string(),
  // Bound the markdown payload to prevent an unbounded-growth DoS where a
  // pathological post-mortem (e.g., huge concatenated stderr or commit-message
  // dumps) could inflate cross-process messages, logs, or the memory store.
  // 200_000 chars ~ 200KB UTF-8 worst case; real post-mortems are <10KB.
  markdown: z.string().max(200_000),
  hasWarnings: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
});
export type PostmortemDraft = z.infer<typeof PostmortemDraftSchema>;

/**
 * v3.4.1 note: `BeadTemplateContractSchema` / `BeadTemplateContract` was
 * declared here during v3.4.0 as a planned MCP-boundary contract but never
 * wired to any `.parse()` call site. It was deleted per the v3.4.0 release
 * gate's P1-5 finding — dead export-only code should not linger in the public
 * surface. If a future MCP tool needs a wire-friendly template contract,
 * reintroduce the schema beside the handler that actually validates it so
 * the declaration, parse site, and tests ship together.
 *
 * The in-process `BeadTemplate` interface above (richer, with placeholder
 * metadata) remains the canonical shape for `bead-templates.ts` consumers.
 */

/**
 * Error-code telemetry. Keys of `counts` and the `code` field of each
 * `recentEvents` entry SHOULD be `FlywheelErrorCode` values, but the schema
 * accepts any string to stay forward-compatible with newer sessions that may
 * have added codes we don't yet know about. The write path (in `telemetry.ts`,
 * landed in I7) MUST validate the key is a known `FlywheelErrorCode` before
 * incrementing; the read path tolerates unknown keys so checkpoints from
 * future versions don't fail to load.
 */
export const ErrorCodeTelemetrySchema = z.object({
  version: z.literal(1),
  sessionStartIso: z.string(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  recentEvents: z.array(z.object({
    code: z.string(),
    ts: z.string(),
    ctxHash: z.string().optional(),
  })),
});
export type ErrorCodeTelemetry = z.infer<typeof ErrorCodeTelemetrySchema>;
