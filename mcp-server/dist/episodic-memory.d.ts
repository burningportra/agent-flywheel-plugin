import type { ExecFn } from "./exec.js";
import { type ErrorCodeTelemetry, type PostmortemDraft } from "./types.js";
import { type SolutionDoc } from "./solution-doc-schema.js";
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
export declare function searchEpisodic(query: string, options?: {
    wing?: string;
    nResults?: number;
}): string;
export declare function getEpisodicStats(): EpisodicStats;
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
/**
 * Inputs to `draftSolutionDoc` — a strict superset of the post-mortem
 * context plus the CASS entry_id that will be used for reconciliation.
 *
 * `entryId` MUST be set to the id returned by `cm add` when the paired
 * post-mortem was stored. When reconciliation hasn't happened yet (dry-run
 * preview) callers may pass a placeholder — the Zod schema only requires
 * a non-empty string.
 */
export interface SolutionDocDraftContext extends PostmortemSessionContext {
    /** CASS entry id produced by `cm add`. Required for F-1 reconciliation. */
    entryId: string;
    /**
     * Optional pre-computed `PostmortemDraft`. When absent, `draftSolutionDoc`
     * will call `draftPostmortem` internally to derive the body.
     */
    postmortem?: PostmortemDraft;
}
/**
 * Draft a `SolutionDoc` (durable docs/solutions/ learning entry) from the
 * session context. Read-only — NEVER writes to disk or CASS. The wrap-up
 * skill (`skills/start/_wrapup.md` Step 10.55) is responsible for writing
 * the rendered markdown via the native Write tool.
 *
 * Invariants:
 *   S-1: Non-throwing — degraded inputs still yield a Zod-valid SolutionDoc.
 *   S-2: Frontmatter always includes a non-empty `entry_id` (F-1).
 *   S-3: Path conforms to `docs/solutions/<category>/<slug>-YYYY-MM-DD.md`.
 *   S-4: `body` re-uses the post-mortem markdown so both artifacts share
 *        the same shipping / failing / error-codes narrative.
 *
 * Leaves a stable contract for downstream bead `bve` (compound-refresh)
 * which joins CASS and docs/solutions/ on `frontmatter.entry_id`.
 */
export declare function draftSolutionDoc(ctx: SolutionDocDraftContext): Promise<SolutionDoc>;
//# sourceMappingURL=episodic-memory.d.ts.map