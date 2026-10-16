import type { ExecFn } from "./exec.js";
import type { AgentMailResult } from "./types.js";
import { createLogger } from "./logger.js";
import { errMsg } from "./errors.js";
import { parseAgentMailResponse } from "./parsers.js";
import { AGENT_MAIL_URL, agentMailRPC } from "./agent-mail-rpc.js";
import { reserveOrFail, type ReserveOrFailResult } from "./agent-mail-helpers.js";

export { AGENT_MAIL_URL, agentMailRPC };

const log = createLogger("agent-mail");

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
 * Backward-compatible unwrapper: extracts data from AgentMailResult
 * or returns null on error (matching the old agentMailRPC return contract).
 */
export function unwrapRPC<T>(result: AgentMailResult<T>): T | null {
  if (!result.ok) {
    log.warn("agent-mail RPC failed", { kind: result.error.kind, message: result.error.message });
    return null;
  }
  return result.data;
}

/**
 * Read an agent-mail MCP resource via the same JSON-RPC HTTP endpoint.
 */
async function agentMailReadResource(exec: ExecFn, uri: string): Promise<any> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method: "resources/read",
    params: { uri },
  });
  const result = await exec("curl", [
    "-s", "-X", "POST", `${AGENT_MAIL_URL}/api`,
    "-H", "Content-Type: application/json",
    "-d", body,
    "--max-time", "5",
  ], { timeout: 8000 });

  // Parse outer JSON-RPC envelope
  const outer = parseAgentMailResponse<any>(result.stdout);
  if (!outer.ok) {
    log.warn("agent-mail resource read parse failed", { error: outer.error });
    return null;
  }

  try {
    const rpcResult = outer.data;
    const content = rpcResult?.contents?.[0]?.text;
    if (typeof content === "string") {
      // Inner content may be a JSON string — attempt to parse it
      try {
        return JSON.parse(content);
      } catch {
        return content;
      }
    }
    return rpcResult?.contents ?? rpcResult ?? null;
  } catch {
    return null;
  }
}

async function getAgentMailProjectSlug(exec: ExecFn, cwd: string): Promise<string | null> {
  const project = unwrapRPC(await agentMailRPC(exec, "ensure_project", { human_key: cwd }));
  const slug = project?.project?.slug ?? project?.slug;
  return typeof slug === "string" && slug.length > 0 ? slug : null;
}

export function matchesReservationPath(file: string, reservation: AgentMailReservation): boolean {
  const rawPattern = reservation.path_pattern ?? reservation.path;
  if (typeof rawPattern !== "string" || rawPattern.length === 0) return false;
  const normalized = rawPattern.replace(/^\.\//, "");
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3);
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  if (normalized.includes("*")) {
    const escaped = normalized
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*");
    return new RegExp(`^${escaped}$`).test(file);
  }
  return file === normalized;
}

export function normalizeReservations(payload: any): AgentMailReservation[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.reservations)) return payload.reservations;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

/**
 * Reserve files for an agent before launch/hand-off.
 */
export async function reserveFileReservations(
  exec: ExecFn,
  cwd: string,
  agentName: string,
  files: string[],
  reason?: string
): Promise<ReserveOrFailResult> {
  return reserveOrFail(files, {
    exec,
    cwd,
    agentName,
    ttlSeconds: 3600,
    exclusive: true,
    reason,
  });
}

/**
 * Check whether any requested files are already reserved by another agent.
 */
export async function checkFileReservations(
  exec: ExecFn,
  cwd: string,
  files: string[],
  agentName?: string
): Promise<AgentMailReservation[]> {
  if (files.length === 0) return [];

  const slug = await getAgentMailProjectSlug(exec, cwd);
  if (!slug) return [];

  const resource = await agentMailReadResource(exec, `resource://file_reservations/${slug}?active_only=true`);
  const reservations = normalizeReservations(resource);

  return reservations.filter((reservation) => {
    if (reservation.active === false) return false;
    if (agentName && reservation.agent_name === agentName) return false;
    return files.some((file) => matchesReservationPath(file, reservation));
  });
}

/**
 * Force-release a stale reservation from a crashed or stuck agent.
 * Optionally notifies the previous holder.
 */
export async function forceReleaseFileReservation(
  exec: ExecFn,
  cwd: string,
  agentName: string,
  reservationId: number,
  note?: string,
  notifyPrevious: boolean = true
): Promise<any> {
  return unwrapRPC(await agentMailRPC(exec, "force_release_file_reservation", {
    project_key: cwd,
    agent_name: agentName,
    file_reservation_id: reservationId,
    ...(note ? { note } : {}),
    notify_previous: notifyPrevious,
  }));
}

// ─── Messaging ─────────────────────────────────────────────────

/**
 * Send a message to one or more agents.
 */
export async function sendMessage(
  exec: ExecFn,
  cwd: string,
  senderName: string,
  to: string[],
  subject: string,
  body: string,
  options?: {
    threadId?: string;
    importance?: "low" | "normal" | "high" | "urgent";
    ackRequired?: boolean;
    cc?: string[];
  }
): Promise<any> {
  return unwrapRPC(await agentMailRPC(exec, "send_message", {
    project_key: cwd,
    sender_name: senderName,
    to,
    subject,
    body_md: body,
    ...(options?.threadId ? { thread_id: options.threadId } : {}),
    ...(options?.importance ? { importance: options.importance } : {}),
    ...(options?.ackRequired !== undefined ? { ack_required: options.ackRequired } : {}),
    ...(options?.cc ? { cc: options.cc } : {}),
  }));
}

/**
 * Fetch inbox for an agent.
 */
export async function fetchInbox(
  exec: ExecFn,
  cwd: string,
  agentName: string,
  options?: { limit?: number; urgentOnly?: boolean; includeBodies?: boolean }
): Promise<AgentMailMessage[]> {
  const result = unwrapRPC(await agentMailRPC(exec, "fetch_inbox", {
    project_key: cwd,
    agent_name: agentName,
    limit: options?.limit ?? 20,
    ...(options?.urgentOnly ? { urgent_only: true } : {}),
    ...(options?.includeBodies !== false ? { include_bodies: true } : {}),
  }));
  return result?.messages ?? result?.inbox ?? [];
}

/**
 * Get agent profile with recent commits.
 */
export async function whoisAgent(
  exec: ExecFn,
  cwd: string,
  agentName: string
): Promise<any> {
  return unwrapRPC(await agentMailRPC(exec, "whois", {
    project_key: cwd,
    agent_name: agentName,
    include_recent_commits: true,
    commit_limit: 5,
  }));
}

/**
 * Safely wrap a string in bash single quotes.
 * Single-quoted strings in bash are literal — no variable expansion, no command
 * substitution, no backtick evaluation. The only character that cannot appear
 * inside a single-quoted string is the single-quote itself, which we handle by
 * ending the quote, inserting a literal escaped single-quote, then reopening.
 *
 * Example: /path/it's/here  →  '/path/it'"'"'s/here'
 */
export function shellSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Build a bash helper script that wraps agent-mail calls.
 * Sub-agents source this to get am_send, am_inbox, am_release functions
 * with their agent name and project key baked in — no manual substitution needed.
 */
export function amHelperScript(cwd: string, threadId: string): string {
  const safeCwd = shellSingleQuote(cwd);
  const safeThread = shellSingleQuote(threadId);
  return `
# ── Agent Mail helper functions (source these) ──────────────
AM_URL="${AGENT_MAIL_URL}"
AM_PROJECT=${safeCwd}
AM_THREAD=${safeThread}

am_rpc() {
  local tool="$1" args="$2"
  curl -s -X POST "$AM_URL/api" \
    -H 'Content-Type: application/json' \
    -d "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"tools/call\\",\\"params\\":{\\"name\\":\\"$tool\\",\\"arguments\\":$args}}"
}

am_send() {
  local subject="$1" body="$2" importance="\${3:-normal}"
  # Thread-scoped only — no broadcast (guide §06: "no broadcast-to-all default")
  am_rpc "send_message" "{\\"human_key\\":\\"$AM_PROJECT\\",\\"sender_name\\":\\"$AM_AGENT_NAME\\",\\"to\\":[],\\"subject\\":\\"$subject\\",\\"body_md\\":\\"$body\\",\\"thread_id\\":\\"$AM_THREAD\\",\\"importance\\":\\"$importance\\"}"
}

am_dm() {
  local to_agent="$1" subject="$2" body="$3" importance="\${4:-normal}"
  # Direct message to a specific agent — use for targeted cross-agent communication
  am_rpc "send_message" "{\\"human_key\\":\\"$AM_PROJECT\\",\\"sender_name\\":\\"$AM_AGENT_NAME\\",\\"to\\":[\\"$to_agent\\"],\\"subject\\":\\"$subject\\",\\"body_md\\":\\"$body\\",\\"thread_id\\":\\"$AM_THREAD\\",\\"importance\\":\\"$importance\\"}"
}

am_inbox() {
  am_rpc "fetch_inbox" "{\\"human_key\\":\\"$AM_PROJECT\\",\\"agent_name\\":\\"$AM_AGENT_NAME\\",\\"limit\\":10,\\"include_bodies\\":true}"
}

am_inbox_urgent() {
  am_rpc "fetch_inbox" "{\\"human_key\\":\\"$AM_PROJECT\\",\\"agent_name\\":\\"$AM_AGENT_NAME\\",\\"limit\\":10,\\"urgent_only\\":true,\\"include_bodies\\":true}"
}

am_ack() {
  local message_id="$1"
  am_rpc "acknowledge_message" "{\\"human_key\\":\\"$AM_PROJECT\\",\\"agent_name\\":\\"$AM_AGENT_NAME\\",\\"message_id\\":$message_id}"
}

am_reply() {
  local message_id="$1" body="$2"
  am_rpc "reply_message" "{\\"human_key\\":\\"$AM_PROJECT\\",\\"message_id\\":$message_id,\\"sender_name\\":\\"$AM_AGENT_NAME\\",\\"body_md\\":\\"$body\\"}"
}

am_search() {
  local query="$1"
  am_rpc "search_messages" "{\\"human_key\\":\\"$AM_PROJECT\\",\\"query\\":\\"$query\\",\\"limit\\":10}"
}

am_release() {
  am_rpc "release_file_reservations" "{\\"human_key\\":\\"$AM_PROJECT\\",\\"agent_name\\":\\"$AM_AGENT_NAME\\"}"
}

am_renew() {
  local extend_seconds="\${1:-1800}"
  am_rpc "renew_file_reservations" "{\\"human_key\\":\\"$AM_PROJECT\\",\\"agent_name\\":\\"$AM_AGENT_NAME\\",\\"extend_seconds\\":$extend_seconds}"
}

am_whois() {
  local agent="$1"
  am_rpc "whois" "{\\"human_key\\":\\"$AM_PROJECT\\",\\"agent_name\\":\\"$agent\\",\\"include_recent_commits\\":true,\\"commit_limit\\":5}"
}

# am_join_thread: call macro_prepare_thread to join a review thread.
# Recommended when joining an existing bead thread as a new participant (e.g. review agents).
# Example: am_join_thread "bead-abc"
am_join_thread() {
  local thread_id="$1"
  am_rpc "macro_prepare_thread" "{\\"human_key\\":\\"$AM_PROJECT\\",\\"agent_name\\":\\"$AM_AGENT_NAME\\",\\"thread_id\\":\\"$thread_id\\"}"
}

am_summarize_thread() {
  local thread_id="$1"
  am_rpc "summarize_thread" "{\\"human_key\\":\\"$AM_PROJECT\\",\\"thread_id\\":\\"$thread_id\\",\\"include_examples\\":true,\\"llm_mode\\":true}"
}
`.trim();
}

// ─── Coordinator Bootstrap ───────────────────────────────────

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
/**
 * P1-4 (v3.4.1): In-process dedupe map for concurrent bootstrap calls.
 *
 * Prior behavior: two callers with the same (cwd, agentName, program) would
 * both fire `macro_start_session` + `set_contact_policy` racing each other —
 * harmless in the happy path but wasteful and prone to duplicate-identity
 * warnings on the server.
 *
 * New behavior: the first caller for a given key wins and takes the RPC
 * round-trip; subsequent callers await the same in-flight Promise. The slot
 * is cleared in `.finally()` so the next *serial* caller still goes through
 * the full bootstrap path (we dedupe concurrency, not results).
 *
 * Only the in-flight slot is cached; we do NOT memoize results, because the
 * underlying server state (sessions, contact policy) is mutable across time.
 */
const _bootstrapInFlight = new Map<string, Promise<BootstrapCoordinatorResult>>();

function bootstrapDedupeKey(cwd: string, agentName: string, program: string): string {
  return `${cwd}\u0000${agentName}\u0000${program}`;
}

/**
 * Test-only: reset the in-flight dedupe map. Production callers must never
 * invoke this; the map is a process-lifetime singleton by design.
 */
export function _resetBootstrapDedupeForTest(): void {
  _bootstrapInFlight.clear();
}

export async function bootstrapCoordinator(
  exec: ExecFn,
  cwd: string,
  agentName: string = 'FlywheelAgent',
  options: BootstrapCoordinatorOptions = {}
): Promise<BootstrapCoordinatorResult> {
  const program = options.program ?? 'agent-flywheel';
  const role: AgentMailRole = options.role ?? 'coordinator';
  const model = options.model ?? 'auto';
  const taskDescription = options.taskDescription ?? 'Orchestrating agentic coding flywheel';

  const key = bootstrapDedupeKey(cwd, agentName, program);
  const existing = _bootstrapInFlight.get(key);
  if (existing) {
    return existing;
  }

  const pending = (async (): Promise<BootstrapCoordinatorResult> => {
    const warnings: string[] = [];

    const session = unwrapRPC(await agentMailRPC(exec, 'macro_start_session', {
      human_key: cwd,
      program,
      model,
      task_description: taskDescription,
      inbox_limit: 10,
      agent_name: agentName,
    }));

    // Opportunistic contact-policy hardening: only for claude-code coordinators.
    // Prior-session learning: without this, planner first-send_message calls
    // are blocked by the default `contacts_only` policy.
    let contactPolicyApplied = false;
    if (program === 'claude-code' && role === 'coordinator') {
      try {
        const applied = unwrapRPC(await agentMailRPC(exec, 'set_contact_policy', {
          project_key: cwd,
          agent_name: agentName,
          policy: 'auto',
        }));
        if (applied !== null) {
          contactPolicyApplied = true;
        } else {
          const msg = 'set_contact_policy returned null — session continues with default policy';
          log.warn(msg, { code: 'agent_mail_unreachable', agent: agentName });
          warnings.push(msg);
        }
      } catch (err) {
        // Defensive: unwrapRPC itself should not throw, but any unexpected
        // failure must not kill the coordinator session.
        const msg = errMsg(err);
        log.warn('set_contact_policy failed', { code: 'agent_mail_unreachable', agent: agentName, cause: msg });
        warnings.push(`set_contact_policy failed: ${msg}`);
      }
    }

    return { session, contactPolicyApplied, warnings };
  })();

  _bootstrapInFlight.set(key, pending);
  // Clear the slot once settled, but only if our Promise is still the current
  // occupant — another call that somehow landed during settlement shouldn't
  // have its slot wiped.
  pending.finally(() => {
    if (_bootstrapInFlight.get(key) === pending) {
      _bootstrapInFlight.delete(key);
    }
  }).catch(() => {
    // Swallow: the original pending Promise's rejection propagates to the
    // caller via the returned value; this .catch only guards the .finally
    // chain itself.
  });

  return pending;
}
