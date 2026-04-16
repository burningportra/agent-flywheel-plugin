import type { ExecFn } from "./exec.js";
import type { RepoProfile } from "./types.js";
/**
 * Load cached profile if the git HEAD matches.
 * Returns the cached RepoProfile or null if stale/missing.
 */
export declare function loadCachedProfile(exec: ExecFn, cwd: string): Promise<RepoProfile | null>;
/**
 * Save a RepoProfile to the cache file with the current git HEAD.
 */
/**
 * Save profile to cache. Accepts optional gitHead to avoid redundant git call.
 * Designed to be called fire-and-forget (don't await if you don't need to).
 */
export declare function saveCachedProfile(exec: ExecFn, cwd: string, profile: RepoProfile, gitHead?: string): Promise<void>;
/**
 * Collect raw repo signals using exec for shell commands.
 * Returns a RepoProfile with everything except LLM-generated fields.
 */
export declare function profileRepo(exec: ExecFn, cwd: string, signal?: AbortSignal): Promise<RepoProfile>;
/**
 * Format best-practices guides for injection into planning prompts.
 * Truncates to avoid overwhelming context windows.
 */
export declare function formatBestPracticesGuides(guides: Array<{
    name: string;
    content: string;
}>): string;
export declare function createEmptyRepoProfile(cwd: string): RepoProfile;
//# sourceMappingURL=profiler.d.ts.map