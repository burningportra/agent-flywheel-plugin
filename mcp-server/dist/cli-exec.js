import { createLogger } from "./logger.js";
import { BrStructuredErrorSchema } from "./parsers.js";
import { classifyExecError, errMsg } from "./errors.js";
const log = createLogger("cli-exec");
/**
 * Side-channel telemetry hook for cli-exec failure recording.
 * telemetry.ts registers itself here so resilientExec can fire
 * recordErrorCode without a direct dependency on telemetry.ts.
 */
let _cliExecTelemetryHook = null;
export function registerCliExecTelemetryHook(hook) {
    _cliExecTelemetryHook = hook;
}
// ─── Transient detection ──────────────────────────────────────
/** Default transient detection for generic CLI calls. */
function isTransientDefault(_exitCode, _stderr, err) {
    // Timeout or signal kill → transient
    if (err instanceof Error) {
        const msg = err.message.toLowerCase();
        if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("etimedout"))
            return true;
        if (msg.includes("killed"))
            return true;
    }
    // null exit code usually means signal kill → transient
    if (_exitCode === null)
        return true;
    return false;
}
function stripAnsi(input) {
    return input.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
function extractJsonObject(input) {
    const start = input.indexOf("{");
    const end = input.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start)
        return undefined;
    return input.slice(start, end + 1);
}
function parseBrStructuredError(stderr) {
    const cleaned = stripAnsi(stderr).trim();
    const candidate = cleaned.startsWith("{") ? cleaned : extractJsonObject(cleaned);
    if (!candidate)
        return undefined;
    try {
        const parsed = JSON.parse(candidate);
        if (!parsed || typeof parsed !== "object" || !parsed.error || typeof parsed.error !== "object") {
            return undefined;
        }
        // Validate the inner error object with the Zod schema
        const validated = BrStructuredErrorSchema.safeParse(parsed.error);
        if (!validated.success)
            return undefined;
        return validated.data;
    }
    catch {
        return undefined;
    }
}
function isDatabaseBusyMessage(message) {
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
export function isTransientBrError(exitCode, stderr, err) {
    // Check for ENOENT / EACCES first — permanent
    if (err instanceof Error) {
        const msg = err.message;
        if (msg.includes("ENOENT") || msg.includes("EACCES"))
            return false;
        // Timeout → transient
        if (msg.toLowerCase().includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("timed out"))
            return true;
        if (msg.includes("killed"))
            return true;
    }
    const brError = parseBrStructuredError(stderr);
    if (brError?.retryable === true)
        return true;
    if (brError?.code === "DATABASE_ERROR" && isDatabaseBusyMessage(brError.message))
        return true;
    // null exit code (signal kill) → transient
    if (exitCode === null)
        return true;
    // Exit code 1 + empty/whitespace stderr → transient (DB busy, race condition)
    if (exitCode === 1 && stderr.trim() === "")
        return true;
    // Exit code > 1 → permanent
    if (exitCode > 1)
        return false;
    // Exit code 0 shouldn't reach here, but not transient
    return false;
}
// ─── Helpers ──────────────────────────────────────────────────
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Abortable sleep — resolves after `ms` or immediately when `signal` aborts.
 * Always resolves (never rejects) so callers observe abort via `signal.aborted`
 * on the next loop iteration rather than as a thrown error.
 */
function abortableSleep(ms, signal) {
    if (signal.aborted)
        return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
/** Build a synthesized "aborted" CliExecError so callers/classifyExecError map it to `exec_aborted`. */
function buildAbortedError(commandStr, args, attempts) {
    const err = new Error("aborted");
    return {
        command: commandStr,
        args,
        exitCode: null,
        stdout: "",
        stderr: "",
        isTransient: false,
        attempts,
        lastError: err,
    };
}
function formatCommand(cmd, args) {
    return [cmd, ...args].join(" ");
}
function formatErrorDetail(error) {
    if (error.brError?.code || error.brError?.message) {
        const code = error.brError.code ?? "BR_ERROR";
        const message = error.brError.message ?? error.stderr;
        return `${code}: ${JSON.stringify(message)}`;
    }
    return JSON.stringify(error.stderr.slice(0, 200));
}
function buildWarning(error) {
    const classification = error.isTransient ? "transient" : "permanent";
    return (`[cli-exec] ${classification} failure after ${error.attempts} attempt(s): ` +
        `${error.command} → exit=${error.exitCode ?? "null"} stderr=${formatErrorDetail(error)}`);
}
/** Fire telemetry for the final (non-retried) failure. Never throws. */
function fireTelemetryForError(error) {
    try {
        if (_cliExecTelemetryHook == null)
            return;
        const raw = error.lastError ?? (error.stderr ? new Error(error.stderr) : new Error("cli failure"));
        const classified = classifyExecError(raw);
        _cliExecTelemetryHook(classified.code);
    }
    catch { /* never throw from telemetry path */ }
}
// ─── Core wrapper ─────────────────────────────────────────────
/**
 * Retry-aware wrapper around `exec()`.
 *
 * Returns a discriminated `ExecResult` instead of throwing.
 * Retries transient failures up to `maxRetries` times.
 */
export async function resilientExec(exec, cmd, args, opts) {
    const maxRetries = opts?.maxRetries ?? 2;
    const retryDelayMs = opts?.retryDelayMs ?? 500;
    const transientCheck = opts?.isTransient ?? isTransientDefault;
    const logWarnings = opts?.logWarnings !== false;
    const signal = opts?.signal;
    const commandStr = formatCommand(cmd, args);
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // Short-circuit before each attempt if aborted.
        if (signal?.aborted) {
            lastError = buildAbortedError(commandStr, args, attempt + 1);
            if (logWarnings)
                log.warn(buildWarning(lastError));
            return { ok: false, error: lastError };
        }
        try {
            const result = await exec(cmd, args, {
                cwd: opts?.cwd,
                timeout: opts?.timeout,
                signal,
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
                    if (retryDelayMs > 0) {
                        if (signal)
                            await abortableSleep(retryDelayMs, signal);
                        else
                            await sleep(retryDelayMs);
                    }
                    if (signal?.aborted) {
                        lastError = buildAbortedError(commandStr, args, attempt + 1);
                        if (logWarnings)
                            log.warn(buildWarning(lastError));
                        return { ok: false, error: lastError };
                    }
                    continue;
                }
                // Permanent or exhausted retries
                if (logWarnings)
                    log.warn(buildWarning(lastError));
                fireTelemetryForError(lastError);
                return { ok: false, error: lastError };
            }
            // Success
            return { ok: true, value: result };
        }
        catch (err) {
            // Exception path: timeout, ENOENT, abort, etc.
            // If the signal caused this (or is now aborted), map to exec_aborted.
            if (signal?.aborted) {
                lastError = buildAbortedError(commandStr, args, attempt + 1);
                if (logWarnings)
                    log.warn(buildWarning(lastError));
                return { ok: false, error: lastError };
            }
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
                if (retryDelayMs > 0) {
                    if (signal)
                        await abortableSleep(retryDelayMs, signal);
                    else
                        await sleep(retryDelayMs);
                }
                if (signal?.aborted) {
                    lastError = buildAbortedError(commandStr, args, attempt + 1);
                    if (logWarnings)
                        log.warn(buildWarning(lastError));
                    return { ok: false, error: lastError };
                }
                continue;
            }
            if (logWarnings)
                log.warn(buildWarning(lastError));
            fireTelemetryForError(lastError);
            return { ok: false, error: lastError };
        }
    }
    // Should not reach here, but safety net
    /* istanbul ignore next */
    if (logWarnings && lastError)
        log.warn(buildWarning(lastError));
    /* istanbul ignore next */
    if (lastError)
        fireTelemetryForError(lastError);
    return { ok: false, error: lastError };
}
// ─── br-specific wrappers ─────────────────────────────────────
/**
 * Convenience wrapper for `br` CLI calls.
 * Uses br-specific transient detection.
 */
export async function brExec(exec, args, opts) {
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
export async function brExecJson(exec, args, opts) {
    const result = await brExec(exec, args, opts);
    if (!result.ok)
        return result;
    const commandStr = formatCommand("br", args);
    if (opts?.validator) {
        const validated = opts.validator(result.value.stdout);
        if (validated.ok)
            return { ok: true, value: validated.data };
        const error = {
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
        const parsed = JSON.parse(result.value.stdout);
        return { ok: true, value: parsed };
    }
    catch (parseErr) {
        const error = {
            command: commandStr,
            args,
            exitCode: 0,
            stdout: result.value.stdout,
            stderr: `JSON parse error: ${errMsg(parseErr)}`,
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
//# sourceMappingURL=cli-exec.js.map