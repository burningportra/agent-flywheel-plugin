import { existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { onboardMemory } from "./memory.js";

// ─── Core Rules ─────────────────────────────────────────────
// Mandatory behavioral constraints for multi-agent coordination.

const CORE_RULES_SECTION = `
## Core Rules

1. **Rule 0 — Override Prerogative**: The human's instructions override everything in this document.
2. **Rule 1 — No File Deletion**: Never delete files without explicit human permission.
3. **Rule 2 — No Destructive Git**: \`git reset --hard\`, \`git clean -fd\`, \`rm -rf\` are absolutely forbidden.
4. **Rule 3 — Branch Policy**: All work happens on the designated branch (usually \`main\`). Never create feature branches unless explicitly told to.
5. **Rule 4 — No Script-Based Code Changes**: Always make code changes manually via edit tools. No \`sed\`/\`awk\`/\`perl\` one-liners on source files.
6. **Rule 5 — No File Proliferation**: No \`mainV2.ts\`, \`main_improved.ts\`, \`backup_main.ts\` variants. One canonical file per concern.
7. **Rule 6 — Verify After Changes**: Always run the project's build/type-check/lint after modifying code. Verify no errors were introduced.
8. **Rule 7 — Multi-Agent Awareness**: Never stash, revert, or overwrite other agents' changes. Treat unfamiliar changes as if you made them and forgot.
`;

const CORE_RULES_MARKER = "## Core Rules";

// Keywords for each rule — used by scoreAgentsMd to check presence
const CORE_RULE_KEYWORDS = [
  "override",          // Rule 0
  "no file deletion",  // Rule 1
  "destructive git",   // Rule 2
  "branch policy",     // Rule 3
  "script-based",      // Rule 4
  "file proliferation",// Rule 5
  "verify after",      // Rule 6
  "multi-agent",       // Rule 7
];

const AGENT_MAIL_SECTION = `
## MCP Agent Mail: coordination for multi-agent workflows

What it is
- A mail-like layer that lets coding agents coordinate asynchronously via MCP tools and resources.
- Provides identities, inbox/outbox, searchable threads, and advisory file reservations, with human-auditable artifacts in Git.

Why it's useful
- Prevents agents from stepping on each other with explicit file reservations (leases) for files/globs.
- Keeps communication out of your token budget by storing messages in a per-project archive.
- Offers quick reads (\`resource://inbox/...\`, \`resource://thread/...\`) and macros that bundle common flows.

How to use effectively
1) Same repository
   - Register an identity: call \`ensure_project\`, then \`register_agent\` using this repo's absolute path as \`project_key\`.
   - Reserve files before you edit: \`file_reservation_paths(project_key, agent_name, ["src/**"], ttl_seconds=3600, exclusive=true)\` to signal intent and avoid conflict.
   - Communicate with threads: use \`send_message(..., thread_id="FEAT-123")\`; check inbox with \`fetch_inbox\` and acknowledge with \`acknowledge_message\`.
   - Read fast: \`resource://inbox/{Agent}?project=<abs-path>&limit=20\` or \`resource://thread/{id}?project=<abs-path>&include_bodies=true\`.
   - Tip: set \`AGENT_NAME\` in your environment so the pre-commit guard can block commits that conflict with others' active exclusive file reservations.

2) Across different repos in one project
   - Option A (single project bus): register both sides under the same \`project_key\`. Keep reservation patterns specific (e.g., \`frontend/**\` vs \`backend/**\`).
   - Option B (separate projects): each repo has its own \`project_key\`; use \`macro_contact_handshake\` or \`request_contact\`/\`respond_contact\` to link agents, then message directly.

Macros vs granular tools
- Prefer macros when you want speed: \`macro_start_session\`, \`macro_prepare_thread\`, \`macro_file_reservation_cycle\`, \`macro_contact_handshake\`.
- Use granular tools when you need control: \`register_agent\`, \`file_reservation_paths\`, \`send_message\`, \`fetch_inbox\`, \`acknowledge_message\`.

Common pitfalls
- "from_agent not registered": always \`register_agent\` in the correct \`project_key\` first.
- "FILE_RESERVATION_CONFLICT": adjust patterns, wait for expiry, or use a non-exclusive reservation.

## Integrating with Beads (dependency-aware task planning)

Beads provides a lightweight, dependency-aware issue database and a CLI (\`br\`) for selecting "ready work," setting priorities, and tracking status. It complements MCP Agent Mail's messaging, audit trail, and file-reservation signals. Project: [steveyegge/beads](https://github.com/steveyegge/beads)

Recommended conventions
- **Single source of truth**: Use **Beads** for task status/priority/dependencies; use **Agent Mail** for conversation, decisions, and attachments (audit).
- **Shared identifiers**: Use the Beads issue id (e.g., \`bd-123\`) as the Mail \`thread_id\` and prefix message subjects with \`[bd-123]\`.
- **Reservations**: When starting a \`bd-###\` task, call \`file_reservation_paths(...)\` for the affected paths; include the issue id in the \`reason\` and release on completion.

Typical flow (agents)
1) **Pick ready work** (Beads)
   - \`br ready --json\` → choose one item (highest priority, no blockers)
2) **Reserve edit surface** (Mail)
   - \`file_reservation_paths(project_key, agent_name, ["src/**"], ttl_seconds=3600, exclusive=true, reason="bd-123")\`
3) **Announce start** (Mail)
   - \`send_message(..., thread_id="bd-123", subject="[bd-123] Start: <short title>", ack_required=true)\`
4) **Work and update**
   - Reply in-thread with progress and attach artifacts/images; keep the discussion in one thread per issue id
5) **Complete and release**
   - \`br close bd-123 --reason "Completed"\` (Beads is status authority)
   - \`release_file_reservations(project_key, agent_name, paths=["src/**"])\`
   - Final Mail reply: \`[bd-123] Completed\` with summary and links

Mapping cheat-sheet
- **Mail \`thread_id\`** ↔ \`bd-###\`
- **Mail subject**: \`[bd-###] …\`
- **File reservation \`reason\`**: \`bd-###\`
- **Commit messages (optional)**: include \`bd-###\` for traceability

Event mirroring (optional automation)
- On \`br update --status blocked\`, send a high-importance Mail message in thread \`bd-###\` describing the blocker.
- On Mail "ACK overdue" for a critical decision, add a Beads label (e.g., \`needs-ack\`) or bump priority to surface it in \`br ready\`.

Pitfalls to avoid
- Don't create or manage tasks in Mail; treat Beads as the single task queue.
- Always include \`bd-###\` in message \`thread_id\` to avoid ID drift across tools.
`;

const CASS_MEMORY_SECTION = `
## Memory System: cass-memory

The Cass Memory System (cm) is a tool for giving agents an effective memory based on the ability to quickly search across previous coding agent sessions across an array of different coding agent tools (e.g., Claude Code, Codex, Gemini-CLI, Cursor, etc) and projects (and even across multiple machines, optionally) and then reflect on what they find and learn in new sessions to draw out useful lessons and takeaways; these lessons are then stored and can be queried and retrieved later, much like how human memory works.

The \`cm onboard\` command guides you through analyzing historical sessions and extracting valuable rules.

### Quick Start

\`\`\`bash
# 1. Check status and see recommendations
cm onboard status

# 2. Get sessions to analyze (filtered by gaps in your playbook)
cm onboard sample --fill-gaps

# 3. Read a session with rich context
cm onboard read /path/to/session.jsonl --template

# 4. Add extracted rules (one at a time or batch)
cm playbook add "Your rule content" --category "debugging"
# Or batch add:
cm playbook add --file rules.json

# 5. Mark session as processed
cm onboard mark-done /path/to/session.jsonl
\`\`\`
`;

const BR_SECTION = `
## Beads CLI (br) — task tracking

br is the local task tracker. Tasks are stored in .beads/ JSONL files.

### Key commands
- \`br list --json\` — all beads
- \`br ready --json\` — unblocked beads (your work queue)
- \`br show <id>\` — full bead details
- \`br update <id> --status in_progress\` — claim a bead
- \`br update <id> --status closed\` — complete a bead
- \`br create --title "..." --description "..."\` — create a bead
- \`br dep add <id> <depends-on-id>\` — add dependency
- \`br sync --flush-only\` — export to JSONL before committing
- \`br dep cycles\` — verify no dependency cycles

### Conventions
- Always mark beads in_progress before starting work
- Always close beads before committing
- Use bead ID in commit messages: "bead br-123: summary"
- Run \`br sync --flush-only && git add .beads/\` before committing
`;

const BV_SECTION = `
## Beads Viewer (bv) — graph-theory task compass

bv analyzes the bead dependency graph using PageRank, betweenness centrality, and critical-path analysis to tell you which bead to work on next.

### Key commands
- \`bv --robot-next\` — best single bead for one agent (PageRank + betweenness)
- \`bv --robot-triage\` — best beads for a swarm (routes agents to parallel-safe, non-contending beads)
- \`bv --robot-insights\` — full graph health report (bottlenecks, critical path, cycle detection)

### When to use which
- Solo agent: use \`bv --robot-next\`
- Multiple agents running in parallel: use \`bv --robot-triage\` to avoid all agents piling on the same bottleneck
- Stuck or unsure why progress is slow: run \`bv --robot-insights\` for graph diagnostics

Always prefer bv over \`br ready\` when bv is available — bv's graph-theoretic routing unlocks more downstream work.
`;

const BR_SECTION_MARKER = "## Beads CLI (br)";
const BV_SECTION_MARKER = "## Beads Viewer (bv)";

const SECTION_MARKER = "## MCP Agent Mail";
const CASS_SECTION_MARKER = "## Memory System: cass-memory";

const DEFAULT_HEADER = `# AGENTS.md

This file provides guidance for AI coding agents working in this repository.

`;

// ─── AGENTS.md Health Scoring ────────────────────────────────

export interface AgentsMdHealth {
  /** Overall health score 0-100. */
  score: number;
  /** Whether the 8 core rules are present. */
  hasCoreRules: boolean;
  /** Number of core rules detected (0-8). */
  coreRuleCount: number;
  /** Whether Agent Mail / coordination docs are present. */
  hasCoordination: boolean;
  /** Whether CASS memory section is present. */
  hasMemory: boolean;
  /** Whether Beads CLI (br) docs are present. */
  hasBr: boolean;
  /** Whether Beads Viewer (bv) docs are present. */
  hasBv: boolean;
  /** Missing sections that should be added. */
  missing: string[];
}

/**
 * Score an AGENTS.md file on completeness.
 * Returns a health assessment with 0-100 score and list of missing sections.
 */
export function scoreAgentsMd(cwd: string): AgentsMdHealth {
  const agentsMdPath = join(cwd, "AGENTS.md");

  if (!existsSync(agentsMdPath)) {
    return {
      score: 0,
      hasCoreRules: false,
      coreRuleCount: 0,
      hasCoordination: false,
      hasMemory: false,
      hasBr: false,
      hasBv: false,
      missing: ["AGENTS.md file", "Core Rules", "Agent Mail coordination", "CASS Memory", "Beads CLI (br) docs", "Beads Viewer (bv) docs"],
    };
  }

  const content = readFileSync(agentsMdPath, "utf-8").toLowerCase();
  const missing: string[] = [];

  // Check core rules (50% of score)
  let coreRuleCount = 0;
  for (const keyword of CORE_RULE_KEYWORDS) {
    if (content.includes(keyword.toLowerCase())) coreRuleCount++;
  }
  const hasCoreRules = coreRuleCount >= 6; // 6 of 8 is "has core rules"
  if (!hasCoreRules) missing.push(`Core Rules (${coreRuleCount}/8 detected)`);

  // Check coordination docs (25% of score)
  const hasCoordination = content.includes("agent mail") || content.includes("coordination");
  if (!hasCoordination) missing.push("Agent Mail coordination");

  // Check memory (15% of score)
  const hasMemory = content.includes("cass") || content.includes("memory system");
  if (!hasMemory) missing.push("CASS Memory");

  // Check Beads CLI br docs (10% of score)
  const hasBr = content.includes("br list") || content.includes("br ready") || content.includes("beads cli");
  if (!hasBr) missing.push("Beads CLI (br) docs");

  // Check Beads Viewer bv docs (10% of score)
  const hasBv = content.includes("bv --robot") || content.includes("beads viewer");
  if (!hasBv) missing.push("Beads Viewer (bv) docs");

  const score = Math.round(
    (coreRuleCount / 8) * 40 +
    (hasCoordination ? 25 : 0) +
    (hasMemory ? 15 : 0) +
    (hasBr ? 10 : 0) +
    (hasBv ? 10 : 0)
  );

  return { score, hasCoreRules, coreRuleCount, hasCoordination, hasMemory, hasBr, hasBv, missing };
}

/**
 * Ensure the Core Rules section is present in AGENTS.md.
 * If AGENTS.md doesn't exist, creates it with header + core rules.
 * If it exists but lacks core rules, appends them.
 * Idempotent — safe to call multiple times.
 */
export async function ensureCoreRules(cwd: string): Promise<void> {
  const agentsMdPath = join(cwd, "AGENTS.md");

  if (!existsSync(agentsMdPath)) {
    writeFileSync(agentsMdPath, DEFAULT_HEADER + CORE_RULES_SECTION.trimStart(), "utf-8");
    return;
  }

  const content = readFileSync(agentsMdPath, "utf-8");
  if (!content.includes(CORE_RULES_MARKER)) {
    // Insert core rules after the header (before other sections) for visibility
    appendFileSync(agentsMdPath, "\n" + CORE_RULES_SECTION.trimStart(), "utf-8");
  }
}

export async function ensureAgentMailSection(cwd: string): Promise<void> {
  const agentsMdPath = join(cwd, "AGENTS.md");

  if (!existsSync(agentsMdPath)) {
    writeFileSync(
      agentsMdPath,
      DEFAULT_HEADER +
        CORE_RULES_SECTION.trimStart() + "\n" +
        AGENT_MAIL_SECTION.trimStart() + "\n" +
        CASS_MEMORY_SECTION.trimStart() + "\n" +
        BR_SECTION.trimStart() + "\n" +
        BV_SECTION.trimStart(),
      "utf-8"
    );
    // Best-effort: bootstrap CASS memory for a new project
    onboardMemory(cwd);
    return;
  }

  let content = readFileSync(agentsMdPath, "utf-8");

  // Ensure core rules are present
  if (!content.includes(CORE_RULES_MARKER)) {
    appendFileSync(agentsMdPath, "\n" + CORE_RULES_SECTION.trimStart(), "utf-8");
    content += "\n" + CORE_RULES_SECTION.trimStart();
  }

  if (!content.includes(SECTION_MARKER)) {
    appendFileSync(agentsMdPath, "\n" + AGENT_MAIL_SECTION.trimStart(), "utf-8");
    content += "\n" + AGENT_MAIL_SECTION.trimStart();
  }

  if (!content.includes(CASS_SECTION_MARKER)) {
    appendFileSync(agentsMdPath, "\n" + CASS_MEMORY_SECTION.trimStart(), "utf-8");
    content += "\n" + CASS_MEMORY_SECTION.trimStart();
  }

  if (!content.includes(BR_SECTION_MARKER)) {
    appendFileSync(agentsMdPath, "\n" + BR_SECTION.trimStart(), "utf-8");
    content += "\n" + BR_SECTION.trimStart();
  }

  if (!content.includes(BV_SECTION_MARKER)) {
    appendFileSync(agentsMdPath, "\n" + BV_SECTION.trimStart(), "utf-8");
  }
}
