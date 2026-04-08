import { execFileSync } from "child_process";

// ─── Types ──────────────────────────────────────────────────

export interface MemoryEntry {
  /** 1-based index for user-facing display */
  index: number;
  /** Bullet ID from CASS (e.g. "b-8f3a2c") */
  id: string;
  /** Category tag */
  category: string;
  /** Entry content */
  content: string;
}

export interface MemoryStats {
  entryCount: number;
  cassAvailable: boolean;
  overallStatus: string | null;
  version: string | null;
}

export interface CassContext {
  relevantBullets: Array<{ id: string; text: string; score?: number; category?: string }>;
  antiPatterns: Array<{ id: string; text: string }>;
  historySnippets: Array<{ text: string; source?: string }>;
  suggestedCassQueries: string[];
  degraded: Record<string, unknown> | null;
}

// ─── CASS Detection ─────────────────────────────────────────

let _cassAvailable: boolean | null = null;
let _cassCheckedAt = 0;
const CASS_FALSE_CACHE_MS = 5_000;

function probeCass(args: string[]): boolean {
  try {
    execFileSync("cm", args, { timeout: 3000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if cm CLI is available.
 *
 * We cache successful detection aggressively, but only cache failures briefly.
 * This avoids a stale false-negative when cm becomes available after startup
 * or when one specific probe (`cm --version`) fails in a shell/environment
 * even though the CLI itself is usable.
 */
export function detectCass(): boolean {
  const now = Date.now();
  if (_cassAvailable === true) return true;
  if (_cassAvailable === false && now - _cassCheckedAt < CASS_FALSE_CACHE_MS) {
    return false;
  }

  const available = probeCass(["--version"]) || probeCass(["--help"]);
  _cassAvailable = available;
  _cassCheckedAt = now;
  return available;
}

/** Reset detection cache (for testing). */
export function resetCassDetection(): void {
  _cassAvailable = null;
  _cassCheckedAt = 0;
}

// ─── Helpers ────────────────────────────────────────────────

function runCm(args: string[], cwd?: string): string | null {
  try {
    const result = execFileSync("cm", args, {
      timeout: 10000,
      stdio: "pipe",
      cwd,
      encoding: "utf8",
    });
    return result;
  } catch {
    return null;
  }
}

function parseCmJson<T>(output: string | null): T | null {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output);
    return parsed?.success ? (parsed.data as T) : null;
  } catch {
    return null;
  }
}

// ─── Core API ───────────────────────────────────────────────

/**
 * Get CASS context for a task — relevance-scored bullets, anti-patterns, history.
 * Returns null if cm unavailable.
 */
export function getContext(task: string, cwd?: string): CassContext | null {
  if (!detectCass()) return null;
  const output = runCm(["context", task, "--json"], cwd);
  return parseCmJson<CassContext>(output);
}

/**
 * Read memory as a formatted string for injection into prompts.
 * Returns relevant bullets for the given task, or empty string if unavailable.
 */
export function readMemory(cwd: string, task?: string): string {
  if (!detectCass()) return "";
  const ctx = getContext(task || "orchestration session", cwd);
  if (!ctx) return "";

  const parts: string[] = [];
  if (ctx.relevantBullets.length > 0) {
    parts.push("### Relevant Rules");
    for (const b of ctx.relevantBullets) {
      parts.push(`- [${b.id}] ${b.text}`);
    }
  }
  if (ctx.antiPatterns.length > 0) {
    parts.push("\n### Anti-Patterns");
    for (const ap of ctx.antiPatterns) {
      parts.push(`- [${ap.id}] ${ap.text}`);
    }
  }
  if (ctx.historySnippets.length > 0) {
    parts.push("\n### History Snippets");
    for (const h of ctx.historySnippets) {
      parts.push(`- ${h.text}`);
    }
  }
  return parts.join("\n");
}

/**
 * Add a learning to the CASS playbook.
 * Replaces the old appendMemory (flat file append).
 */
export function appendMemory(cwd: string, entry: string, category?: string): boolean {
  if (!detectCass()) return false;
  const args = ["add", entry, "--json"];
  if (category) args.push("--category", category);
  const output = runCm(args, cwd);
  return parseCmJson(output) !== null;
}

/**
 * List all playbook entries.
 */
export function listMemoryEntries(cwd?: string): MemoryEntry[] {
  if (!detectCass()) return [];
  const output = runCm(["ls", "--json"], cwd);
  interface CmBullet { id: string; text: string; category?: string }
  const data = parseCmJson<{ bullets: CmBullet[] } | CmBullet[]>(output);
  if (!data) return [];
  const bullets = Array.isArray(data) ? data : (data.bullets ?? []);
  return bullets.map((b, i) => ({
    index: i + 1,
    id: b.id,
    category: b.category ?? "general",
    content: b.text,
  }));
}

/**
 * Search memory entries by query using CASS similar command.
 */
export function searchMemory(cwd: string, query: string): MemoryEntry[] {
  if (!detectCass()) return [];
  const output = runCm(["similar", query, "--json"], cwd);
  interface CmResult { id?: string; text: string; score?: number; category?: string }
  const data = parseCmJson<{ results: CmResult[] }>(output);
  if (!data?.results) return [];
  return data.results.map((r, i) => ({
    index: i + 1,
    id: r.id ?? `r-${i}`,
    category: r.category ?? "general",
    content: r.text,
  }));
}

/**
 * Mark a CASS rule as helpful or harmful.
 */
export function markRule(bulletId: string, helpful: boolean, reason?: string, cwd?: string): boolean {
  if (!detectCass()) return false;
  const args = ["mark", bulletId, helpful ? "--helpful" : "--harmful", "--json"];
  if (reason) args.push("--reason", reason);
  const output = runCm(args, cwd);
  return parseCmJson(output) !== null;
}

/**
 * Run `cm onboard` to bootstrap memory for a new project.
 * Should be called once when starting orchestration on a project that has no
 * existing CASS memory. Best-effort — returns true if successful.
 */
export function onboardMemory(cwd?: string): boolean {
  if (!detectCass()) return false;
  const status = runCm(["onboard", "status", "--json"], cwd);
  let data: { needsOnboarding?: boolean } | null = null;
  if (status) {
    try {
      const raw = JSON.parse(status);
      data = raw?.success ? (raw.data ?? null) : raw;
    } catch { /* fall through */ }
  }
  if (data?.needsOnboarding === false) return true; // already onboarded
  // Run non-interactive onboard
  const result = runCm(["onboard", "--auto"], cwd);
  return result !== null;
}

/**
 * Run `cm reflect` to mine raw session logs for procedural patterns.
 * This is the between-session distillation step: it extracts rules from
 * what actually happened (guide §10: "cm reflect between sessions").
 * Best-effort — returns true if cm ran successfully, false otherwise.
 */
export function reflectMemory(cwd?: string): boolean {
  if (!detectCass()) return false;
  const result = runCm(["reflect"], cwd);
  return result !== null;
}

/**
 * Mine CASS session history for planning-related patterns and return a
 * structured skill-refinement report. Uses `cm search` to find sessions
 * that involved planning activity, then extracts recurring patterns.
 * Returns null if cm unavailable or no relevant sessions found.
 */
export function mineSkillGaps(
  cwd: string,
  topic: string = "planning beads orchestration"
): string | null {
  if (!detectCass()) return null;
  const output = runCm(["search", topic, "--json", "--limit", "20"], cwd);
  if (!output) return null;
  try {
    const data = JSON.parse(output);
    const sessions = (data?.results ?? data?.sessions ?? []) as Array<{ text?: string; content?: string; score?: number }>;
    if (sessions.length === 0) return null;
    const snippets = sessions
      .slice(0, 10)
      .map((s, i) => `Session ${i + 1}:\n${(s.text ?? s.content ?? "").slice(0, 500)}`)
      .join("\n\n---\n\n");
    return snippets;
  } catch {
    return null;
  }
}

/**
 * Run the skill-refiner meta-pattern: given a skill file path and optional
 * CASS session data, return a prompt for rewriting the skill.
 * This is the recursive self-improvement pattern from the guide §10.
 */
export function skillRefinerPrompt(
  skillContent: string,
  skillName: string,
  sessionSnippets?: string
): string {
  return `## Skill Refiner — ${skillName}\n\nYou are improving a skill file based on real usage data from past sessions.\n\n### Current Skill\n\`\`\`\n${skillContent}\n\`\`\`\n\n${sessionSnippets ? `### Session Evidence (what actually happened when agents used this skill)\n\n${sessionSnippets}\n\n` : ""}### Instructions\n1. Identify places where the skill's instructions were ambiguous, incomplete, or wrong based on the evidence\n2. Find patterns agents invented as workarounds (these reveal gaps in the skill)\n3. Add missing anti-patterns, gotchas, or tool-specific quirks\n4. Sharpen vague instructions to be concrete and actionable\n5. Output the FULL improved skill text — not just diffs\n\nBe aggressive about incorporating evidence. A skill that reflects real failure modes is worth 10x a theoretically correct one.\n\nUse ultrathink.`;
}

/**
 * Get memory system stats.
 */
export function getMemoryStats(cwd?: string): MemoryStats {
  if (!detectCass()) {
    return { entryCount: 0, cassAvailable: false, overallStatus: null, version: null };
  }
  const output = runCm(["doctor", "--json"], cwd);
  interface DoctorData { version?: string; overallStatus?: string }
  const data = parseCmJson<DoctorData>(output);

  const statsOutput = runCm(["stats", "--json"], cwd);
  interface StatsData { totalBullets?: number; bulletCount?: number }
  const statsData = parseCmJson<StatsData>(statsOutput);

  return {
    entryCount: statsData?.totalBullets ?? statsData?.bulletCount ?? 0,
    cassAvailable: true,
    overallStatus: data?.overallStatus ?? null,
    version: data?.version ?? null,
  };
}
