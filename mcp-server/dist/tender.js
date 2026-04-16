import fs from "node:fs";
import path from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { forceReleaseFileReservation, sendMessage, whoisAgent, } from "./agent-mail.js";
import { createLogger } from "./logger.js";
export const TELEMETRY_DIR = ".pi-flywheel";
export const TELEMETRY_FILE = "tender-events.log";
const telemetryLog = createLogger("tender-telemetry");
/**
 * Append a telemetry event as NDJSON to `<cwd>/.pi-flywheel/tender-events.log`.
 * Creates the directory if missing. Failures are logged but never throw.
 */
export function emitTelemetry(event, cwd) {
    try {
        const dir = path.join(cwd, TELEMETRY_DIR);
        mkdirSync(dir, { recursive: true });
        const file = path.join(dir, TELEMETRY_FILE);
        appendFileSync(file, JSON.stringify(event) + "\n");
    }
    catch (err) {
        telemetryLog.error("Failed to emit telemetry event", {
            kind: event.kind,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
export const DEFAULT_TENDER_CONFIG = {
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
export function loadTenderConfig(cwd) {
    const log = createLogger("tender");
    const merged = { ...DEFAULT_TENDER_CONFIG };
    const validKeys = Object.keys(DEFAULT_TENDER_CONFIG);
    const upperToKey = new Map(validKeys.map((k) => [k.toUpperCase(), k]));
    // 1. File overrides
    const filePath = path.join(cwd, ".pi-flywheel", "tender.config.json");
    if (fs.existsSync(filePath)) {
        try {
            const raw = fs.readFileSync(filePath, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                for (const [key, value] of Object.entries(parsed)) {
                    if (!validKeys.includes(key)) {
                        log.warn("Ignoring unknown key in tender.config.json", { key });
                        continue;
                    }
                    if (typeof value !== "number" || !Number.isFinite(value)) {
                        log.warn("Ignoring non-numeric value in tender.config.json", { key, value });
                        continue;
                    }
                    merged[key] = value;
                }
            }
            else {
                log.warn("tender.config.json is not a JSON object; ignoring", { filePath });
            }
        }
        catch (err) {
            log.warn("Failed to read/parse tender.config.json", {
                filePath,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    // 2. Env var overrides (win over file)
    const envPrefix = "FLYWHEEL_TENDER_";
    for (const [envName, rawValue] of Object.entries(process.env)) {
        if (!envName.startsWith(envPrefix) || rawValue === undefined)
            continue;
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
export class SwarmTender {
    exec;
    cwd;
    agents; // stepIndex → status
    config;
    timer = null;
    onStuck;
    onConflict;
    onTick;
    onCadenceCheck;
    lastCadencePromptAt = Date.now();
    lastCrossReviewAt = Date.now();
    lastCommitCheckAt = Date.now();
    onCrossReviewDue;
    onCommitOverdue;
    flywheelAgentName;
    onKill;
    onSwarmComplete;
    startedAt = Date.now();
    killedAgents = [];
    totalRegistered = 0;
    log = createLogger("tender");
    constructor(exec, cwd, worktrees, options) {
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
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => this.poll(), this.config.pollInterval);
        // Run first poll immediately
        this.poll();
    }
    /** Stop polling. */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    /** Get current status of all agents. */
    getStatus() {
        return [...this.agents.values()];
    }
    /** Get summary string for display. */
    getSummary() {
        const statuses = this.getStatus();
        const active = statuses.filter((s) => s.health === "active").length;
        const idle = statuses.filter((s) => s.health === "idle").length;
        const stuck = statuses.filter((s) => s.health === "stuck").length;
        const parts = [];
        if (active > 0)
            parts.push(`${active} active`);
        if (idle > 0)
            parts.push(`${idle} idle`);
        if (stuck > 0)
            parts.push(`${stuck} stuck`);
        return parts.join(", ") || "no agents";
    }
    /** Single poll cycle — check all worktrees. */
    async poll() {
        const now = Date.now();
        const allChangedFiles = new Map(); // file → stepIndices
        let nudgesThisCycle = 0;
        for (const [stepIndex, agent] of this.agents) {
            try {
                // Check git status for this worktree
                const result = await this.exec("git", ["status", "--porcelain"], { timeout: 5000, cwd: agent.worktreePath });
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
                }
                else if (elapsed > this.config.idleThreshold) {
                    agent.health = "idle";
                }
                else {
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
                            emitTelemetry({
                                kind: "nudge_sent",
                                ts: new Date().toISOString(),
                                agent: agentName,
                                reason: `stuck >${this.config.stuckThreshold / 1000}s`,
                                nudgeCount: agent.nudgesSent,
                                elapsedSinceActivityMs,
                            }, this.cwd);
                        })
                            .catch(err => {
                            nudgesThisCycle--; // rollback on failure
                            process.stderr.write(`[tender] Nudge delivery failed for step ${agent.stepIndex}: ${err instanceof Error ? err.message : String(err)}\n`);
                        });
                    }
                    else if (shouldKill) {
                        this.log.warn("Killing stuck agent after max nudges", { stepIndex: agent.stepIndex });
                        this.killedAgents.push(agent.worktreePath);
                        const waitedMs = now - agent.lastNudgedAt;
                        emitTelemetry({
                            kind: "agent_killed",
                            ts: new Date().toISOString(),
                            agent: path.basename(agent.worktreePath),
                            reason: `exceeded maxNudges (${this.config.maxNudges}) + killWaitMs (${this.config.killWaitMs}ms)`,
                            totalNudges: agent.nudgesSent,
                            waitedMs,
                        }, this.cwd);
                        this.onKill?.(agent);
                        this.removeAgent(stepIndex);
                    }
                }
                // Track files for conflict detection
                for (const file of files) {
                    // Skip generated/ephemeral files
                    if (file.startsWith(".pi-flywheel/"))
                        continue;
                    const existing = allChangedFiles.get(file) ?? [];
                    existing.push(stepIndex);
                    allChangedFiles.set(file, existing);
                }
            }
            catch {
                // Worktree might be gone (already cleaned up)
                // Don't crash the tender
            }
        }
        // Conflict detection: files modified in multiple worktrees
        for (const [file, stepIndices] of allChangedFiles) {
            if (stepIndices.length > 1) {
                const worktrees = stepIndices.map((idx) => this.agents.get(idx)?.worktreePath ?? "").filter(Boolean);
                emitTelemetry({
                    kind: "conflict_detected",
                    ts: new Date().toISOString(),
                    file,
                    worktrees,
                }, this.cwd);
                this.onConflict?.({ file, worktrees, stepIndices });
            }
        }
        this.onTick?.(this.getStatus());
        // Poll-cycle summary telemetry
        const statuses = this.getStatus();
        emitTelemetry({
            kind: "poll_summary",
            ts: new Date().toISOString(),
            activeAgents: statuses.filter((s) => s.health === "active").length,
            stuckAgents: statuses.filter((s) => s.health === "stuck").length,
            nudgesThisCycle,
        }, this.cwd);
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
    recordCrossReview() {
        this.lastCrossReviewAt = Date.now();
    }
    /** Record that a commit just happened, resetting the commit cadence timer. */
    recordCommit() {
        this.lastCommitCheckAt = Date.now();
    }
    /** Remove an agent from monitoring (e.g., step completed). */
    removeAgent(stepIndex) {
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
    async releaseStaleReservations(stuckAgentName, reservationIds, note) {
        for (const id of reservationIds) {
            await forceReleaseFileReservation(this.exec, this.cwd, stuckAgentName, id, note ?? `SwarmTender: agent ${stuckAgentName} stuck for >${this.config.stuckThreshold / 1000}s`, true);
        }
    }
    /**
     * Send a nudge message to a stuck agent via Agent Mail.
     * Prompts the agent to check in or report blockers.
     */
    async nudgeStuckAgent(stuckAgentName, threadId) {
        if (!this.flywheelAgentName)
            return;
        await sendMessage(this.exec, this.cwd, this.flywheelAgentName, [stuckAgentName], `[SwarmTender] Are you stuck?`, `You haven't made changes in >${this.config.stuckThreshold / 1000}s. ` +
            `Please report your status:\n` +
            `- If blocked, describe the blocker so we can re-route work.\n` +
            `- If still working, send a progress update.\n` +
            `- If done, release your file reservations with \`am_release\`.`, { threadId, importance: "high", ackRequired: true });
    }
    /**
     * Get whois profile for an agent via Agent Mail.
     * Useful for diagnosing which agent is stuck and what it was doing.
     */
    async inspectAgent(agentName) {
        return whoisAgent(this.exec, this.cwd, agentName);
    }
}
//# sourceMappingURL=tender.js.map