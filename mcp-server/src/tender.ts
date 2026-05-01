import fs from "node:fs";
import path from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import {
  forceReleaseFileReservation,
  checkFileReservations,
  fetchInbox,
  sendMessage,
  whoisAgent,
} from "./agent-mail.js";
import type { ExecFn } from "./exec.js";
import { createLogger } from "./logger.js";
import { errMsg } from "./errors.js";
import { normalizeText } from "./utils/text-normalize.js";

// ─── Telemetry ─────────────────────────────────────────────────

export type TenderTelemetryEvent =
  | {
      kind: "nudge_sent";
      ts: string;
      agent: string;
      reason: string;
      nudgeCount: number;
      elapsedSinceActivityMs: number;
    }
  | {
      kind: "agent_killed";
      ts: string;
      agent: string;
      reason: string;
      totalNudges: number;
      waitedMs: number;
    }
  | {
      kind: "conflict_detected";
      ts: string;
      file: string;
      worktrees: string[];
    }
  | {
      kind: "poll_summary";
      ts: string;
      activeAgents: number;
      stuckAgents: number;
      nudgesThisCycle: number;
    };

export const TELEMETRY_DIR = ".pi-flywheel";
export const TELEMETRY_FILE = "tender-events.log";
export const DEFAULT_TENDER_DAEMON_AGENT = "FlywheelAgent";
export const DEFAULT_TENDER_DAEMON_INTERVAL_MS = 30_000;

const MAX_TRACKED_MESSAGE_IDS = 2_000;

const telemetryLog = createLogger("tender-telemetry");

/**
 * Append a telemetry event as NDJSON to `<cwd>/.pi-flywheel/tender-events.log`.
 * Creates the directory if missing. Failures are logged but never throw.
 */
export function emitTelemetry(
  event: TenderTelemetryEvent,
  cwd: string
): void {
  try {
    const dir = path.join(cwd, TELEMETRY_DIR);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, TELEMETRY_FILE);
    appendFileSync(file, JSON.stringify(event) + "\n");
  } catch (err) {
    telemetryLog.error("Failed to emit telemetry event", {
      kind: event.kind,
      error: errMsg(err),
    });
  }
}

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

export type TenderDaemonEvent =
  | {
      kind: "tick";
      ts: string;
      pollTs: number;
      session: string;
      newMessages: number;
      paneCount: number;
      robotState: string | null;
    }
  | {
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
    }
  | {
      kind: "pane_state_changed";
      ts: string;
      pollTs: number;
      session: string;
      pane: string;
      previousState: string;
      nextState: string;
    }
  | {
      kind: "rate_limited";
      ts: string;
      pollTs: number;
      session: string;
      pane: string;
      state: "rate_limited";
    }
  | {
      kind: "context_low";
      ts: string;
      pollTs: number;
      session: string;
      pane: string;
      state: "context_low";
    }
  | {
      kind: "daemon_stopped";
      ts: string;
      session: string;
      reason: string;
    };

export interface TenderDaemonRunOnceResult {
  events: TenderDaemonEvent[];
  nextState: TenderDaemonState;
}

function normalizeStateValue(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : "unknown";
}

function normalizeRobotState(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizePaneStateMap(paneStates: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [pane, state] of Object.entries(paneStates)) {
    const key = pane.trim();
    if (key.length === 0) continue;
    normalized[key] = normalizeStateValue(state);
  }
  return normalized;
}

function parseMessageTs(createdTs: string | undefined): number | null {
  if (typeof createdTs !== "string" || createdTs.length === 0) return null;
  const parsed = Date.parse(createdTs);
  return Number.isFinite(parsed) ? parsed : null;
}

function trimKnownMessageIds(knownMessageIds: Set<number>): void {
  const overflow = knownMessageIds.size - MAX_TRACKED_MESSAGE_IDS;
  if (overflow <= 0) return;
  const iter = knownMessageIds.values();
  for (let i = 0; i < overflow; i++) {
    const next = iter.next();
    if (next.done) break;
    knownMessageIds.delete(next.value);
  }
}

export function makeTenderDaemonStoppedEvent(
  session: string,
  reason: string,
  ts: string = new Date().toISOString(),
): TenderDaemonEvent {
  return { kind: "daemon_stopped", ts, session, reason };
}

export function runTenderDaemonOnce(
  prevState: TenderDaemonState,
  snapshot: TenderDaemonPollSnapshot,
): TenderDaemonRunOnceResult {
  const pollTs = Number.isFinite(snapshot.pollTs ?? NaN) ? (snapshot.pollTs as number) : Date.now();
  const ts = new Date(pollTs).toISOString();

  const nextPaneStates = normalizePaneStateMap(snapshot.paneStates);
  const nextRobotState = normalizeRobotState(snapshot.robotState);
  const prevRobotState = normalizeRobotState(prevState.robotState);

  const knownMessageIds = new Set<number>(
    prevState.knownMessageIds.filter((id) => Number.isFinite(id)),
  );
  const newMessages: TenderDaemonMessage[] = [];

  for (const message of snapshot.messages) {
    if (!Number.isFinite(message.id)) continue;
    const createdTs = parseMessageTs(message.created_ts);
    const isNewById = !knownMessageIds.has(message.id);
    const isNewByCreatedTs = createdTs === null ? true : createdTs > prevState.lastPollTs;
    if (isNewById && isNewByCreatedTs) {
      newMessages.push(message);
    }
    knownMessageIds.add(message.id);
  }
  trimKnownMessageIds(knownMessageIds);

  const events: TenderDaemonEvent[] = [
    {
      kind: "tick",
      ts,
      pollTs,
      session: snapshot.session,
      newMessages: newMessages.length,
      paneCount: Object.keys(nextPaneStates).length,
      robotState: nextRobotState,
    },
  ];

  newMessages.sort((a, b) => {
    const aTs = parseMessageTs(a.created_ts) ?? a.id;
    const bTs = parseMessageTs(b.created_ts) ?? b.id;
    return aTs - bTs;
  });
  for (const message of newMessages) {
    events.push({
      kind: "message_received",
      ts,
      pollTs,
      session: snapshot.session,
      messageId: message.id,
      senderName: message.sender_name,
      subject: message.subject,
      threadId: message.thread_id,
      importance: message.importance,
      createdTs: message.created_ts,
    });
  }

  const paneNames = new Set<string>([
    ...Object.keys(prevState.paneStates),
    ...Object.keys(nextPaneStates),
  ]);
  for (const pane of paneNames) {
    const previousState = normalizeStateValue(prevState.paneStates[pane]);
    const currentState = normalizeStateValue(nextPaneStates[pane]);
    if (previousState === currentState) continue;
    events.push({
      kind: "pane_state_changed",
      ts,
      pollTs,
      session: snapshot.session,
      pane,
      previousState,
      nextState: currentState,
    });
    if (currentState === "rate_limited") {
      events.push({
        kind: "rate_limited",
        ts,
        pollTs,
        session: snapshot.session,
        pane,
        state: "rate_limited",
      });
    } else if (currentState === "context_low") {
      events.push({
        kind: "context_low",
        ts,
        pollTs,
        session: snapshot.session,
        pane,
        state: "context_low",
      });
    }
  }

  if (normalizeStateValue(prevRobotState) !== normalizeStateValue(nextRobotState)) {
    const previousState = normalizeStateValue(prevRobotState);
    const nextState = normalizeStateValue(nextRobotState);
    events.push({
      kind: "pane_state_changed",
      ts,
      pollTs,
      session: snapshot.session,
      pane: "_session",
      previousState,
      nextState,
    });
    if (nextState === "rate_limited") {
      events.push({
        kind: "rate_limited",
        ts,
        pollTs,
        session: snapshot.session,
        pane: "_session",
        state: "rate_limited",
      });
    } else if (nextState === "context_low") {
      events.push({
        kind: "context_low",
        ts,
        pollTs,
        session: snapshot.session,
        pane: "_session",
        state: "context_low",
      });
    }
  }

  return {
    events,
    nextState: {
      session: snapshot.session,
      lastPollTs: pollTs,
      knownMessageIds: [...knownMessageIds],
      paneStates: nextPaneStates,
      robotState: nextRobotState,
    },
  };
}

// ─── Types ─────────────────────────────────────────────────────

export type AgentHealth = "active" | "idle" | "stuck";

export interface AgentStatus {
  worktreePath: string;
  stepIndex: number;
  health: AgentHealth;
  lastActivity: number; // timestamp ms
  changedFiles: string[];
  nudgesSent: number;    // how many nudges sent to this agent (default 0)
  lastNudgedAt: number;  // timestamp of last nudge (default 0)
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

export const DEFAULT_TENDER_CONFIG: TenderConfig = {
  pollInterval: 60_000,
  stuckThreshold: 300_000,
  idleThreshold: 120_000,
  cadenceIntervalMs: 20 * 60 * 1000,
  crossReviewIntervalMs: 45 * 60 * 1000,
  commitCadenceMs: 90 * 60 * 1000,
  nudgeDelayMs: 0,
  maxNudges: 2,
  killWaitMs: 120_000,
  maxNudgesPerPoll: 3,
};

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
export function loadTenderConfig(cwd: string): TenderConfig {
  const log = createLogger("tender");
  const merged: TenderConfig = { ...DEFAULT_TENDER_CONFIG };
  const validKeys = Object.keys(DEFAULT_TENDER_CONFIG) as (keyof TenderConfig)[];
  const upperToKey = new Map<string, keyof TenderConfig>(
    validKeys.map((k) => [k.toUpperCase(), k])
  );

  // 1. File overrides
  const filePath = path.join(cwd, ".pi-flywheel", "tender.config.json");
  if (fs.existsSync(filePath)) {
    try {
      const raw = normalizeText(fs.readFileSync(filePath, "utf8"));
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (!validKeys.includes(key as keyof TenderConfig)) {
            log.warn("Ignoring unknown key in tender.config.json", { key });
            continue;
          }
          if (typeof value !== "number" || !Number.isFinite(value)) {
            log.warn("Ignoring non-numeric value in tender.config.json", { key, value });
            continue;
          }
          merged[key as keyof TenderConfig] = value;
        }
      } else {
        log.warn("tender.config.json is not a JSON object; ignoring", { filePath });
      }
    } catch (err) {
      log.warn("Failed to read/parse tender.config.json", {
        filePath,
        error: errMsg(err),
      });
    }
  }

  // 2. Env var overrides (win over file)
  const envPrefix = "FLYWHEEL_TENDER_";
  for (const [envName, rawValue] of Object.entries(process.env)) {
    if (!envName.startsWith(envPrefix) || rawValue === undefined) continue;
    const suffix = envName.slice(envPrefix.length);
    const key = upperToKey.get(suffix);
    if (!key) {
      log.warn("Ignoring unknown FLYWHEEL_TENDER_* env var", { envName });
      continue;
    }
    const numeric = Number(rawValue);
    if (!Number.isFinite(numeric)) {
      log.warn("Ignoring non-numeric FLYWHEEL_TENDER_* env var", { envName, value: rawValue });
      continue;
    }
    merged[key] = numeric;
  }

  return merged;
}

const CADENCE_CHECKLIST = `## Operator Cadence Check (every ~20 min (configurable via cadenceIntervalMs))

1. Check bead progress — run \`br list --status in_progress --json\` or \`bv --robot-triage\`. Are agents making steady progress? Any beads stuck >15 min?
2. Handle compactions — if any agent looks confused or is repeating itself, send: "Reread AGENTS.md so it's still fresh in your mind."
3. Run a review round — pick one agent and send the fresh-eyes review prompt. Catches bugs before they compound.
4. Manage rate limits — if an agent is producing slow or degraded output, it may be rate-limited. Options: switch account with \`caam switch\`, start a fresh agent on a different account, or pause the stuck agent for 5 minutes.
5. Periodic commit — designate one agent to do an organized commit every 1-2 hours. (SwarmTender warns after 90 min without commits.)
6. Handle surprises — create new beads for unanticipated issues discovered during implementation.`;

// ─── SwarmTender ───────────────────────────────────────────────

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

export class SwarmTender {
  private exec: ExecFn;
  private cwd: string;
  private agents: Map<number, AgentStatus>; // stepIndex → status
  private config: TenderConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onStuck?: (agent: AgentStatus) => void;
  private onConflict?: (conflict: ConflictAlert) => void;
  private onTick?: (statuses: AgentStatus[]) => void;
  private onCadenceCheck?: (checklist: string) => void;
  private lastCadencePromptAt: number = Date.now();
  private lastCrossReviewAt: number = Date.now();
  private lastCommitCheckAt: number = Date.now();
  private onCrossReviewDue?: (minutesSinceLastReview: number) => void;
  private onCommitOverdue?: (minutesSinceLastCommit: number) => void;
  private flywheelAgentName?: string;
  private onKill?: (agent: AgentStatus) => void;
  private onSwarmComplete?: (summary: SwarmCompletionSummary) => void;
  private startedAt: number = Date.now();
  private killedAgents: string[] = [];
  private totalRegistered: number = 0;
  private log = createLogger("tender");

  constructor(
    exec: ExecFn,
    cwd: string,
    worktrees: { path: string; stepIndex: number }[],
    options?: SwarmTenderOptions
  ) {
    this.exec = exec;
    this.cwd = cwd;
    this.config = { ...DEFAULT_TENDER_CONFIG, ...options?.config };
    if (this.config.nudgeDelayMs > this.config.killWaitMs) {
      process.stderr.write(`[tender] WARNING: nudgeDelayMs (${this.config.nudgeDelayMs}) > killWaitMs (${this.config.killWaitMs}) — agents will never be killed after nudging\n`);
    }
    this.onStuck = options?.onStuck;
    this.onConflict = options?.onConflict;
    this.onTick = options?.onTick;
    this.onCadenceCheck = options?.onCadenceCheck;
    this.onCrossReviewDue = options?.onCrossReviewDue;
    this.onCommitOverdue = options?.onCommitOverdue;
    this.flywheelAgentName = options?.flywheelAgentName;
    this.onKill = options?.onKill;
    this.onSwarmComplete = options?.onSwarmComplete;
    this.totalRegistered = worktrees.length;

    this.agents = new Map();
    for (const wt of worktrees) {
      this.agents.set(wt.stepIndex, {
        worktreePath: wt.path,
        stepIndex: wt.stepIndex,
        health: "active",
        lastActivity: Date.now(),
        changedFiles: [],
        nudgesSent: 0,
        lastNudgedAt: 0,
      });
    }
  }

  /** Start polling. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.config.pollInterval);
    // Run first poll immediately
    this.poll();
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Get current status of all agents. */
  getStatus(): AgentStatus[] {
    return [...this.agents.values()];
  }

  /** Get summary string for display. */
  getSummary(): string {
    const statuses = this.getStatus();
    const active = statuses.filter((s) => s.health === "active").length;
    const idle = statuses.filter((s) => s.health === "idle").length;
    const stuck = statuses.filter((s) => s.health === "stuck").length;
    const parts: string[] = [];
    if (active > 0) parts.push(`${active} active`);
    if (idle > 0) parts.push(`${idle} idle`);
    if (stuck > 0) parts.push(`${stuck} stuck`);
    return parts.join(", ") || "no agents";
  }

  /** Single poll cycle — check all worktrees. */
  private async poll(): Promise<void> {
    const now = Date.now();
    const allChangedFiles = new Map<string, number[]>(); // file → stepIndices
    let nudgesThisCycle = 0;

    for (const [stepIndex, agent] of this.agents) {
      try {
        // Check git status for this worktree
        const result = await this.exec(
          "git",
          ["status", "--porcelain"],
          { timeout: 5000, cwd: agent.worktreePath }
        );

        const files = result.code === 0
          ? result.stdout.trim().split("\n").filter(Boolean).map((l) => l.slice(3))
          : [];

        // Check if files changed since last poll
        const filesChanged = files.length !== agent.changedFiles.length ||
          files.some((f, i) => f !== agent.changedFiles[i]);

        if (filesChanged) {
          agent.lastActivity = now;
          agent.changedFiles = files;
        }

        // Classify health
        const elapsed = now - agent.lastActivity;
        const prevHealth = agent.health;

        if (elapsed > this.config.stuckThreshold) {
          agent.health = "stuck";
          if (prevHealth !== "stuck") {
            this.onStuck?.(agent);
          }
        } else if (elapsed > this.config.idleThreshold) {
          agent.health = "idle";
        } else {
          agent.health = "active";
        }

        if (agent.health === "stuck" && this.flywheelAgentName) {
          const canNudge = agent.nudgesSent < this.config.maxNudges &&
            (now - agent.lastNudgedAt) >= this.config.nudgeDelayMs;
          const shouldKill = agent.nudgesSent >= this.config.maxNudges &&
            (now - agent.lastNudgedAt) >= this.config.killWaitMs;

          if (canNudge && nudgesThisCycle < this.config.maxNudgesPerPoll) {
            const agentName = path.basename(agent.worktreePath);
            nudgesThisCycle++; // increment synchronously before async call to enforce budget
            const elapsedSinceActivityMs = elapsed;
            this.nudgeStuckAgent(agentName, agent.worktreePath)
              .then(() => {
                agent.nudgesSent++;
                agent.lastNudgedAt = now;
                this.log.warn("Nudged stuck agent", { stepIndex: agent.stepIndex, nudgesSent: agent.nudgesSent });
                emitTelemetry(
                  {
                    kind: "nudge_sent",
                    ts: new Date().toISOString(),
                    agent: agentName,
                    reason: `stuck >${this.config.stuckThreshold / 1000}s`,
                    nudgeCount: agent.nudgesSent,
                    elapsedSinceActivityMs,
                  },
                  this.cwd
                );
              })
              .catch(err => {
                nudgesThisCycle--; // rollback on failure
                process.stderr.write(`[tender] Nudge delivery failed for step ${agent.stepIndex}: ${errMsg(err)}\n`);
              });
          } else if (shouldKill) {
            this.log.warn("Killing stuck agent after max nudges", { stepIndex: agent.stepIndex });
            this.killedAgents.push(agent.worktreePath);
            const waitedMs = now - agent.lastNudgedAt;
            emitTelemetry(
              {
                kind: "agent_killed",
                ts: new Date().toISOString(),
                agent: path.basename(agent.worktreePath),
                reason: `exceeded maxNudges (${this.config.maxNudges}) + killWaitMs (${this.config.killWaitMs}ms)`,
                totalNudges: agent.nudgesSent,
                waitedMs,
              },
              this.cwd
            );
            this.onKill?.(agent);
            this.removeAgent(stepIndex);
          }
        }

        // Track files for conflict detection
        for (const file of files) {
          // Skip generated/ephemeral files
          if (file.startsWith(".pi-flywheel/")) continue;
          const existing = allChangedFiles.get(file) ?? [];
          existing.push(stepIndex);
          allChangedFiles.set(file, existing);
        }
      } catch {
        // Worktree might be gone (already cleaned up)
        // Don't crash the tender
      }
    }

    // Conflict detection: files modified in multiple worktrees
    for (const [file, stepIndices] of allChangedFiles) {
      if (stepIndices.length > 1) {
        const worktrees = stepIndices.map(
          (idx) => this.agents.get(idx)?.worktreePath ?? ""
        ).filter(Boolean);
        emitTelemetry(
          {
            kind: "conflict_detected",
            ts: new Date().toISOString(),
            file,
            worktrees,
          },
          this.cwd
        );
        this.onConflict?.({ file, worktrees, stepIndices });
      }
    }

    this.onTick?.(this.getStatus());

    // Poll-cycle summary telemetry
    const statuses = this.getStatus();
    emitTelemetry(
      {
        kind: "poll_summary",
        ts: new Date().toISOString(),
        activeAgents: statuses.filter((s) => s.health === "active").length,
        stuckAgents: statuses.filter((s) => s.health === "stuck").length,
        nudgesThisCycle,
      },
      this.cwd
    );

    // Cadence check: fire if the interval has elapsed
    if (now - this.lastCadencePromptAt >= this.config.cadenceIntervalMs) {
      this.lastCadencePromptAt = now;
      this.onCadenceCheck?.(CADENCE_CHECKLIST);
    }

    // Cross-agent review cadence: prompt if interval exceeded
    if (this.onCrossReviewDue && now - this.lastCrossReviewAt >= this.config.crossReviewIntervalMs) {
      const minSince = Math.floor((now - this.lastCrossReviewAt) / 60_000);
      this.onCrossReviewDue(minSince);
      this.lastCrossReviewAt = now; // reset after firing
    }

    // Commit cadence: warn if no commits in threshold period
    if (this.onCommitOverdue && now - this.lastCommitCheckAt >= this.config.commitCadenceMs) {
      const minSince = Math.floor((now - this.lastCommitCheckAt) / 60_000);
      this.onCommitOverdue(minSince);
      // Don't reset — keep firing until recordCommit() is called
    }
  }

  /** Record that a cross-agent review just happened, resetting the timer. */
  recordCrossReview(): void {
    this.lastCrossReviewAt = Date.now();
  }

  /** Record that a commit just happened, resetting the commit cadence timer. */
  recordCommit(): void {
    this.lastCommitCheckAt = Date.now();
  }

  /** Remove an agent from monitoring (e.g., step completed). */
  removeAgent(stepIndex: number): void {
    this.agents.delete(stepIndex);
    if (this.agents.size === 0) {
      this.stop();
      if (this.onSwarmComplete) {
        this.onSwarmComplete({
          totalAgents: this.totalRegistered,
          completedNormally: this.totalRegistered - this.killedAgents.length,
          killedStuck: this.killedAgents.length,
          elapsedMs: Date.now() - this.startedAt,
          stuckAgentNames: [...this.killedAgents],
        });
      }
    }
  }

  /**
   * Force-release stale file reservations from a stuck agent.
   * Uses Agent Mail's force_release_file_reservation to clear locks
   * so other agents can proceed.
   */
  async releaseStaleReservations(
    stuckAgentName: string,
    reservationIds: number[],
    note?: string
  ): Promise<void> {
    for (const id of reservationIds) {
      await forceReleaseFileReservation(
        this.exec, this.cwd, stuckAgentName, id,
        note ?? `SwarmTender: agent ${stuckAgentName} stuck for >${this.config.stuckThreshold / 1000}s`,
        true
      );
    }
  }

  /**
   * Send a nudge message to a stuck agent via Agent Mail.
   * Prompts the agent to check in or report blockers.
   */
  async nudgeStuckAgent(
    stuckAgentName: string,
    threadId: string
  ): Promise<void> {
    if (!this.flywheelAgentName) return;
    await sendMessage(this.exec, this.cwd, this.flywheelAgentName, [stuckAgentName],
      `[SwarmTender] Are you stuck?`,
      `You haven't made changes in >${this.config.stuckThreshold / 1000}s. ` +
      `Please report your status:\n` +
      `- If blocked, describe the blocker so we can re-route work.\n` +
      `- If still working, send a progress update.\n` +
      `- If done, release your file reservations with \`am_release\`.`,
      { threadId, importance: "high", ackRequired: true }
    );
  }

  /**
   * Get whois profile for an agent via Agent Mail.
   * Useful for diagnosing which agent is stuck and what it was doing.
   */
  async inspectAgent(agentName: string): Promise<any> {
    return whoisAgent(this.exec, this.cwd, agentName);
  }
}
