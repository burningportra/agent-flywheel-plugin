import path from "node:path";
import {
  forceReleaseFileReservation,
  checkFileReservations,
  fetchInbox,
  sendMessage,
  whoisAgent,
} from "./agent-mail.js";
import type { ExecFn } from "./exec.js";
import { createLogger } from "./logger.js";

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
  /** Delay after stuck detection before first nudge fires (default 0 = immediate). */
  nudgeDelayMs: number;
  /** How many nudges to send before killing (default 2). */
  maxNudges: number;
  /** How long to wait after last nudge before kill (default 120_000). */
  killWaitMs: number;
  /** Max nudges to send across all agents in a single poll cycle (default 3). */
  maxNudgesPerPoll?: number;
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

const DEFAULT_CONFIG: TenderConfig = {
  pollInterval: 60_000,
  stuckThreshold: 300_000,
  idleThreshold: 120_000,
  cadenceIntervalMs: 20 * 60 * 1000,
  nudgeDelayMs: 0,
  maxNudges: 2,
  killWaitMs: 120_000,
};

const CADENCE_CHECKLIST = `## Operator Cadence Check (every ~20 min (configurable via cadenceIntervalMs))

1. Check bead progress — run \`br list --status in_progress --json\` or \`bv --robot-triage\`. Are agents making steady progress? Any beads stuck >15 min?
2. Handle compactions — if any agent looks confused or is repeating itself, send: "Reread AGENTS.md so it's still fresh in your mind."
3. Run a review round — pick one agent and send the fresh-eyes review prompt. Catches bugs before they compound.
4. Manage rate limits — if an agent hit rate limits, switch account with CAAM or start a fresh agent.
5. Periodic commit — designate one agent to do an organized commit every 1-2 hours.
6. Handle surprises — create new beads for unanticipated issues discovered during implementation.`;

// ─── SwarmTender ───────────────────────────────────────────────

export interface SwarmTenderOptions {
  config?: Partial<TenderConfig>;
  onStuck?: (agent: AgentStatus) => void;
  onConflict?: (conflict: ConflictAlert) => void;
  onTick?: (statuses: AgentStatus[]) => void;
  /** Called every cadenceIntervalMs with the operator cadence checklist. */
  onCadenceCheck?: (checklist: string) => void;
  /** Agent Mail orchestrator identity (for sending stuck-agent messages). */
  orchestratorAgentName?: string;
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
  private orchestratorAgentName?: string;
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
    this.config = { ...DEFAULT_CONFIG, ...options?.config };
    this.config.maxNudgesPerPoll = this.config.maxNudgesPerPoll ?? 3;
    if (this.config.nudgeDelayMs > this.config.killWaitMs) {
      process.stderr.write(`[tender] WARNING: nudgeDelayMs (${this.config.nudgeDelayMs}) > killWaitMs (${this.config.killWaitMs}) — agents will never be killed after nudging\n`);
    }
    this.onStuck = options?.onStuck;
    this.onConflict = options?.onConflict;
    this.onTick = options?.onTick;
    this.onCadenceCheck = options?.onCadenceCheck;
    this.orchestratorAgentName = options?.orchestratorAgentName;
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

        if (agent.health === "stuck" && this.orchestratorAgentName) {
          const canNudge = agent.nudgesSent < this.config.maxNudges &&
            (now - agent.lastNudgedAt) >= this.config.nudgeDelayMs;
          const shouldKill = agent.nudgesSent >= this.config.maxNudges &&
            (now - agent.lastNudgedAt) >= this.config.killWaitMs;

          if (canNudge && nudgesThisCycle < (this.config.maxNudgesPerPoll ?? 3)) {
            const agentName = path.basename(agent.worktreePath);
            nudgesThisCycle++; // increment synchronously before async call to enforce budget
            this.nudgeStuckAgent(agentName, agent.worktreePath)
              .then(() => {
                agent.nudgesSent++;
                agent.lastNudgedAt = now;
                this.log.warn("Nudged stuck agent", { stepIndex: agent.stepIndex, nudgesSent: agent.nudgesSent });
              })
              .catch(err => {
                nudgesThisCycle--; // rollback on failure
                process.stderr.write(`[tender] Nudge delivery failed for step ${agent.stepIndex}: ${err instanceof Error ? err.message : String(err)}\n`);
              });
          } else if (shouldKill) {
            this.log.warn("Killing stuck agent after max nudges", { stepIndex: agent.stepIndex });
            this.killedAgents.push(agent.worktreePath);
            this.onKill?.(agent);
            this.removeAgent(stepIndex);
          }
        }

        // Track files for conflict detection
        for (const file of files) {
          // Skip generated/ephemeral files
          if (file.startsWith(".pi-orchestrator/")) continue;
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
        this.onConflict?.({ file, worktrees, stepIndices });
      }
    }

    this.onTick?.(this.getStatus());

    // Cadence check: fire if the interval has elapsed
    if (now - this.lastCadencePromptAt >= this.config.cadenceIntervalMs) {
      this.lastCadencePromptAt = now;
      this.onCadenceCheck?.(CADENCE_CHECKLIST);
    }
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
    if (!this.orchestratorAgentName) return;
    await sendMessage(this.exec, this.cwd, this.orchestratorAgentName, [stuckAgentName],
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
