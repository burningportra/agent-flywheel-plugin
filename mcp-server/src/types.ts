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
  type: string;     // "task" | "feature" | "bug" etc.
  labels: string[];
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
  label: string;
  summary: string;
  descriptionTemplate: string;
  placeholders: BeadTemplatePlaceholder[];
  acceptanceCriteria: string[];
  filePatterns: string[];
  dependencyHints?: string;
  examples: BeadTemplateExample[];
}

export type ExpandTemplateResult =
  | { success: true; description: string }
  | { success: false; error: string };

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
export type OrchestratorPhase =
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
  | "complete";

export type CoordinationMode = "worktree" | "single-branch";

export interface OrchestratorState {
  phase: OrchestratorPhase;
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
  /** Whether agent-mail session was bootstrapped for this orchestration */
  agentMailSessionActive?: boolean;

  // ─── Bead-centric state (new) ──────────────────────────────
  /** Bead IDs created for this orchestration (ordered). */
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
   * Number of consecutive review rounds where orch_review was called
   * with verdict="pass" and no revision instructions (guide §08 stop condition).
   * Reset to 0 on any fail or revision-instructions round.
   */
  consecutiveCleanRounds?: number;
}

// ─── Checkpoint Persistence ─────────────────────────────────

/** On-disk checkpoint envelope — wraps OrchestratorState with crash-recovery metadata. */
export interface CheckpointEnvelope {
  /** Schema version for forward compatibility. Start at 1. */
  schemaVersion: 1;
  /** ISO timestamp when this checkpoint was written. */
  writtenAt: string;
  /** Orchestrator version that wrote this checkpoint. */
  orchestratorVersion: string;
  /** Git HEAD hash at checkpoint time — detects branch changes between crash and resume. */
  gitHead?: string;
  /** The full orchestrator state snapshot. */
  state: OrchestratorState;
  /** SHA-256 hash of JSON.stringify(state) for integrity validation. */
  stateHash: string;
}

export function createInitialState(): OrchestratorState {
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
  state: OrchestratorState;
  saveState: (state: OrchestratorState) => void;
  clearState: () => void;
}

export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

// ─── Tool Arg Interfaces ──────────────────────────────────────

export interface ProfileArgs { cwd: string; goal?: string }
export interface DiscoverArgs { cwd: string; ideas: CandidateIdea[] }
export interface SelectArgs { cwd: string; goal: string }
export interface PlanArgs { cwd: string; mode?: "standard" | "deep"; planContent?: string; planFile?: string }
export interface ApproveArgs { cwd: string; action: "start" | "polish" | "reject" | "advanced" | "git-diff-review"; advancedAction?: string }
export interface ReviewArgs { cwd: string; beadId: string; action: "hit-me" | "looks-good" | "skip" }
export interface MemoryArgs { cwd: string; query?: string; operation?: "search" | "store"; content?: string }

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
