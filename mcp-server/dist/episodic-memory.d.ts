import type { ExecFn } from "./exec.js";
import { type ErrorCodeTelemetry, type PostmortemDraft } from "./types.js";
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
export interface PostmortemSessionContext {
    cwd: string;
    goal: string;
    phase: string;
    /** From checkpoint.sessionStartSha — used for `<sha>..HEAD` range. */
    sessionStartSha?: string;
    /** Top-N error codes rendered into the draft markdown. */
    errorCodeTelemetry?: ErrorCodeTelemetry;
    exec: ExecFn;
    signal?: AbortSignal;
    /** Optional override for agent name used when reading inbox (default: FlywheelAgent). */
    agentName?: string;
}
/**
 * Draft a post-mortem summary for the current session. Read-only — NEVER
 * writes to CASS / calls `flywheel_memory` with `operation: 'store'`. The
 * tool layer gates persistence via the user.
 *
 * P-1 / P-2 / P-4 are enforced by never throwing on degraded input: every
 * branch produces a valid Zod-parsed `PostmortemDraft` with warnings[]
 * populated when inputs were partial.
 */
export declare function draftPostmortem(ctx: PostmortemSessionContext): Promise<PostmortemDraft>;
/**
 * Format a `PostmortemDraft` for human display. The canonical markdown body
 * already lives in `draft.markdown`; this helper prepends the warning banner
 * when `hasWarnings` is true so callers (tool layer + user) see the
 * degraded-input signal without parsing `warnings[]` themselves.
 */
export declare function formatPostmortemMarkdown(draft: PostmortemDraft): string;
//# sourceMappingURL=episodic-memory.d.ts.map