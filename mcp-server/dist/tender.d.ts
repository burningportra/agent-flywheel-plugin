import type { ExecFn } from "./exec.js";
export type TenderTelemetryEvent = {
    kind: "nudge_sent";
    ts: string;
    agent: string;
    reason: string;
    nudgeCount: number;
    elapsedSinceActivityMs: number;
} | {
    kind: "agent_killed";
    ts: string;
    agent: string;
    reason: string;
    totalNudges: number;
    waitedMs: number;
} | {
    kind: "conflict_detected";
    ts: string;
    file: string;
    worktrees: string[];
} | {
    kind: "poll_summary";
    ts: string;
    activeAgents: number;
    stuckAgents: number;
    nudgesThisCycle: number;
};
export declare const TELEMETRY_DIR = ".pi-flywheel";
export declare const TELEMETRY_FILE = "tender-events.log";
export declare const DEFAULT_TENDER_DAEMON_AGENT = "FlywheelAgent";
export declare const DEFAULT_TENDER_DAEMON_INTERVAL_MS = 30000;
/**
 * Append a telemetry event as NDJSON to `<cwd>/.pi-flywheel/tender-events.log`.
 * Creates the directory if missing. Failures are logged but never throw.
 */
export declare function emitTelemetry(event: TenderTelemetryEvent, cwd: string): void;
export interface TenderDaemonMessage {
    id: number;
    thread_id?: string;
    sender_name?: string;
    subject?: string;
    importance?: "low" | "normal" | "high" | "urgent";
    created_ts?: string;
}
export interface TenderDaemonState {
    session: string;
    lastPollTs: number;
    knownMessageIds: number[];
    paneStates: Record<string, string>;
    robotState: string | null;
}
export interface TenderDaemonPollSnapshot {
    session: string;
    pollTs?: number;
    messages: TenderDaemonMessage[];
    paneStates: Record<string, string>;
    robotState: string | null;
}
export type TenderDaemonEvent = {
    kind: "tick";
    ts: string;
    pollTs: number;
    session: string;
    newMessages: number;
    paneCount: number;
    robotState: string | null;
} | {
    kind: "message_received";
    ts: string;
    pollTs: number;
    session: string;
    messageId: number;
    senderName?: string;
    subject?: string;
    threadId?: string;
    importance?: "low" | "normal" | "high" | "urgent";
    createdTs?: string;
} | {
    kind: "pane_state_changed";
    ts: string;
    pollTs: number;
    session: string;
    pane: string;
    previousState: string;
    nextState: string;
} | {
    kind: "rate_limited";
    ts: string;
    pollTs: number;
    session: string;
    pane: string;
    state: "rate_limited";
} | {
    kind: "context_low";
    ts: string;
    pollTs: number;
    session: string;
    pane: string;
    state: "context_low";
} | {
    kind: "daemon_stopped";
    ts: string;
    session: string;
    reason: string;
};
export interface TenderDaemonRunOnceResult {
    events: TenderDaemonEvent[];
    nextState: TenderDaemonState;
}
export declare function makeTenderDaemonStoppedEvent(session: string, reason: string, ts?: string): TenderDaemonEvent;
export declare function runTenderDaemonOnce(prevState: TenderDaemonState, snapshot: TenderDaemonPollSnapshot): TenderDaemonRunOnceResult;
export type AgentHealth = "active" | "idle" | "stuck";
export interface AgentStatus {
    worktreePath: string;
    stepIndex: number;
    health: AgentHealth;
    lastActivity: number;
    changedFiles: string[];
    nudgesSent: number;
    lastNudgedAt: number;
}
export interface TenderConfig {
    /** Polling interval in ms (default 60_000 = 60s) */
    pollInterval: number;
    /** Agent is "stuck" after this many ms without changes (default 300_000 = 5 min) */
    stuckThreshold: number;
    /** Agent is "idle" after this many ms without changes (default 120_000 = 2 min) */
    idleThreshold: number;
    /** Cadence check interval in ms (default 20 * 60 * 1000 = 20 min) */
    cadenceIntervalMs: number;
    /** Cross-agent review interval in ms (default 45 * 60 * 1000 = 45 min) */
    crossReviewIntervalMs: number;
    /** Commit cadence warning threshold in ms (default 90 * 60 * 1000 = 90 min) */
    commitCadenceMs: number;
    /** Delay after stuck detection before first nudge fires (default 0 = immediate). */
    nudgeDelayMs: number;
    /** How many nudges to send before killing (default 2). */
    maxNudges: number;
    /** How long to wait after last nudge before kill (default 120_000). */
    killWaitMs: number;
    /** Max nudges to send across all agents in a single poll cycle (default 3). */
    maxNudgesPerPoll: number;
}
export interface ConflictAlert {
    file: string;
    worktrees: string[];
    stepIndices: number[];
}
export interface SwarmCompletionSummary {
    totalAgents: number;
    completedNormally: number;
    killedStuck: number;
    elapsedMs: number;
    stuckAgentNames: string[];
}
export declare const DEFAULT_TENDER_CONFIG: TenderConfig;
/**
 * Load a TenderConfig by shallow-merging (in order):
 *   1. DEFAULT_TENDER_CONFIG
 *   2. <cwd>/.pi-flywheel/tender.config.json (if present)
 *   3. FLYWHEEL_TENDER_<FIELD> env vars (env wins over file)
 *
 * All fields are numbers; non-numeric values or unknown keys are logged
 * (warn) and ignored.
 *
 * Env var field name is the uppercased config key with no separators —
 * e.g. `pollInterval` → `FLYWHEEL_TENDER_POLLINTERVAL`,
 *      `maxNudgesPerPoll` → `FLYWHEEL_TENDER_MAXNUDGESPERPOLL`.
 */
export declare function loadTenderConfig(cwd: string): TenderConfig;
export interface SwarmTenderOptions {
    config?: Partial<TenderConfig>;
    onStuck?: (agent: AgentStatus) => void;
    onConflict?: (conflict: ConflictAlert) => void;
    onTick?: (statuses: AgentStatus[]) => void;
    /** Called every cadenceIntervalMs with the operator cadence checklist. */
    onCadenceCheck?: (checklist: string) => void;
    /** Called when cross-agent review interval is exceeded. */
    onCrossReviewDue?: (minutesSinceLastReview: number) => void;
    /** Called when commit cadence threshold is exceeded. */
    onCommitOverdue?: (minutesSinceLastCommit: number) => void;
    /** Agent Mail flywheel identity (for sending stuck-agent messages). */
    flywheelAgentName?: string;
    onKill?: (agent: AgentStatus) => void;
    onSwarmComplete?: (summary: SwarmCompletionSummary) => void;
}
export declare class SwarmTender {
    private exec;
    private cwd;
    private agents;
    private config;
    private timer;
    private onStuck?;
    private onConflict?;
    private onTick?;
    private onCadenceCheck?;
    private lastCadencePromptAt;
    private lastCrossReviewAt;
    private lastCommitCheckAt;
    private onCrossReviewDue?;
    private onCommitOverdue?;
    private flywheelAgentName?;
    private onKill?;
    private onSwarmComplete?;
    private startedAt;
    private killedAgents;
    private totalRegistered;
    private log;
    constructor(exec: ExecFn, cwd: string, worktrees: {
        path: string;
        stepIndex: number;
    }[], options?: SwarmTenderOptions);
    /** Start polling. */
    start(): void;
    /** Stop polling. */
    stop(): void;
    /** Get current status of all agents. */
    getStatus(): AgentStatus[];
    /** Get summary string for display. */
    getSummary(): string;
    /** Single poll cycle — check all worktrees. */
    private poll;
    /** Record that a cross-agent review just happened, resetting the timer. */
    recordCrossReview(): void;
    /** Record that a commit just happened, resetting the commit cadence timer. */
    recordCommit(): void;
    /** Remove an agent from monitoring (e.g., step completed). */
    removeAgent(stepIndex: number): void;
    /**
     * Force-release stale file reservations from a stuck agent.
     * Uses Agent Mail's force_release_file_reservation to clear locks
     * so other agents can proceed.
     */
    releaseStaleReservations(stuckAgentName: string, reservationIds: number[], note?: string): Promise<void>;
    /**
     * Send a nudge message to a stuck agent via Agent Mail.
     * Prompts the agent to check in or report blockers.
     */
    nudgeStuckAgent(stuckAgentName: string, threadId: string): Promise<void>;
    /**
     * Get whois profile for an agent via Agent Mail.
     * Useful for diagnosing which agent is stuck and what it was doing.
     */
    inspectAgent(agentName: string): Promise<any>;
}
//# sourceMappingURL=tender.d.ts.map