/**
 * Resilient exec wrappers for external CLI calls (br, bv, git, etc.).
 *
 * Provides structured error types, automatic retry for transient failures,
 * and graceful degradation when a CLI tool is unavailable mid-session.
 */
import type { ExecFn } from "./exec.js";
import type { ParseResult } from "./parsers.js";
export declare function registerCliExecTelemetryHook(hook: (code: string) => void): void;
export interface BrStructuredError {
    code?: string;
    message?: string;
    hint?: string | null;
    retryable?: boolean | null;
    context?: unknown;
}
/** Structured error from a CLI exec call. */
export interface CliExecError {
    /** Full command string, e.g. "br update bd-123 --status closed" */
    command: string;
    /** Raw args array passed to exec */
    args: string[];
    /** Process exit code, or null if killed by signal / never started */
    exitCode: number | null;
    /** Captured stdout (available when process ran but exited non-zero) */
    stdout: string;
    /** Captured stderr */
    stderr: string;
    /** Parsed structured br error payload when stderr contains JSON error details. */
    brError?: BrStructuredError;
    /** Whether the failure is classified as transient (retry may help) */
    isTransient: boolean;
    /** Total number of attempts made (including the initial one) */
    attempts: number;
    /** Raw underlying error for debugging (e.g. the thrown Error object) */
    lastError?: unknown;
}
/** Discriminated result — callers match on `ok` instead of try/catch. */
export type ExecResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: CliExecError;
};
/** Raw exec output. */
export interface RawExecOutput {
    stdout: string;
    stderr: string;
    code: number;
    killed?: boolean;
}
/** Options for resilientExec. */
export interface ResilientExecOptions {
    cwd?: string;
    timeout?: number;
    /** Maximum retry attempts for transient failures. Default: 2 */
    maxRetries?: number;
    /** Delay between retries in ms. Default: 500 */
    retryDelayMs?: number;
    /** Custom transient detector. Overrides default heuristic when provided. */
    isTransient?: (exitCode: number | null, stderr: string, err: unknown) => boolean;
    /** Log structured warnings on failure. Default: true */
    logWarnings?: boolean;
    /**
     * Optional cancellation signal. Forwarded to every `exec` attempt; also used
     * to short-circuit retry sleeps and the retry loop itself so that aborting
     * stops the wrapper within one retry-delay window.
     */
    signal?: AbortSignal;
}
/**
 * br-specific transient classification.
 *
 * - Timeout → transient
 * - Structured br errors marked retryable → transient
 * - Structured DATABASE_ERROR busy/locked errors → transient, even if retryable=false
 * - Exit code 1 + empty stderr → transient (observed br race / DB-busy shape)
 * - Exit code > 1 → permanent unless matched by the rules above
 * - ENOENT / EACCES → permanent (br not installed / not executable)
 * - null exit code (signal kill) → transient
 */
export declare function isTransientBrError(exitCode: number | null, stderr: string, err: unknown): boolean;
/**
 * Retry-aware wrapper around `exec()`.
 *
 * Returns a discriminated `ExecResult` instead of throwing.
 * Retries transient failures up to `maxRetries` times.
 */
export declare function resilientExec(exec: ExecFn, cmd: string, args: string[], opts?: ResilientExecOptions): Promise<ExecResult<RawExecOutput>>;
/**
 * Convenience wrapper for `br` CLI calls.
 * Uses br-specific transient detection.
 */
export declare function brExec(exec: ExecFn, args: string[], opts?: ResilientExecOptions): Promise<ExecResult<RawExecOutput>>;
/**
 * Like `brExec` but parses stdout as JSON.
 * Returns a structured permanent error if JSON parsing fails.
 *
 * When `validator` is provided, stdout is validated through the given
 * `ParseResult`-returning function instead of a bare `JSON.parse`.
 */
export declare function brExecJson<T>(exec: ExecFn, args: string[], opts?: ResilientExecOptions & {
    validator?: (raw: string) => ParseResult<T>;
}): Promise<ExecResult<T>>;
//# sourceMappingURL=cli-exec.d.ts.map