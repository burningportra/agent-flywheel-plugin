export interface EpisodicResult {
    text: string;
    similarity: number;
    wing: string;
    room: string;
    metadata?: Record<string, unknown>;
}
export interface EpisodicStats {
    available: boolean;
    palacePath: string | null;
    drawerCount: number;
}
/**
 * Check if python3 -m mempalace is available.
 *
 * Caches true permanently (process lifetime) — once found, always found.
 * Caches false briefly (5s) to avoid stale negatives if mempalace is installed
 * partway through a session.
 */
export declare function detectMempalace(): boolean;
/** Reset detection cache (for testing). */
export declare function resetMempalaceDetection(): void;
/**
 * Mine pi session transcripts into MemPalace under the given wing.
 *
 * Passes the parent directory of the transcript (the project's sessions folder)
 * rather than the individual file, because the mempalace `mine` CLI only accepts
 * directories. MemPalace deduplicates automatically, so already-filed sessions
 * are skipped and only new ones are processed.
 *
 * Uses --mode convos (exchange-pair chunking for human/assistant turns)
 * and --extract general (classifies chunks into decisions/preferences/
 * milestones/problems/emotional).
 *
 * @param transcriptPath - Absolute path to a pi session .jsonl file
 * @param projectSlug    - Wing name (e.g. "pi-flywheel"). Use sanitiseSlug().
 * @returns true if CLI exited 0, false on any error. Never throws.
 */
export declare function mineSession(transcriptPath: string, projectSlug: string): boolean;
export declare function searchEpisodic(query: string, options?: {
    wing?: string;
    nResults?: number;
}): string;
/**
 * High-level: get episodic context for a task/goal.
 *
 * Searches MemPalace for relevant past sessions, wraps results in a
 * ## Past Session Examples header suitable for prompt injection.
 * Returns "" if mempalace unavailable or no relevant results found.
 */
export declare function getEpisodicContext(task: string, projectSlug: string): string;
export declare function getEpisodicStats(): EpisodicStats;
/**
 * Sanitise a directory basename into a MemPalace wing slug.
 * Replaces any non-alphanumeric character with "-".
 *
 * Example: "/Volumes/1tb/Projects/pi-flywheel" → "pi-flywheel"
 *          "my project (v2)" → "my-project--v2-"
 */
export declare function sanitiseSlug(cwd: string): string;
//# sourceMappingURL=episodic-memory.d.ts.map