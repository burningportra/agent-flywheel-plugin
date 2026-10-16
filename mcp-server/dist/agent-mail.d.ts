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
export declare function matchesReservationPath(file: string, reservation: AgentMailReservation): boolean;
export declare function normalizeReservations(payload: any): AgentMailReservation[];
/**
 * Reserve files for an agent before launch/hand-off.
 */
export declare function reserveFileReservations(exec: ExecFn, cwd: string, agentName: string, files: string[], reason?: string): Promise<any>;
/**
 * Check whether any requested files are already reserved by another agent.
 */
export declare function checkFileReservations(exec: ExecFn, cwd: string, files: string[], agentName?: string): Promise<AgentMailReservation[]>;
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
 * Fetch inbox for an agent.
 */
export declare function fetchInbox(exec: ExecFn, cwd: string, agentName: string, options?: {
    limit?: number;
    urgentOnly?: boolean;
    includeBodies?: boolean;
}): Promise<AgentMailMessage[]>;
/**
 * Get agent profile with recent commits.
 */
export declare function whoisAgent(exec: ExecFn, cwd: string, agentName: string): Promise<any>;
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
 * Test-only: reset the in-flight dedupe map. Production callers must never
 * invoke this; the map is a process-lifetime singleton by design.
 */
export declare function _resetBootstrapDedupeForTest(): void;
export declare function bootstrapCoordinator(exec: ExecFn, cwd: string, agentName?: string, options?: BootstrapCoordinatorOptions): Promise<BootstrapCoordinatorResult>;
//# sourceMappingURL=agent-mail.d.ts.map