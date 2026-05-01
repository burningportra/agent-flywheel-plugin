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
import { realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve, relative, sep } from "node:path";
import { errMsg } from "../errors.js";
// ─── Constants ──────────────────────────────────────────────
const DEFAULT_MAX_PATH_LENGTH = 1024;
const DEFAULT_MAX_SEGMENT_LENGTH = 128;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const RESERVED_SEGMENTS = new Set(["..", "."]);
// ─── Internal helpers ───────────────────────────────────────
function preview(raw) {
    if (typeof raw !== "string")
        return String(raw).slice(0, 80);
    return raw.length > 80 ? `${raw.slice(0, 77)}...` : raw;
}
function err(reason, message, raw) {
    return { ok: false, reason, message, rawPreview: preview(raw) };
}
function formatPathLabel(label) {
    return label ?? "Path";
}
function isEnoent(err) {
    if (typeof err === "object" && err !== null && "code" in err) {
        return err.code === "ENOENT";
    }
    const msg = errMsg(err);
    return /\bENOENT\b/i.test(msg);
}
function isSameOrChildPath(candidate, root) {
    return candidate === root || candidate.startsWith(root + sep);
}
// ─── Public API ─────────────────────────────────────────────
/**
 * Validate a *single* path segment (no separators). Use for user-supplied
 * identifiers that are later spliced into a path, e.g. bead IDs, skill names,
 * toolName in `${toolName}.jsonl`, or each component of a split() spread.
 *
 * Rejects: empty strings, strings containing `/`, `\\`, `:`, null bytes,
 * control chars, `..` or `.`, and anything over `maxLength`.
 */
export function assertSafeSegment(input, opts = {}) {
    const maxLength = opts.maxLength ?? DEFAULT_MAX_SEGMENT_LENGTH;
    if (typeof input !== "string") {
        return err("not_string", "Path segment must be a string.", input);
    }
    if (input.length === 0) {
        return err("empty", "Path segment is empty.", input);
    }
    if (input.length > maxLength) {
        return err("too_long", `Path segment exceeds maximum length of ${maxLength} chars.`, input);
    }
    if (input.includes("\0")) {
        return err("null_byte", "Path segment contains a null byte.", input);
    }
    if (CONTROL_CHAR_RE.test(input)) {
        return err("control_char", "Path segment contains control characters.", input);
    }
    if (input.includes("/")) {
        return err("separator_in_segment", "Path segment contains a forward slash — segments must not span directories.", input);
    }
    if (input.includes("\\")) {
        return err("backslash", "Path segment contains a backslash — segments must not span directories.", input);
    }
    if (input.includes(":")) {
        // Colons are the CE-blunder canary: opencode's writer spread `name.split(":")`
        // straight into path.join, so `..:..:etc:passwd` became real traversal.
        return err("colon", "Path segment contains ':' — reserved to prevent traversal via split/spread.", input);
    }
    if (RESERVED_SEGMENTS.has(input)) {
        return err("reserved_segment", `Path segment '${input}' is reserved.`, input);
    }
    if (opts.rejectLeadingDot && input.startsWith(".")) {
        return err("reserved_segment", "Path segment must not start with '.'.", input);
    }
    return { ok: true, value: input };
}
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
export function assertSafeRelativePath(input, opts) {
    const maxLength = opts.maxLength ?? DEFAULT_MAX_PATH_LENGTH;
    if (typeof input !== "string") {
        return err("not_string", "Path must be a string.", input);
    }
    if (input.length === 0) {
        return err("empty", "Path is empty.", input);
    }
    if (input.length > maxLength) {
        return err("too_long", `Path exceeds maximum length of ${maxLength} chars.`, input);
    }
    if (input.includes("\0")) {
        return err("null_byte", "Path contains a null byte.", input);
    }
    if (CONTROL_CHAR_RE.test(input)) {
        return err("control_char", "Path contains control characters.", input);
    }
    if (isAbsolute(input) && !opts.allowAbsoluteInsideRoot) {
        return err("absolute_when_relative_expected", "Absolute paths are not allowed — provide a path relative to the project root.", input);
    }
    const normalized = normalize(input);
    const segments = normalized.split(sep);
    if (segments.some((s) => s === "..")) {
        return err("parent_traversal", "Path contains '..' segment — parent-directory traversal is not allowed.", input);
    }
    // Last-resort containment check: resolve and ensure the result is inside root.
    const absolute = resolve(opts.root, input);
    const rel = relative(opts.root, absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) {
        return err("escapes_root", `Path resolves outside of root '${opts.root}'.`, input);
    }
    return { ok: true, value: rel === "" ? "." : rel };
}
/**
 * Resolve a path to its canonical realpath. Returns a structured result
 * instead of throwing so MCP-boundary callers can emit tool-friendly errors.
 */
export function resolveRealpath(input, opts = {}) {
    const label = formatPathLabel(opts.label);
    let absolutePath;
    try {
        absolutePath = isAbsolute(input)
            ? input
            : opts.base
                ? resolve(opts.base, input)
                : resolve(input);
    }
    catch (err) {
        return {
            ok: false,
            reason: "resolve_failed",
            message: `${label} resolve failed: ${errMsg(err)}`,
            absolutePath: input,
        };
    }
    try {
        return {
            ok: true,
            absolutePath,
            realPath: realpathSync(absolutePath),
        };
    }
    catch (err) {
        return {
            ok: false,
            reason: isEnoent(err) ? "not_found" : "resolve_failed",
            message: isEnoent(err)
                ? `${label} not found: ${absolutePath}`
                : `${label} resolve failed: ${errMsg(err)}`,
            absolutePath,
        };
    }
}
/**
 * Resolve a path and verify its canonical target remains inside `root` after
 * symlink resolution. Intended for MCP-controlled file and directory args.
 */
export function resolveRealpathWithinRoot(input, opts) {
    const label = formatPathLabel(opts.label);
    const rootLabel = formatPathLabel(opts.rootLabel ?? "Root");
    const rootResult = resolveRealpath(opts.root, { label: rootLabel });
    if (!rootResult.ok) {
        return {
            ok: false,
            reason: rootResult.reason === "not_found" ? "root_not_found" : rootResult.reason,
            message: rootResult.reason === "not_found"
                ? `${rootLabel} not found: ${rootResult.absolutePath}`
                : rootResult.message,
            absolutePath: rootResult.absolutePath,
        };
    }
    const pathResult = resolveRealpath(input, { base: opts.root, label });
    if (!pathResult.ok) {
        return pathResult;
    }
    if (!isSameOrChildPath(pathResult.realPath, rootResult.realPath)) {
        return {
            ok: false,
            reason: "outside_root",
            message: `${label} resolves outside ${rootLabel.toLowerCase()} after symlink resolution.`,
            absolutePath: pathResult.absolutePath,
            realPath: pathResult.realPath,
            realRoot: rootResult.realPath,
        };
    }
    const relativePath = relative(rootResult.realPath, pathResult.realPath) || ".";
    return {
        ok: true,
        absolutePath: pathResult.absolutePath,
        realPath: pathResult.realPath,
        realRoot: rootResult.realPath,
        relativePath,
    };
}
/**
 * Convenience wrapper: throw an Error on rejection. Prefer the non-throwing
 * variants at MCP boundaries so the tool can emit a structured `invalid_input`
 * error code. Use this only in pure helpers that have no graceful fallback.
 */
export function requireSafeRelativePath(input, opts) {
    const r = assertSafeRelativePath(input, opts);
    if (!r.ok) {
        throw new Error(`[path-safety] ${r.reason}: ${r.message}`);
    }
    return r.value;
}
export function requireSafeSegment(input, opts = {}) {
    const r = assertSafeSegment(input, opts);
    if (!r.ok) {
        throw new Error(`[path-safety] ${r.reason}: ${r.message}`);
    }
    return r.value;
}
//# sourceMappingURL=path-safety.js.map