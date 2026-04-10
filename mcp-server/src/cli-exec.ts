/**
 * Resilient exec wrappers for external CLI calls (br, bv, git, etc.).
 *
 * Provides structured error types, automatic retry for transient failures,
 * and graceful degradation when a CLI tool is unavailable mid-session.
 */
import type { ExecFn } from "./exec.js";
import { createLogger } from "./logger.js";
import { BrStructuredErrorSchema } from "./parsers.js";
import type { ParseResult } from "./parsers.js";

const log = createLogger("cli-exec");

// ─── Types ────────────────────────────────────────────────────

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
export type ExecResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CliExecError };

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
}

// ─── Transient detection ──────────────────────────────────────

/** Default transient detection for generic CLI calls. */
function isTransientDefault(
  _exitCode: number | null,
  _stderr: string,
  err: unknown,
): boolean {
  // Timeout or signal kill → transient
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("etimedout")) return true;
    if (msg.includes("killed")) return true;
  }
  // null exit code usually means signal kill → transient
  if (_exitCode === null) return true;
  return false;
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function extractJsonObject(input: string): string | undefined {
  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return input.slice(start, end + 1);
}

function parseBrStructuredError(stderr: string): BrStructuredError | undefined {
  const cleaned = stripAnsi(stderr).trim();
  const candidate = cleaned.startsWith("{") ? cleaned : extractJsonObject(cleaned);
  if (!candidate) return undefined;

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || !parsed.error || typeof parsed.error !== "object") {
      return undefined;
    }
    // Validate the inner error object with the Zod schema
    const validated = BrStructuredErrorSchema.safeParse(parsed.error);
    if (!validated.success) return undefined;
    return validated.data as BrStructuredError;
  } catch {
    return undefined;
  }
}

function isDatabaseBusyMessage(message?: string): boolean {
  const normalized = message?.toLowerCase() ?? "";
  return normalized.includes("database is busy") || normalized.includes("database busy") || normalized.includes("database is locked");
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
export function isTransientBrError(
  exitCode: number | null,
  stderr: string,
  err: unknown,
): boolean {
  // Check for ENOENT / EACCES first — permanent
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes("ENOENT") || msg.includes("EACCES")) return false;
    // Timeout → transient
    if (msg.toLowerCase().includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("timed out")) return true;
    if (msg.includes("killed")) return true;
  }

  const brError = parseBrStructuredError(stderr);
  if (brError?.retryable === true) return true;
  if (brError?.code === "DATABASE_ERROR" && isDatabaseBusyMessage(brError.message)) return true;

  // null exit code (signal kill) → transient
  if (exitCode === null) return true;
  // Exit code 1 + empty/whitespace stderr → transient (DB busy, race condition)
  if (exitCode === 1 && stderr.trim() === "") return true;
  // Exit code > 1 → permanent
  if (exitCode > 1) return false;
  // Exit code 0 shouldn't reach here, but not transient
  return false;
}

// ─── Helpers ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatCommand(cmd: string, args: string[]): string {
  return [cmd, ...args].join(" ");
}

function formatErrorDetail(error: CliExecError): string {
  if (error.brError?.code || error.brError?.message) {
    const code = error.brError.code ?? "BR_ERROR";
    const message = error.brError.message ?? error.stderr;
    return `${code}: ${JSON.stringify(message)}`;
  }
  return JSON.stringify(error.stderr.slice(0, 200));
}

function buildWarning(error: CliExecError): string {
  const classification = error.isTransient ? "transient" : "permanent";
  return (
    `[cli-exec] ${classification} failure after ${error.attempts} attempt(s): ` +
    `${error.command} → exit=${error.exitCode ?? "null"} stderr=${formatErrorDetail(error)}`
  );
}

// ─── Core wrapper ─────────────────────────────────────────────

/**
 * Retry-aware wrapper around `exec()`.
 *
 * Returns a discriminated `ExecResult` instead of throwing.
 * Retries transient failures up to `maxRetries` times.
 */
export async function resilientExec(
  exec: ExecFn,
  cmd: string,
  args: string[],
  opts?: ResilientExecOptions,
): Promise<ExecResult<RawExecOutput>> {
  const maxRetries = opts?.maxRetries ?? 2;
  const retryDelayMs = opts?.retryDelayMs ?? 500;
  const transientCheck = opts?.isTransient ?? isTransientDefault;
  const logWarnings = opts?.logWarnings !== false;
  const commandStr = formatCommand(cmd, args);

  let lastError: CliExecError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await exec(cmd, args, {
        cwd: opts?.cwd,
        timeout: opts?.timeout,
      });

      // Non-zero exit code is a failure, but not an exception
      if (result.code !== 0) {
        const transient = transientCheck(result.code, result.stderr, null);
        lastError = {
          command: commandStr,
          args,
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          brError: cmd === "br" ? parseBrStructuredError(result.stderr) : undefined,
          isTransient: transient,
          attempts: attempt + 1,
        };
        if (transient && attempt < maxRetries) {
          if (retryDelayMs > 0) await sleep(retryDelayMs);
          continue;
        }
        // Permanent or exhausted retries
        if (logWarnings) log.warn(buildWarning(lastError));
        return { ok: false, error: lastError };
      }

      // Success
      return { ok: true, value: result };
    } catch (err: unknown) {
      // Exception path: timeout, ENOENT, etc.
      const transient = transientCheck(null, "", err);
      lastError = {
        command: commandStr,
        args,
        exitCode: null,
        stdout: "",
        stderr: "",
        isTransient: transient,
        attempts: attempt + 1,
        lastError: err,
      };
      if (transient && attempt < maxRetries) {
        if (retryDelayMs > 0) await sleep(retryDelayMs);
        continue;
      }
      if (logWarnings) log.warn(buildWarning(lastError));
      return { ok: false, error: lastError };
    }
  }

  // Should not reach here, but safety net
  /* istanbul ignore next */
  if (logWarnings && lastError) log.warn(buildWarning(lastError));
  return { ok: false, error: lastError! };
}

// ─── br-specific wrappers ─────────────────────────────────────

/**
 * Convenience wrapper for `br` CLI calls.
 * Uses br-specific transient detection.
 */
export async function brExec(
  exec: ExecFn,
  args: string[],
  opts?: ResilientExecOptions,
): Promise<ExecResult<RawExecOutput>> {
  return resilientExec(exec, "br", args, {
    ...opts,
    isTransient: opts?.isTransient ?? isTransientBrError,
  });
}

/**
 * Like `brExec` but parses stdout as JSON.
 * Returns a structured permanent error if JSON parsing fails.
 *
 * When `validator` is provided, stdout is validated through the given
 * `ParseResult`-returning function instead of a bare `JSON.parse`.
 */
export async function brExecJson<T>(
  exec: ExecFn,
  args: string[],
  opts?: ResilientExecOptions & { validator?: (raw: string) => ParseResult<T> },
): Promise<ExecResult<T>> {
  const result = await brExec(exec, args, opts);
  if (!result.ok) return result;

  const commandStr = formatCommand("br", args);

  if (opts?.validator) {
    const validated = opts.validator(result.value.stdout);
    if (validated.ok) return { ok: true, value: validated.data };
    const error: CliExecError = {
      command: commandStr,
      args,
      exitCode: 0,
      stdout: result.value.stdout,
      stderr: `Validation error: ${validated.error}`,
      isTransient: false,
      attempts: 1,
    };
    if (opts?.logWarnings !== false) {
      log.warn("Validation failure", { cmd: commandStr, error: validated.error });
    }
    return { ok: false, error };
  }

  try {
    const parsed = JSON.parse(result.value.stdout) as T;
    return { ok: true, value: parsed };
  } catch (parseErr: unknown) {
    const error: CliExecError = {
      command: commandStr,
      args,
      exitCode: 0,
      stdout: result.value.stdout,
      stderr: `JSON parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      isTransient: false,
      attempts: 1,
      lastError: parseErr,
    };
    if (opts?.logWarnings !== false) {
      log.warn("JSON parse failure", { cmd: commandStr, stdoutPreview: result.value.stdout.slice(0, 200) });
    }
    return { ok: false, error };
  }
}
