import { z } from 'zod';
export interface RepoProfile {
    name: string;
    languages: string[];
    frameworks: string[];
    structure: string;
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
    bestPracticesGuides?: Array<{
        name: string;
        content: string;
    }>;
}
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
    scan(exec: import("./exec.js").ExecFn, cwd: string, signal?: AbortSignal): Promise<ScanResult>;
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
export interface BvBottleneck {
    ID: string;
    Value: number;
}
export interface BvInsights {
    Bottlenecks: BvBottleneck[];
    Cycles: string[][] | null;
    Orphans: string[];
    Articulation: string[];
    Slack: {
        ID: string;
        Value: number;
    }[];
}
export interface BvNextPick {
    id: string;
    title: string;
    score: number;
    reasons: string[];
    unblocks: string[];
}
/** Mirrors br list --json output for a single bead/issue. */
export interface Bead {
    id: string;
    title: string;
    description: string;
    status: "open" | "in_progress" | "closed" | "deferred";
    priority: number;
    type?: string;
    issue_type?: string;
    labels?: string[];
    estimate?: number;
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
export type ExpandTemplateResult = {
    success: true;
    description: string;
} | {
    success: false;
    error: string;
};
export interface IdeaScores {
    useful: number;
    pragmatic: number;
    accretive: number;
    robust: number;
    ergonomic: number;
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
export type IdeaCategory = "feature" | "refactor" | "docs" | "dx" | "performance" | "reliability" | "security" | "testing";
export type FlywheelPhase = "idle" | "profiling" | "discovering" | "awaiting_selection" | "planning" | "researching" | "awaiting_plan_approval" | "creating_beads" | "refining_beads" | "awaiting_bead_approval" | "implementing" | "reviewing" | "iterating" | "complete";
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
        worktrees: {
            path: string;
            branch: string;
            stepIndex: number;
        }[];
    };
    sophiaCRId?: number;
    sophiaCRBranch?: string;
    sophiaCRTitle?: string;
    /** Detected coordination backends (beads, agentMail, sophia) */
    coordinationBackend?: import("./coordination.js").CoordinationBackend;
    /** Selected coordination strategy based on available backends */
    coordinationStrategy?: import("./coordination.js").CoordinationStrategy;
    /** Coordination mode: worktree isolation vs single-branch */
    coordinationMode?: CoordinationMode;
    /** Whether agent-mail session was bootstrapped for this flywheel run */
    agentMailSessionActive?: boolean;
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
    /** Auto-approve beads when convergence >= 0.90 or polishConverged is true (default: true). */
    autoApproveOnConvergence?: boolean;
    /** Path to generated plan artifact. */
    planDocument?: string;
    /** Current plan refinement round. */
    planRefinementRound?: number;
    /** Plan convergence score (0-1). */
    planConvergenceScore?: number;
    /** Plan quality readiness score from the Plan Quality Oracle. */
    planReadinessScore?: unknown;
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
    /** Raw ideas from broad ideation (phase 1 of 30→5→15 funnel). */
    funnelRawIdeas?: CandidateIdea[];
    /** Winnowed top ideas (phase 2 of funnel). */
    funnelWinnowedIds?: string[];
    /** Foregone conclusion score — composite readiness assessment. */
    foregoneScore?: unknown;
    /** Timestamp (ms) when the current phase started — used for phase duration display. */
    phaseStartedAt?: number;
    /**
     * Number of consecutive review rounds where flywheel_review was called
     * with verdict="pass" and no revision instructions (guide §08 stop condition).
     * Reset to 0 on any fail or revision-instructions round.
     */
    consecutiveCleanRounds?: number;
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
export declare function createInitialState(): FlywheelState;
export type { ExecFn } from './exec.js';
export interface ToolContext {
    exec: import('./exec.js').ExecFn;
    cwd: string;
    state: FlywheelState;
    saveState: (state: FlywheelState) => Promise<boolean> | void;
    clearState: () => void;
    signal?: AbortSignal;
}
export type FlywheelToolName = 'flywheel_profile' | 'flywheel_discover' | 'flywheel_select' | 'flywheel_plan' | 'flywheel_approve_beads' | 'flywheel_review' | 'flywheel_verify_beads' | 'flywheel_memory' | 'orch_profile' | 'orch_discover' | 'orch_select' | 'orch_plan' | 'orch_approve_beads' | 'orch_review' | 'orch_verify_beads' | 'orch_memory';
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
    content: Array<{
        type: "text";
        text: string;
    }>;
    structuredContent?: TStructured;
    isError?: boolean;
};
export interface ProfileArgs {
    cwd: string;
    goal?: string;
    force?: boolean;
}
export interface DiscoverArgs {
    cwd: string;
    ideas: CandidateIdea[];
}
export interface SelectArgs {
    cwd: string;
    goal: string;
}
export interface PlanArgs {
    cwd: string;
    mode?: "standard" | "deep";
    planContent?: string;
    planFile?: string;
}
export interface ApproveArgs {
    cwd: string;
    action: "start" | "polish" | "reject" | "advanced" | "git-diff-review";
    advancedAction?: string;
}
export interface ReviewArgs {
    cwd: string;
    beadId: string;
    action: "hit-me" | "looks-good" | "skip";
}
export interface VerifyBeadsArgs {
    cwd: string;
    beadIds: string[];
}
export interface MemoryArgs {
    cwd: string;
    query?: string;
    operation?: "search" | "store";
    content?: string;
}
export interface HitMeResult {
    text: string;
    diff: string;
}
export type AgentMailResult<T> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: AgentMailError;
};
export interface AgentMailError {
    kind: "network" | "timeout" | "parse" | "rpc_error" | "empty_response";
    message: string;
    code?: number;
    stderr?: string;
}
export declare const DoctorCheckSeveritySchema: z.ZodEnum<{
    green: "green";
    yellow: "yellow";
    red: "red";
}>;
export type DoctorCheckSeverity = z.infer<typeof DoctorCheckSeveritySchema>;
export declare const DoctorCheckSchema: z.ZodObject<{
    name: z.ZodString;
    severity: z.ZodEnum<{
        green: "green";
        yellow: "yellow";
        red: "red";
    }>;
    message: z.ZodString;
    hint: z.ZodOptional<z.ZodString>;
    durationMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;
export declare const DoctorReportSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    cwd: z.ZodString;
    overall: z.ZodEnum<{
        green: "green";
        yellow: "yellow";
        red: "red";
    }>;
    partial: z.ZodDefault<z.ZodBoolean>;
    checks: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        severity: z.ZodEnum<{
            green: "green";
            yellow: "yellow";
            red: "red";
        }>;
        message: z.ZodString;
        hint: z.ZodOptional<z.ZodString>;
        durationMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    elapsedMs: z.ZodNumber;
    timestamp: z.ZodString;
}, z.core.$strip>;
export type DoctorReport = z.infer<typeof DoctorReportSchema>;
export declare const HotspotSeveritySchema: z.ZodEnum<{
    low: "low";
    high: "high";
    med: "med";
}>;
export type HotspotSeverity = z.infer<typeof HotspotSeveritySchema>;
export declare const HotspotRowSchema: z.ZodObject<{
    file: z.ZodString;
    beadIds: z.ZodArray<z.ZodString>;
    contentionCount: z.ZodNumber;
    severity: z.ZodEnum<{
        low: "low";
        high: "high";
        med: "med";
    }>;
    provenance: z.ZodEnum<{
        "files-section": "files-section";
        prose: "prose";
    }>;
}, z.core.$strip>;
export type HotspotRow = z.infer<typeof HotspotRowSchema>;
export declare const HotspotMatrixSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    rows: z.ZodArray<z.ZodObject<{
        file: z.ZodString;
        beadIds: z.ZodArray<z.ZodString>;
        contentionCount: z.ZodNumber;
        severity: z.ZodEnum<{
            low: "low";
            high: "high";
            med: "med";
        }>;
        provenance: z.ZodEnum<{
            "files-section": "files-section";
            prose: "prose";
        }>;
    }, z.core.$strip>>;
    maxContention: z.ZodNumber;
    recommendation: z.ZodEnum<{
        swarm: "swarm";
        "coordinator-serial": "coordinator-serial";
    }>;
    summaryOnly: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type HotspotMatrix = z.infer<typeof HotspotMatrixSchema>;
export declare const PostmortemDraftSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    sessionStartSha: z.ZodOptional<z.ZodString>;
    goal: z.ZodString;
    phase: z.ZodString;
    markdown: z.ZodString;
    hasWarnings: z.ZodDefault<z.ZodBoolean>;
    warnings: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type PostmortemDraft = z.infer<typeof PostmortemDraftSchema>;
/**
 * v3.4.0 Bead template contract used by the `expand_bead_template` tool and
 * template library (`bead-templates.ts`). Distinct from the richer legacy
 * `BeadTemplate` interface above, which models in-repo template fixtures
 * with placeholders-as-objects.
 *
 * **Selection rule for downstream beads:**
 * - Use `BeadTemplateContract` (this type) when crossing the MCP tool boundary
 *   (e.g., `expand_bead_template` tool input/output, `deep-plan` hint emission,
 *   `approve`-time expansion). The flat-string `placeholders` is wire-friendly.
 * - Use `BeadTemplate` (richer legacy interface) when calling the in-process
 *   library API (`getTemplateById()`, `renderTemplate()`). Placeholder metadata
 *   (`description`, `example`, `required`) is needed for validation UX.
 * - Conversions between the two happen at the tool-handler edge; never mix
 *   them in the same call frame.
 */
export declare const BeadTemplateContractSchema: z.ZodObject<{
    id: z.ZodString;
    version: z.ZodNumber;
    body: z.ZodString;
    placeholders: z.ZodArray<z.ZodString>;
    dependenciesHint: z.ZodOptional<z.ZodString>;
    testStrategy: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type BeadTemplateContract = z.infer<typeof BeadTemplateContractSchema>;
/**
 * Error-code telemetry. Keys of `counts` and the `code` field of each
 * `recentEvents` entry SHOULD be `FlywheelErrorCode` values, but the schema
 * accepts any string to stay forward-compatible with newer sessions that may
 * have added codes we don't yet know about. The write path (in `telemetry.ts`,
 * landed in I7) MUST validate the key is a known `FlywheelErrorCode` before
 * incrementing; the read path tolerates unknown keys so checkpoints from
 * future versions don't fail to load.
 */
export declare const ErrorCodeTelemetrySchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    sessionStartIso: z.ZodString;
    counts: z.ZodRecord<z.ZodString, z.ZodNumber>;
    recentEvents: z.ZodArray<z.ZodObject<{
        code: z.ZodString;
        ts: z.ZodString;
        ctxHash: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ErrorCodeTelemetry = z.infer<typeof ErrorCodeTelemetrySchema>;
//# sourceMappingURL=types.d.ts.map