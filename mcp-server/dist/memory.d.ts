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
//# sourceMappingURL=memory.d.ts.map