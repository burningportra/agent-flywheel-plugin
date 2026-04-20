import { z } from 'zod';
import type { FlywheelToolName, FlywheelPhase } from './types.js';

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

export function classifyExecError(err: unknown): {
  code: 'exec_timeout' | 'exec_aborted' | 'cli_failure';
  retryable: boolean;
  cause: string;
} {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Timed out after \d+ms/.test(msg)) return { code: 'exec_timeout', retryable: true, cause: msg };
  if (/aborted|AbortError/i.test(msg)) return { code: 'exec_aborted', retryable: false, cause: msg };
  return { code: 'cli_failure', retryable: true, cause: msg };
}

export function makeFlywheelErrorResult(
  tool: FlywheelToolName,
  phase: FlywheelPhase,
  input: Omit<FlywheelToolError, 'timestamp' | 'tool' | 'phase'>
): { content: Array<{ type: 'text'; text: string }>; isError: true; structuredContent: FlywheelStructuredError } {
  const error: FlywheelToolError = {
    ...input,
    retryable: input.retryable ?? DEFAULT_RETRYABLE[input.code],
    phase,
    tool,
    timestamp: new Date().toISOString(),
  };
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
