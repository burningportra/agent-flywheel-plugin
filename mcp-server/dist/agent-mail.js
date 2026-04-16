import { createLogger } from "./logger.js";
import { parseAgentMailResponse } from "./parsers.js";
const log = createLogger("agent-mail");
export const AGENT_MAIL_URL = "http://127.0.0.1:8765";
/**
 * Call an agent-mail MCP tool via its JSON-RPC HTTP endpoint.
 * Used by the agent-flywheel itself (not sub-agents) to manage projects/reservations.
 *
 * Returns a discriminated union: `{ ok: true, data }` on success,
 * `{ ok: false, error }` with a classified error kind on failure.
 */
export async function agentMailRPC(exec, toolName, args) {
    const body = JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: toolName, arguments: args },
    });
    let result;
    try {
        result = await exec("curl", [
            "-s", "-X", "POST", `${AGENT_MAIL_URL}/api`,
            "-H", "Content-Type: application/json",
            "-d", body,
            "--max-time", "5",
        ], { timeout: 8000 });
    }
    catch (err) {
        return {
            ok: false,
            error: {
                kind: "timeout",
                message: err?.message ?? "exec timed out",
            },
        };
    }
    // curl exit non-zero → network error
    if (result.code !== 0) {
        return {
            ok: false,
            error: {
                kind: "network",
                message: `curl exited with code ${result.code}`,
                code: result.code,
                stderr: result.stderr || undefined,
            },
        };
    }
    // Parse and validate JSON-RPC response
    const parsed = parseAgentMailResponse(result.stdout);
    if (!parsed.ok) {
        // Determine error kind from the parser error message
        const isRpcError = parsed.error.startsWith("RPC error:");
        return {
            ok: false,
            error: {
                kind: isRpcError ? "rpc_error" : "parse",
                message: parsed.error,
                stderr: isRpcError ? undefined : result.stdout.slice(0, 200) || undefined,
            },
        };
    }
    // Extract data — agent-mail wraps actual payload in structuredContent
    const rpcResult = parsed.data;
    const data = (rpcResult != null && typeof rpcResult === "object" && "structuredContent" in rpcResult
        ? rpcResult.structuredContent
        : rpcResult);
    if (data == null) {
        return {
            ok: false,
            error: {
                kind: "empty_response",
                message: `No data in response for ${toolName}`,
            },
        };
    }
    return { ok: true, data };
}
/**
 * Backward-compatible unwrapper: extracts data from AgentMailResult
 * or returns null on error (matching the old agentMailRPC return contract).
 */
export function unwrapRPC(result) {
    if (!result.ok) {
        log.warn("agent-mail RPC failed", { kind: result.error.kind, message: result.error.message });
        return null;
    }
    return result.data;
}
/**
 * Read an agent-mail MCP resource via the same JSON-RPC HTTP endpoint.
 */
export async function agentMailReadResource(exec, uri) {
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
    const outer = parseAgentMailResponse(result.stdout);
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
            }
            catch {
                return content;
            }
        }
        return rpcResult?.contents ?? rpcResult ?? null;
    }
    catch {
        return null;
    }
}
/**
 * Ensure project exists in agent-mail. Called once during flywheel_profile.
 */
export async function ensureAgentMailProject(exec, cwd) {
    await agentMailRPC(exec, "ensure_project", { human_key: cwd }).then(unwrapRPC);
}
async function getAgentMailProjectSlug(exec, cwd) {
    const project = unwrapRPC(await agentMailRPC(exec, "ensure_project", { human_key: cwd }));
    const slug = project?.project?.slug ?? project?.slug;
    return typeof slug === "string" && slug.length > 0 ? slug : null;
}
export function matchesReservationPath(file, reservation) {
    const rawPattern = reservation.path_pattern ?? reservation.path;
    if (typeof rawPattern !== "string" || rawPattern.length === 0)
        return false;
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
export function normalizeReservations(payload) {
    if (Array.isArray(payload))
        return payload;
    if (Array.isArray(payload?.reservations))
        return payload.reservations;
    if (Array.isArray(payload?.items))
        return payload.items;
    return [];
}
/**
 * Reserve files for an agent before launch/hand-off.
 */
export async function reserveFileReservations(exec, cwd, agentName, files, reason) {
    return unwrapRPC(await agentMailRPC(exec, "file_reservation_paths", {
        project_key: cwd,
        agent_name: agentName,
        paths: files,
        ttl_seconds: 3600,
        exclusive: true,
        ...(reason ? { reason } : {}),
    }));
}
/**
 * Release file reservations for an agent during cleanup.
 */
export async function releaseFileReservations(exec, cwd, agentName, files) {
    return unwrapRPC(await agentMailRPC(exec, "release_file_reservations", {
        project_key: cwd,
        agent_name: agentName,
        ...(files && files.length > 0 ? { paths: files } : {}),
    }));
}
/**
 * Check whether any requested files are already reserved by another agent.
 */
export async function checkFileReservations(exec, cwd, files, agentName) {
    if (files.length === 0)
        return [];
    const slug = await getAgentMailProjectSlug(exec, cwd);
    if (!slug)
        return [];
    const resource = await agentMailReadResource(exec, `resource://file_reservations/${slug}?active_only=true`);
    const reservations = normalizeReservations(resource);
    return reservations.filter((reservation) => {
        if (reservation.active === false)
            return false;
        if (agentName && reservation.agent_name === agentName)
            return false;
        return files.some((file) => matchesReservationPath(file, reservation));
    });
}
/**
 * Call macro_prepare_thread — join an existing thread with context summary.
 * Use when spawning review agents that need to participate in an existing bead thread.
 */
export async function prepareThread(exec, cwd, agentName, threadId) {
    return unwrapRPC(await agentMailRPC(exec, "macro_prepare_thread", {
        human_key: cwd,
        agent_name: agentName,
        thread_id: threadId,
    }));
}
/**
 * Call macro_file_reservation_cycle — reserve files, do work, auto-release.
 * Returns a reservation ID that can be used to track the reservation.
 */
export async function fileReservationCycle(exec, cwd, agentName, files, reason) {
    return unwrapRPC(await agentMailRPC(exec, "macro_file_reservation_cycle", {
        human_key: cwd,
        agent_name: agentName,
        paths: files,
        ttl_seconds: 3600,
        exclusive: true,
        ...(reason ? { reason } : {}),
    }));
}
/**
 * Call macro_contact_handshake — set up cross-agent contact for DM communication.
 */
export async function contactHandshake(exec, cwd, fromAgent, toAgent) {
    return unwrapRPC(await agentMailRPC(exec, "macro_contact_handshake", {
        human_key: cwd,
        from_agent: fromAgent,
        to_agent: toAgent,
    }));
}
// ─── Reservation Lifecycle ─────────────────────────────────────
/**
 * Renew (extend) file reservations for an agent.
 * Use when an agent's work takes longer than the original TTL.
 */
export async function renewFileReservations(exec, cwd, agentName, extendSeconds = 1800) {
    return unwrapRPC(await agentMailRPC(exec, "renew_file_reservations", {
        project_key: cwd,
        agent_name: agentName,
        extend_seconds: extendSeconds,
    }));
}
/**
 * Force-release a stale reservation from a crashed or stuck agent.
 * Optionally notifies the previous holder.
 */
export async function forceReleaseFileReservation(exec, cwd, agentName, reservationId, note, notifyPrevious = true) {
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
export async function sendMessage(exec, cwd, senderName, to, subject, body, options) {
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
 * Reply to a message preserving thread context.
 */
export async function replyMessage(exec, cwd, messageId, senderName, body) {
    return unwrapRPC(await agentMailRPC(exec, "reply_message", {
        project_key: cwd,
        message_id: messageId,
        sender_name: senderName,
        body_md: body,
    }));
}
/**
 * Acknowledge a message (marks as read + acknowledged).
 */
export async function acknowledgeMessage(exec, cwd, agentName, messageId) {
    return unwrapRPC(await agentMailRPC(exec, "acknowledge_message", {
        project_key: cwd,
        agent_name: agentName,
        message_id: messageId,
    }));
}
/**
 * Fetch inbox for an agent.
 */
export async function fetchInbox(exec, cwd, agentName, options) {
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
 * Search messages via FTS5 full-text search.
 */
export async function searchMessages(exec, cwd, query, limit = 20) {
    const result = unwrapRPC(await agentMailRPC(exec, "search_messages", {
        project_key: cwd,
        query,
        limit,
    }));
    return result?.messages ?? result?.results ?? [];
}
/**
 * Summarize a thread — extracts key points and action items via LLM.
 * Useful for handoffs and review agents joining existing threads.
 */
export async function summarizeThread(exec, cwd, threadId) {
    return unwrapRPC(await agentMailRPC(exec, "summarize_thread", {
        project_key: cwd,
        thread_id: threadId,
        include_examples: true,
        llm_mode: true,
    }));
}
/**
 * Get agent profile with recent commits.
 */
export async function whoisAgent(exec, cwd, agentName) {
    return unwrapRPC(await agentMailRPC(exec, "whois", {
        project_key: cwd,
        agent_name: agentName,
        include_recent_commits: true,
        commit_limit: 5,
    }));
}
// ─── Build Slots ───────────────────────────────────────────────
/**
 * Acquire an advisory build slot (e.g. "dev-server", "watcher", "build").
 * Prevents multiple agents from running conflicting long-lived processes.
 */
export async function acquireBuildSlot(exec, cwd, agentName, slot, ttlSeconds = 3600, exclusive = true) {
    return unwrapRPC(await agentMailRPC(exec, "acquire_build_slot", {
        project_key: cwd,
        agent_name: agentName,
        slot,
        ttl_seconds: ttlSeconds,
        exclusive,
    }));
}
/**
 * Renew (extend) a build slot TTL.
 */
export async function renewBuildSlot(exec, cwd, agentName, slot, extendSeconds = 1800) {
    return unwrapRPC(await agentMailRPC(exec, "renew_build_slot", {
        project_key: cwd,
        agent_name: agentName,
        slot,
        extend_seconds: extendSeconds,
    }));
}
/**
 * Release a build slot when done.
 */
export async function releaseBuildSlot(exec, cwd, agentName, slot) {
    return unwrapRPC(await agentMailRPC(exec, "release_build_slot", {
        project_key: cwd,
        agent_name: agentName,
        slot,
    }));
}
// ─── Health ────────────────────────────────────────────────────
/**
 * Check Agent Mail server health via MCP tool.
 * Returns { status: "healthy" } on success, null on failure.
 */
export async function healthCheck(exec) {
    const result = unwrapRPC(await agentMailRPC(exec, "health_check", {}));
    return result?.status ? result : null;
}
/**
 * Install the pre-commit guard via the MCP tool (preferred over manual scaffolding).
 */
export async function installPreCommitGuardViaMCP(exec, cwd) {
    return unwrapRPC(await agentMailRPC(exec, "install_precommit_guard", {
        project_key: cwd,
        code_repo_path: cwd,
    }));
}
/**
 * Build a JSON-RPC curl command string for agent-mail.
 */
export function amRpcCmd(tool, args) {
    const body = JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
    });
    return `curl -s -X POST ${AGENT_MAIL_URL}/api -H 'Content-Type: application/json' -d '${body.replace(/'/g, "'\\''")}'`;
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
export function shellSingleQuote(s) {
    return "'" + s.replace(/'/g, "'\\''") + "'";
}
/**
 * Build a bash helper script that wraps agent-mail calls.
 * Sub-agents source this to get am_send, am_inbox, am_release functions
 * with their agent name and project key baked in — no manual substitution needed.
 */
export function amHelperScript(cwd, threadId) {
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
/**
 * Generates an agent-mail bootstrap preamble for a parallel sub-agent's task.
 * Uses a bash helper script approach — sub-agents get am_send/am_inbox/am_release
 * functions with correct field names baked in. No manual JSON construction needed.
 */
export function agentMailTaskPreamble(cwd, _agentName, stepDesc, artifacts, threadId, mode = "worktree") {
    const safeDesc = stepDesc.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\n/g, '\\n');
    const startSessionCmd = amRpcCmd("macro_start_session", {
        human_key: cwd, program: "claude-subagent", model: "auto",
        task_description: safeDesc,
        file_reservation_paths: artifacts,
        inbox_limit: 5,
    });
    const helperScript = amHelperScript(cwd, threadId);
    const gitWorkflowInstructions = mode === "single-branch"
        ? `
### Single-branch git workflow (MANDATORY)
You are working directly on the shared branch in the main checkout.
- Before editing, sync first: \`git pull --rebase\`
- After finishing and before your final summary, commit only your bead changes with a clear message, then push immediately:
  - \`git add <your-files> && git commit -m "bead <id>: <summary>"\`
  - \`git push\`
- If \`git pull --rebase\`, \`git rebase --continue\`, or \`git push\` reports conflicts or a non-fast-forward error, STOP immediately.
- Do not force-push, do not merge, and do not try to untangle another agent's changes unless explicitly instructed.
- Report the conflict in your summary / agent-mail update so the agent-flywheel can decide the next step.
`
        : "";
    return `## Agent Mail Coordination — MANDATORY
You are coordinating with other parallel agents via agent-mail.
You MUST follow ALL steps below. Do NOT skip any.

### Step 1: Bootstrap (run FIRST, before ANY work)
\`\`\`bash
BOOTSTRAP_RESULT=$(${startSessionCmd})
echo "$BOOTSTRAP_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['result']['structuredContent']['agent']['name'])" 2>/dev/null
\`\`\`
Copy the agent name from the output (e.g. "VioletLantern") and set it:
\`\`\`bash
export AM_AGENT_NAME="<paste your agent name here>"
\`\`\`

### Step 2: Set up helper functions
\`\`\`bash
${helperScript}
\`\`\`

### Step 3: Announce start
\`\`\`bash
am_send "Starting: ${safeDesc.slice(0, 60)}" "Working on: ${safeDesc.slice(0, 100)}. Files: ${artifacts.join(", ")}"
\`\`\`

### Step 4: Check inbox (do this BEFORE starting work)
\`\`\`bash
# Check for urgent messages first
am_inbox_urgent | python3 -c "import json,sys; d=json.load(sys.stdin); msgs=d.get('result',{}).get('structuredContent',{}).get('messages',[]); [print(f'URGENT FROM {m[\"sender_name\"]}: {m[\"subject\"]}') for m in msgs]" 2>/dev/null
# Then check full inbox
am_inbox | python3 -c "import json,sys; d=json.load(sys.stdin); msgs=d.get('result',{}).get('structuredContent',{}).get('messages',[]); [print(f'FROM {m[\"sender_name\"]}: {m[\"subject\"]} (id={m[\"id\"]}, ack={m.get(\"ack_required\",False)})') for m in msgs]" 2>/dev/null
\`\`\`
If there are messages from other agents, read them. For messages with ack_required=True, acknowledge:
\`\`\`bash
am_ack <message_id>
\`\`\`
To reply in-thread to a specific message:
\`\`\`bash
am_reply <message_id> "Your reply here"
\`\`\`
${gitWorkflowInstructions}
### Step 5: Do your work (implement the bead)

### Step 6: Check inbox again BEFORE finishing
\`\`\`bash
am_inbox | python3 -c "import json,sys; d=json.load(sys.stdin); msgs=d.get('result',{}).get('structuredContent',{}).get('messages',[]); [print(f'FROM {m[\"sender_name\"]}: {m[\"subject\"]}\\n  {m.get(\"body_md\",\"\")[:200]}') for m in msgs]" 2>/dev/null
\`\`\`
Respond to any messages that need a response.

### Step 7: Send completion summary + release reservations
\`\`\`bash
am_send "Done: ${safeDesc.slice(0, 60)}" "YOUR_SUMMARY_HERE — replace this with what you actually did"
am_release
\`\`\`

### Available helper functions reference
| Function | Usage | Purpose |
|----------|-------|--------|
| am_send | am_send "subject" "body" [importance] | Send to thread (importance: low/normal/high/urgent) |
| am_dm | am_dm "AgentName" "subject" "body" [importance] | Direct message to specific agent |
| am_inbox | am_inbox | Fetch all inbox messages |
| am_inbox_urgent | am_inbox_urgent | Fetch only urgent messages |
| am_ack | am_ack MESSAGE_ID | Acknowledge a message |
| am_reply | am_reply MESSAGE_ID "body" | Reply in-thread to a message |
| am_search | am_search "query" | FTS5 search past messages |
| am_release | am_release | Release all file reservations |
| am_renew | am_renew [seconds] | Extend reservation TTL (default 1800s) |
| am_whois | am_whois "AgentName" | Get agent profile + recent commits |
| am_join_thread | am_join_thread "thread-id" | Join an existing thread with context |
| am_summarize_thread | am_summarize_thread "thread-id" | Get LLM summary of a thread |

---

`;
}
// ─── New helper functions (agent-flywheel additions) ─────
/**
 * Register the agent-flywheel as a named agent in agent-mail.
 * Call this once during flywheel_profile before any sub-agent spawning.
 */
export async function registerFlywheelAgent(exec, cwd, agentName = 'FlywheelAgent') {
    return unwrapRPC(await agentMailRPC(exec, 'register_agent', { project_key: cwd, agent_name: agentName }));
}
/**
 * Start a full agent-mail session (register, bootstrap, set up file reservations).
 * Replaces bare ensureAgentMailProject() in flywheel_profile.
 */
export async function agentMailStartSession(exec, cwd, agentName = 'FlywheelAgent') {
    return unwrapRPC(await agentMailRPC(exec, 'macro_start_session', {
        human_key: cwd,
        program: 'agent-flywheel',
        model: 'auto',
        task_description: 'Orchestrating agentic coding flywheel',
        inbox_limit: 10,
        agent_name: agentName,
    }));
}
/**
 * Send a bead completion message to the bead's thread.
 * Call in flywheel_approve_beads when a bead result = success.
 */
export async function sendBeadCompletionMessage(exec, cwd, beadId, senderName, summary) {
    return unwrapRPC(await agentMailRPC(exec, 'send_message', {
        project_key: cwd,
        sender_name: senderName,
        to: [],
        subject: `Bead ${beadId} complete`,
        body_md: summary,
        thread_id: beadId,
        importance: 'normal',
    }));
}
/**
 * Acknowledge a batch of message IDs. Called in /flywheel-status after inbox read.
 */
export async function acknowledgeMessages(exec, cwd, agentName, messageIds) {
    await Promise.all(messageIds.map(id => acknowledgeMessage(exec, cwd, agentName, id)));
}
/**
 * Fetch inbox messages for the flywheel agent.
 */
export async function fetchInboxMessages(exec, cwd, agentName = 'FlywheelAgent') {
    return fetchInbox(exec, cwd, agentName, { limit: 20, includeBodies: true });
}
//# sourceMappingURL=agent-mail.js.map