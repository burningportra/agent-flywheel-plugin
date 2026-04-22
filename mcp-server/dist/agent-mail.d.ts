import type { ExecFn } from "./exec.js";
import type { AgentMailResult } from "./types.js";
export declare const AGENT_MAIL_URL = "http://127.0.0.1:8765";
export interface AgentMailReservation {
    id?: number | string;
    agent_name?: string;
    path_pattern?: string;
    path?: string;
    exclusive?: boolean;
    active?: boolean;
    expires_at?: string;
    [key: string]: unknown;
}
export interface AgentMailMessage {
    id: number;
    thread_id?: string;
    sender_name?: string;
    subject?: string;
    body_md?: string;
    importance?: "low" | "normal" | "high" | "urgent";
    ack_required?: boolean;
    created_ts?: string;
    [key: string]: unknown;
}
export interface BuildSlotInfo {
    slot: string;
    agent_name?: string;
    exclusive?: boolean;
    expires_ts?: string;
    [key: string]: unknown;
}
/**
 * Call an agent-mail MCP tool via its JSON-RPC HTTP endpoint.
 * Used by the agent-flywheel itself (not sub-agents) to manage projects/reservations.
 *
 * Returns a discriminated union: `{ ok: true, data }` on success,
 * `{ ok: false, error }` with a classified error kind on failure.
 */
export declare function agentMailRPC<T = any>(exec: ExecFn, toolName: string, args: Record<string, unknown>): Promise<AgentMailResult<T>>;
/**
 * Backward-compatible unwrapper: extracts data from AgentMailResult
 * or returns null on error (matching the old agentMailRPC return contract).
 */
export declare function unwrapRPC<T>(result: AgentMailResult<T>): T | null;
/**
 * Read an agent-mail MCP resource via the same JSON-RPC HTTP endpoint.
 */
export declare function agentMailReadResource(exec: ExecFn, uri: string): Promise<any>;
/**
 * Ensure project exists in agent-mail. Called once during flywheel_profile.
 */
export declare function ensureAgentMailProject(exec: ExecFn, cwd: string): Promise<void>;
export declare function matchesReservationPath(file: string, reservation: AgentMailReservation): boolean;
export declare function normalizeReservations(payload: any): AgentMailReservation[];
/**
 * Reserve files for an agent before launch/hand-off.
 */
export declare function reserveFileReservations(exec: ExecFn, cwd: string, agentName: string, files: string[], reason?: string): Promise<any>;
/**
 * Release file reservations for an agent during cleanup.
 */
export declare function releaseFileReservations(exec: ExecFn, cwd: string, agentName: string, files?: string[]): Promise<any>;
/**
 * Check whether any requested files are already reserved by another agent.
 */
export declare function checkFileReservations(exec: ExecFn, cwd: string, files: string[], agentName?: string): Promise<AgentMailReservation[]>;
/**
 * Call macro_prepare_thread — join an existing thread with context summary.
 * Use when spawning review agents that need to participate in an existing bead thread.
 */
export declare function prepareThread(exec: ExecFn, cwd: string, agentName: string, threadId: string): Promise<any>;
/**
 * Call macro_file_reservation_cycle — reserve files, do work, auto-release.
 * Returns a reservation ID that can be used to track the reservation.
 */
export declare function fileReservationCycle(exec: ExecFn, cwd: string, agentName: string, files: string[], reason?: string): Promise<any>;
/**
 * Call macro_contact_handshake — set up cross-agent contact for DM communication.
 */
export declare function contactHandshake(exec: ExecFn, cwd: string, fromAgent: string, toAgent: string): Promise<any>;
/**
 * Renew (extend) file reservations for an agent.
 * Use when an agent's work takes longer than the original TTL.
 */
export declare function renewFileReservations(exec: ExecFn, cwd: string, agentName: string, extendSeconds?: number): Promise<any>;
/**
 * Force-release a stale reservation from a crashed or stuck agent.
 * Optionally notifies the previous holder.
 */
export declare function forceReleaseFileReservation(exec: ExecFn, cwd: string, agentName: string, reservationId: number, note?: string, notifyPrevious?: boolean): Promise<any>;
/**
 * Send a message to one or more agents.
 */
export declare function sendMessage(exec: ExecFn, cwd: string, senderName: string, to: string[], subject: string, body: string, options?: {
    threadId?: string;
    importance?: "low" | "normal" | "high" | "urgent";
    ackRequired?: boolean;
    cc?: string[];
}): Promise<any>;
/**
 * Reply to a message preserving thread context.
 */
export declare function replyMessage(exec: ExecFn, cwd: string, messageId: number, senderName: string, body: string): Promise<any>;
/**
 * Acknowledge a message (marks as read + acknowledged).
 */
export declare function acknowledgeMessage(exec: ExecFn, cwd: string, agentName: string, messageId: number): Promise<any>;
/**
 * Fetch inbox for an agent.
 */
export declare function fetchInbox(exec: ExecFn, cwd: string, agentName: string, options?: {
    limit?: number;
    urgentOnly?: boolean;
    includeBodies?: boolean;
}): Promise<AgentMailMessage[]>;
/**
 * Search messages via FTS5 full-text search.
 */
export declare function searchMessages(exec: ExecFn, cwd: string, query: string, limit?: number): Promise<AgentMailMessage[]>;
/**
 * Summarize a thread — extracts key points and action items via LLM.
 * Useful for handoffs and review agents joining existing threads.
 */
export declare function summarizeThread(exec: ExecFn, cwd: string, threadId: string): Promise<any>;
/**
 * Get agent profile with recent commits.
 */
export declare function whoisAgent(exec: ExecFn, cwd: string, agentName: string): Promise<any>;
/**
 * Acquire an advisory build slot (e.g. "dev-server", "watcher", "build").
 * Prevents multiple agents from running conflicting long-lived processes.
 */
export declare function acquireBuildSlot(exec: ExecFn, cwd: string, agentName: string, slot: string, ttlSeconds?: number, exclusive?: boolean): Promise<any>;
/**
 * Renew (extend) a build slot TTL.
 */
export declare function renewBuildSlot(exec: ExecFn, cwd: string, agentName: string, slot: string, extendSeconds?: number): Promise<any>;
/**
 * Release a build slot when done.
 */
export declare function releaseBuildSlot(exec: ExecFn, cwd: string, agentName: string, slot: string): Promise<any>;
/**
 * Check Agent Mail server health via MCP tool.
 * Returns { status: "healthy" } on success, null on failure.
 */
export declare function healthCheck(exec: ExecFn): Promise<{
    status: string;
} | null>;
/**
 * Install the pre-commit guard via the MCP tool (preferred over manual scaffolding).
 */
export declare function installPreCommitGuardViaMCP(exec: ExecFn, cwd: string): Promise<any>;
/**
 * Build a JSON-RPC curl command string for agent-mail.
 */
export declare function amRpcCmd(tool: string, args: Record<string, unknown>): string;
/**
 * Safely wrap a string in bash single quotes.
 * Single-quoted strings in bash are literal — no variable expansion, no command
 * substitution, no backtick evaluation. The only character that cannot appear
 * inside a single-quoted string is the single-quote itself, which we handle by
 * ending the quote, inserting a literal escaped single-quote, then reopening.
 *
 * Example: /path/it's/here  →  '/path/it'"'"'s/here'
 */
export declare function shellSingleQuote(s: string): string;
/**
 * Build a bash helper script that wraps agent-mail calls.
 * Sub-agents source this to get am_send, am_inbox, am_release functions
 * with their agent name and project key baked in — no manual substitution needed.
 */
export declare function amHelperScript(cwd: string, threadId: string): string;
/**
 * Generates an agent-mail bootstrap preamble for a parallel sub-agent's task.
 * Uses a bash helper script approach — sub-agents get am_send/am_inbox/am_release
 * functions with correct field names baked in. No manual JSON construction needed.
 */
export declare function agentMailTaskPreamble(cwd: string, _agentName: string, stepDesc: string, artifacts: string[], threadId: string, mode?: "worktree" | "single-branch"): string;
/**
 * Register the agent-flywheel as a named agent in agent-mail.
 * Call this once during flywheel_profile before any sub-agent spawning.
 */
export declare function registerFlywheelAgent(exec: ExecFn, cwd: string, agentName?: string): Promise<any>;
/**
 * Start a full agent-mail session (register, bootstrap, set up file reservations).
 * Replaces bare ensureAgentMailProject() in flywheel_profile.
 */
export declare function agentMailStartSession(exec: ExecFn, cwd: string, agentName?: string): Promise<any>;
/**
 * Send a bead completion message to the bead's thread.
 * Call in flywheel_approve_beads when a bead result = success.
 */
export declare function sendBeadCompletionMessage(exec: ExecFn, cwd: string, beadId: string, senderName: string, summary: string): Promise<any>;
/**
 * Acknowledge a batch of message IDs. Called in /flywheel-status after inbox read.
 */
export declare function acknowledgeMessages(exec: ExecFn, cwd: string, agentName: string, messageIds: number[]): Promise<void>;
/**
 * Fetch inbox messages for the flywheel agent.
 */
export declare function fetchInboxMessages(exec: ExecFn, cwd: string, agentName?: string): Promise<AgentMailMessage[]>;
export type AgentMailRole = 'coordinator' | 'implementer' | 'reviewer' | 'generic';
export interface BootstrapCoordinatorOptions {
    /**
     * Program name passed to `macro_start_session`. Contact-policy hardening is
     * only applied for `claude-code` coordinators (where the planner's
     * first-contact path was previously blocked by default `contacts_only`).
     */
    program?: string;
    /** Role hint — `coordinator` triggers contact-policy hardening. */
    role?: AgentMailRole;
    /** Model identifier forwarded to `macro_start_session`. */
    model?: string;
    /** Human-readable task description. */
    taskDescription?: string;
}
export interface BootstrapCoordinatorResult {
    /** Raw session payload from `macro_start_session`, or null on failure. */
    session: any | null;
    /** True when `set_contact_policy` was invoked and succeeded. */
    contactPolicyApplied: boolean;
    /** Non-fatal warnings (e.g. contact-policy set failed). */
    warnings: string[];
}
/**
 * Bootstrap a coordinator agent-mail session. After successful registration,
 * opportunistically sets `contact_policy=auto` when the program is
 * `claude-code` AND the role is `coordinator` so planners can DM the
 * coordinator without a contacts-only block.
 *
 * Never throws: contact-policy set failures are logged at warn level with
 * structured `code: 'agent_mail_unreachable'` and returned as a warning.
 * The caller's session continues.
 */
export declare function bootstrapCoordinator(exec: ExecFn, cwd: string, agentName?: string, options?: BootstrapCoordinatorOptions): Promise<BootstrapCoordinatorResult>;
//# sourceMappingURL=agent-mail.d.ts.map