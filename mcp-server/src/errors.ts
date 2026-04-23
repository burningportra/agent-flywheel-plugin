import { z } from 'zod';
import type { FlywheelToolName, FlywheelPhase } from './types.js';

/**
 * Side-channel telemetry hook. telemetry.ts registers itself here on first
 * import so that makeFlywheelErrorResult can fire recordErrorCode without
 * creating a circular ESM dependency (errors ← telemetry ← errors).
 */
let _telemetryHook: ((code: string, ctx?: { hashable?: string }) => void) | null = null;

export function registerTelemetryHook(
  hook: (code: string, ctx?: { hashable?: string }) => void,
): void {
  _telemetryHook = hook;
}

export const FLYWHEEL_ERROR_CODES = [
  'missing_prerequisite',
  'invalid_input',
  'not_found',
  'cli_failure',
  'cli_not_available',
  'parse_failure',
  'exec_timeout',
  'exec_aborted',
  'blocked_state',
  'concurrent_write',
  'agent_mail_unreachable',
  'deep_plan_all_failed',
  'empty_plan',
  'already_closed',
  'unsupported_action',
  'internal_error',
  // v3.4.0 — doctor/hotspot/postmortem/template/telemetry
  'doctor_check_failed',
  'doctor_partial_report',
  'hotspot_parse_failure',
  'hotspot_bead_body_unparseable',
  'postmortem_empty_session',
  'postmortem_checkpoint_stale',
  'template_not_found',
  'template_placeholder_missing',
  'template_expansion_failed',
  'telemetry_store_failed',
  // agent-flywheel-plugin-iy4 — wave collision detection
  'wave_collision_detected',
] as const;

export const FlywheelErrorCodeSchema = z.enum(FLYWHEEL_ERROR_CODES);
export type FlywheelErrorCode = z.infer<typeof FlywheelErrorCodeSchema>;

export const FlywheelToolErrorSchema = z.object({
  code: FlywheelErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean().optional(),
  hint: z.string().optional(),
  cause: z.string().optional(),
  phase: z.string().optional(),
  tool: z.string().optional(),
  timestamp: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type FlywheelToolError = z.infer<typeof FlywheelToolErrorSchema>;

export const FlywheelStructuredErrorSchema = z.object({
  tool: z.string(),
  version: z.literal(1),
  status: z.literal('error'),
  phase: z.string(),
  data: z.object({
    kind: z.literal('error'),
    error: FlywheelToolErrorSchema,
  }),
});
export type FlywheelStructuredError = z.infer<typeof FlywheelStructuredErrorSchema>;

export const DEFAULT_RETRYABLE: Record<FlywheelErrorCode, boolean> = {
  missing_prerequisite: false,
  invalid_input: false,
  not_found: false,
  cli_failure: true,
  cli_not_available: false,
  parse_failure: false,
  exec_timeout: true,
  exec_aborted: false,
  blocked_state: true,
  concurrent_write: true,
  agent_mail_unreachable: true,
  deep_plan_all_failed: true,
  empty_plan: false,
  already_closed: false,
  unsupported_action: false,
  internal_error: true,
  // v3.4.0 additions
  doctor_check_failed: false,
  doctor_partial_report: false,
  hotspot_parse_failure: false,
  hotspot_bead_body_unparseable: false,
  postmortem_empty_session: false,
  postmortem_checkpoint_stale: false,
  template_not_found: false,
  template_placeholder_missing: false,
  template_expansion_failed: true,   // may be transient if template library is mid-reload
  telemetry_store_failed: true,      // disk contention is transient
  // agent-flywheel-plugin-iy4 — collision is recoverable via serial re-run
  wave_collision_detected: true,
};

export class FlywheelError extends Error {
  readonly code: FlywheelErrorCode;
  readonly retryable: boolean;
  readonly hint?: string;
  override readonly cause?: string;
  readonly details?: Record<string, unknown>;

  constructor(input: { code: FlywheelErrorCode; message: string; retryable?: boolean; hint?: string; cause?: string; details?: Record<string, unknown> }) {
    super(input.message);
    this.name = 'FlywheelError';
    this.code = input.code;
    this.retryable = input.retryable ?? DEFAULT_RETRYABLE[input.code];
    this.hint = input.hint;
    this.cause = input.cause;
    this.details = input.details;
  }

  toJSON(): FlywheelToolError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.hint != null && { hint: this.hint }),
      ...(this.cause != null && { cause: this.cause }),
      ...(this.details != null && { details: this.details }),
    };
  }
}

export function throwFlywheelError(input: { code: FlywheelErrorCode; message: string; retryable?: boolean; hint?: string; cause?: string; details?: Record<string, unknown> }): never {
  throw new FlywheelError(input);
}

/**
 * Redact absolute filesystem paths and cap length before embedding raw error
 * messages in MCP-visible structured output. Prevents local-path leakage via
 * FlywheelToolError.cause without losing signal value for debugging.
 */
export function sanitizeCause(raw: string, maxLen = 200): string {
  const homeRedacted = raw.replace(/\/Users\/[^/\s:'"]+/g, '~');
  const unixRedacted = homeRedacted.replace(/\/(?:home|var|tmp|opt|private)\/[^\s:'"]*/g, (m) => {
    const base = m.split('/').slice(-1)[0] ?? '';
    return base ? `<path>/${base}` : '<path>';
  });
  return unixRedacted.length > maxLen ? `${unixRedacted.slice(0, maxLen - 1)}…` : unixRedacted;
}

export function classifyExecError(err: unknown): {
  code: 'exec_timeout' | 'exec_aborted' | 'cli_failure';
  retryable: boolean;
  cause: string;
} {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = sanitizeCause(msg);
  if (/Timed out after \d+ms/.test(msg)) return { code: 'exec_timeout', retryable: true, cause };
  if (/aborted|AbortError/i.test(msg)) return { code: 'exec_aborted', retryable: false, cause };
  return { code: 'cli_failure', retryable: true, cause };
}

export function makeFlywheelErrorResult(
  tool: FlywheelToolName,
  phase: FlywheelPhase,
  input: Omit<FlywheelToolError, 'timestamp' | 'tool' | 'phase'>
): { content: Array<{ type: 'text'; text: string }>; isError: true; structuredContent: FlywheelStructuredError } {
  const error: FlywheelToolError = {
    ...input,
    retryable: input.retryable ?? DEFAULT_RETRYABLE[input.code],
    ...(input.cause != null && { cause: sanitizeCause(input.cause) }),
    phase,
    tool,
    timestamp: new Date().toISOString(),
  };

  // Fire-and-forget telemetry hook (no-op if telemetry module not yet registered)
  try {
    _telemetryHook?.(input.code, input.cause != null ? { hashable: input.cause } : undefined);
  } catch { /* never throw from error result builder */ }

  return {
    content: [{ type: 'text', text: input.message }],
    isError: true,
    structuredContent: {
      tool,
      version: 1,
      status: 'error',
      phase,
      data: { kind: 'error', error },
    },
  };
}
