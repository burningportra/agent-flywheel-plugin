/**
 * path-safety — shared sanitizer for user-controlled path inputs.
 *
 * Context: CE phase4 blunder #1 showed that a naive sanitizer (strip `:` only)
 * lets `../` traverse straight to every downstream writer. This module is the
 * single place agent-flywheel validates any path-ish input that originated
 * from:
 *   - MCP tool args (goal, planFile, beadId, skillName, repoName, …)
 *   - Remote input (git URLs, GitHub repo names from /flywheel-research)
 *   - AskUserQuestion "Other" free-text answers
 *   - Parsed model output that later flows into a filesystem path
 *
 * The sanitizer is intentionally strict-by-default and returns a typed
 * Result-style object rather than throwing — callers decide whether to bail
 * with a tool-error response or to fall back to a safe default. Every
 * rejection carries a short human-readable reason code so error messages at
 * MCP boundaries stay consistent.
 *
 * Companion modules: `clone-safety.ts` (git-URL allow-list, bead 016) and
 * `fs-safety.ts` (write-owner/symlink checks, bead 8tf). This module only
 * handles path *strings* — it does not touch the filesystem.
 */
export type SafePathReason = "empty" | "not_string" | "control_char" | "null_byte" | "absolute_when_relative_expected" | "parent_traversal" | "escapes_root" | "separator_in_segment" | "reserved_segment" | "too_long" | "colon" | "backslash";
export interface SafePathOk {
    ok: true;
    /** The normalized, vetted path (relative when relative was expected). */
    value: string;
}
export interface SafePathErr {
    ok: false;
    reason: SafePathReason;
    /** Human-readable message suitable for MCP tool error payloads. */
    message: string;
    /** The raw input (truncated) for debugging; never re-emit blindly to users. */
    rawPreview?: string;
}
export type SafePathResult = SafePathOk | SafePathErr;
export interface AssertSafeRelativePathOptions {
    /** Root that the path must stay inside. Required. */
    root: string;
    /** Max length of the input string. Default: 1024. */
    maxLength?: number;
    /**
     * Permit an *absolute* input iff it resolves inside `root`. Default: false
     * (reject absolute inputs outright — callers that want path-or-abs should
     * opt in explicitly so traversal stays visible at the call site).
     */
    allowAbsoluteInsideRoot?: boolean;
}
export interface AssertSafeSegmentOptions {
    /** Max length of the segment. Default: 128. */
    maxLength?: number;
    /**
     * If true, reject segments starting with `.` (hidden files and `..`).
     * Default: false — we already reject `..` explicitly via `reserved_segment`.
     */
    rejectLeadingDot?: boolean;
}
export type RealpathReason = "resolve_failed" | "not_found" | "outside_root" | "root_not_found";
export interface RealpathOk {
    ok: true;
    absolutePath: string;
    realPath: string;
}
export interface RealpathErr {
    ok: false;
    reason: Extract<RealpathReason, "resolve_failed" | "not_found">;
    message: string;
    absolutePath: string;
}
export type RealpathResult = RealpathOk | RealpathErr;
export interface RealpathWithinRootOk extends RealpathOk {
    realRoot: string;
    relativePath: string;
}
export interface RealpathWithinRootErr {
    ok: false;
    reason: RealpathReason;
    message: string;
    absolutePath: string;
    realPath?: string;
    realRoot?: string;
}
export type RealpathWithinRootResult = RealpathWithinRootOk | RealpathWithinRootErr;
/**
 * Validate a *single* path segment (no separators). Use for user-supplied
 * identifiers that are later spliced into a path, e.g. bead IDs, skill names,
 * toolName in `${toolName}.jsonl`, or each component of a split() spread.
 *
 * Rejects: empty strings, strings containing `/`, `\\`, `:`, null bytes,
 * control chars, `..` or `.`, and anything over `maxLength`.
 */
export declare function assertSafeSegment(input: unknown, opts?: AssertSafeSegmentOptions): SafePathResult;
/**
 * Validate a *relative* path that must stay inside `root`. Use at any MCP
 * tool-arg boundary that ends up at `resolve(cwd, userPath)`.
 *
 * The check is done in two layers:
 *   1. Reject obvious traversal (`..`, control chars, null bytes, length).
 *   2. Resolve against `root` and confirm the resolved path is still inside
 *      `root`. This catches symlink-like tricks and path-segment encodings
 *      that normalize() can't see (we rely on realpath resolution being
 *      performed separately where needed).
 *
 * On success returns the *relative* path (with platform-native separators).
 */
export declare function assertSafeRelativePath(input: unknown, opts: AssertSafeRelativePathOptions): SafePathResult;
/**
 * Resolve a path to its canonical realpath. Returns a structured result
 * instead of throwing so MCP-boundary callers can emit tool-friendly errors.
 */
export declare function resolveRealpath(input: string, opts?: {
    base?: string;
    label?: string;
}): RealpathResult;
/**
 * Resolve a path and verify its canonical target remains inside `root` after
 * symlink resolution. Intended for MCP-controlled file and directory args.
 */
export declare function resolveRealpathWithinRoot(input: string, opts: {
    root: string;
    label?: string;
    rootLabel?: string;
}): RealpathWithinRootResult;
/**
 * Convenience wrapper: throw an Error on rejection. Prefer the non-throwing
 * variants at MCP boundaries so the tool can emit a structured `invalid_input`
 * error code. Use this only in pure helpers that have no graceful fallback.
 */
export declare function requireSafeRelativePath(input: unknown, opts: AssertSafeRelativePathOptions): string;
export declare function requireSafeSegment(input: unknown, opts?: AssertSafeSegmentOptions): string;
//# sourceMappingURL=path-safety.d.ts.map