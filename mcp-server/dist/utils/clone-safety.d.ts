/**
 * clone-safety — safer `git clone` helper for user-supplied URLs.
 *
 * Motivation
 * ----------
 * Unauthenticated `git clone` over HTTPS with no SHA pinning is a supply-chain
 * footgun. A compromised upstream or DNS poisoning can redirect a clone to
 * attacker-controlled contents. CE phase4 blunder #2 (see
 * docs/research/compound-engineering-phase4-blunders.md) is the reference.
 *
 * This helper enforces three defenses at a single chokepoint:
 *   1. Host allowlist — only known-good Git hosts are accepted.
 *   2. HTTPS-only — non-https URLs require an explicit opt-in via the
 *      `FLYWHEEL_ALLOW_INSECURE_CLONE=1` env var.
 *   3. HEAD-SHA pinning — after clone we record `git rev-parse HEAD` and
 *      return it so callers can surface the exact commit to the user.
 *
 * We do NOT recurse submodules by default (another supply-chain vector),
 * and we pass args via array spawn (no shell).
 */
import type { ExecFn } from '../exec.js';
export interface CloneSafetyOptions {
    /** Extra hosts to add to the allowlist (e.g. GitHub Enterprise). */
    extraAllowedHosts?: string[];
    /** Optional branch/tag/ref to check out after clone. */
    branch?: string;
    /** Clone depth (defaults to 1 — shallow). */
    depth?: number;
    /** Timeout for git operations in ms. */
    timeout?: number;
    /** Abort signal. */
    signal?: AbortSignal;
    /**
     * Env object (defaults to process.env). Exposed for testing so tests can
     * control FLYWHEEL_ALLOW_INSECURE_CLONE without mutating process.env.
     */
    env?: NodeJS.ProcessEnv;
}
export interface CloneSafetyResult {
    /** The destination path that was cloned into. */
    path: string;
    /** Pinned HEAD SHA after clone (40-char hex). */
    head_sha: string;
    /** Resolved clone URL (post-validation). */
    url: string;
    /** Human-readable source identifier, e.g. "github.com/owner/repo". */
    source: string;
}
export declare class CloneSafetyError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
/**
 * Default host allowlist. Expand carefully — each entry is a trust
 * decision for user-supplied URLs flowing through the plugin.
 */
export declare const DEFAULT_ALLOWED_HOSTS: readonly string[];
/**
 * Validate a user-supplied clone URL. Returns the parsed URL on success or
 * throws CloneSafetyError on failure. Pure — no side effects, no I/O.
 */
export declare function validateCloneUrl(rawUrl: string, opts?: {
    extraAllowedHosts?: string[];
    env?: NodeJS.ProcessEnv;
}): {
    url: URL;
    source: string;
};
/** Validate a git ref (branch/tag) — reject arg-like or path-like refs. */
export declare function validateGitRef(ref: string): void;
/**
 * Safely `git clone` a user-supplied URL into `destination` and return a
 * CloneSafetyResult including the pinned HEAD SHA.
 *
 * Callers MUST surface `head_sha` in any artifact produced from the cloned
 * contents so downstream readers can independently verify the commit.
 */
export declare function safeClone(exec: ExecFn, rawUrl: string, destination: string, options?: CloneSafetyOptions): Promise<CloneSafetyResult>;
/**
 * Format a one-line provenance string for inclusion in research artifacts.
 * Example: "github.com/foo/bar @ abc1234 (https://github.com/foo/bar.git)"
 */
export declare function formatProvenance(result: CloneSafetyResult): string;
//# sourceMappingURL=clone-safety.d.ts.map