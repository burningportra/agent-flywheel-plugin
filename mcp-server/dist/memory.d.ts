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
    relevantBullets: Array<{
        id: string;
        text: string;
        score?: number;
        category?: string;
    }>;
    antiPatterns: Array<{
        id: string;
        text: string;
    }>;
    historySnippets: Array<{
        text: string;
        source?: string;
    }>;
    suggestedCassQueries: string[];
    degraded: Record<string, unknown> | null;
}
/**
 * Check if cm CLI is available.
 *
 * We cache successful detection aggressively, but only cache failures briefly.
 * This avoids a stale false-negative when cm becomes available after startup
 * or when one specific probe (`cm --version`) fails in a shell/environment
 * even though the CLI itself is usable.
 */
export declare function detectCass(): boolean;
/** Reset detection cache (for testing). */
export declare function resetCassDetection(): void;
/**
 * Get CASS context for a task — relevance-scored bullets, anti-patterns, history.
 * Returns null if cm unavailable.
 */
export declare function getContext(task: string, cwd?: string): CassContext | null;
/**
 * Read memory as a formatted string for injection into prompts.
 * Returns relevant bullets for the given task, or empty string if unavailable.
 */
export declare function readMemory(cwd: string, task?: string): string;
/**
 * Add a learning to the CASS playbook.
 * Replaces the old appendMemory (flat file append).
 */
export declare function appendMemory(cwd: string, entry: string, category?: string): boolean;
/**
 * List all playbook entries.
 */
export declare function listMemoryEntries(cwd?: string): MemoryEntry[];
/**
 * Search memory entries by query using CASS context command.
 * Uses `cm context` (task-aware semantic matching) instead of `cm similar`
 * (keyword mode) which returns empty for most queries.
 */
export declare function searchMemory(cwd: string, query: string): MemoryEntry[];
/**
 * Mark a CASS rule as helpful or harmful.
 */
export declare function markRule(bulletId: string, helpful: boolean, reason?: string, cwd?: string): boolean;
/**
 * Run `cm onboard` to bootstrap memory for a new project.
 * Should be called once when starting flywheel on a project that has no
 * existing CASS memory. Best-effort — returns true if successful.
 */
export declare function onboardMemory(cwd?: string): boolean;
/**
 * Run `cm reflect` to mine raw session logs for procedural patterns.
 * This is the between-session distillation step: it extracts rules from
 * what actually happened (guide §10: "cm reflect between sessions").
 * Best-effort — returns true if cm ran successfully, false otherwise.
 */
export declare function reflectMemory(cwd?: string): boolean;
/**
 * Mine CASS session history for planning-related patterns and return a
 * structured skill-refinement report. Uses `cm search` to find sessions
 * that involved planning activity, then extracts recurring patterns.
 * Returns null if cm unavailable or no relevant sessions found.
 */
export declare function mineSkillGaps(cwd: string, topic?: string): string | null;
/**
 * Run the skill-refiner meta-pattern: given a skill file path and optional
 * CASS session data, return a prompt for rewriting the skill.
 * This is the recursive self-improvement pattern from the guide §10.
 */
export declare function skillRefinerPrompt(skillContent: string, skillName: string, sessionSnippets?: string): string;
/**
 * Get memory system stats.
 */
export declare function getMemoryStats(cwd?: string): MemoryStats;
//# sourceMappingURL=memory.d.ts.map