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
  // agent-flywheel-plugin-f0j — review-mode matrix
  'review_mode_gate_failed',
  'review_headless_findings',
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

/**
 * Default actionable hint per error code.
 *
 * Acts as a safety net so every FlywheelError carries a non-empty,
 * remediation-oriented hint even if the call site forgets to pass one.
 * Call sites SHOULD still pass a contextual hint when they have more
 * specific information (e.g. the exact CLI invocation that failed) —
 * the per-call hint always wins. The contract enforced by
 * error-contract.test.ts: each value must be a sentence > 30 chars and
 * MUST NOT echo the code name (`hint !== code`).
 *
 * Added in agent-flywheel-plugin-9p3 to give the iteration test a
 * single source of truth to assert against, parallel to
 * DEFAULT_RETRYABLE.
 */
export const DEFAULT_HINTS: Record<FlywheelErrorCode, string> = {
  missing_prerequisite:
    'A required prerequisite (CLI tool, file, or state) is missing — run `/flywheel-setup` to install dependencies, then retry.',
  invalid_input:
    'The tool was called with an argument that failed schema validation — re-read the tool description and pass the documented shape.',
  not_found:
    'The requested resource (bead, plan, or memory entry) does not exist — confirm the id with `br list` or `flywheel_memory operation=search` before retrying.',
  cli_failure:
    'A shell command exited non-zero — re-run it manually to inspect stderr, then retry the tool once the underlying issue is fixed.',
  cli_not_available:
    'A required CLI is not installed or not on PATH — install it (e.g. `npm install -g <tool>`) and verify with `<tool> --version`, then retry.',
  parse_failure:
    'Output from a downstream tool could not be parsed — inspect the raw payload (set FW_LOG_LEVEL=debug) and file an upstream bug if the shape is unexpected.',
  exec_timeout:
    'The command exceeded its timeout budget — split the work, raise the timeout, or check whether the downstream tool is hung; this is usually retryable.',
  exec_aborted:
    'The operation was aborted via AbortSignal — this is usually a caller-initiated cancellation and is NOT retried automatically.',
  blocked_state:
    'The flywheel is in a phase that does not permit this action — check current phase via `flywheel_status` and run the appropriate transition first.',
  concurrent_write:
    'Another invocation holds the write lock — wait briefly and retry, or run `/flywheel-cleanup` if you suspect a stuck lock from a crashed session.',
  agent_mail_unreachable:
    'The agent-mail MCP server at http://127.0.0.1:8765/mcp did not respond — start it with `npx agent-mail-server` and verify with `lsof -i :8765`.',
  deep_plan_all_failed:
    'All deep-plan model providers failed — check API credentials and rate limits, then retry; consider /flywheel-doctor to inspect provider health.',
  empty_plan:
    'The planner produced zero beads — refine the goal description with more concrete acceptance criteria and re-run `flywheel_plan`.',
  already_closed:
    'The target bead is already in `closed` status — this is idempotent; no action needed unless you intended to re-open via `br update --status open`.',
  unsupported_action:
    'The requested action is not supported in the current context — re-read the tool description for the list of valid actions in this phase.',
  internal_error:
    'An unexpected internal error occurred — capture the cause string, file an issue, and retry; this is usually transient.',
  doctor_check_failed:
    'A doctor check raised an unrecoverable error — see the `cause` field for the underlying message and fix the reported issue, then re-run `/flywheel-doctor`.',
  doctor_partial_report:
    'Doctor completed but some checks were skipped — review the `details.skipped` list; the remaining checks still produced a usable report.',
  hotspot_parse_failure:
    'The hotspot analyzer could not parse a required input file — verify the file exists and is well-formed JSON/markdown, then retry.',
  hotspot_bead_body_unparseable:
    'A bead body did not match the expected hotspot section schema — inspect the bead with `br show <id>` and reformat the body before retrying.',
  postmortem_empty_session:
    'Post-mortem ran against a session with no recorded activity — confirm `.pi-flywheel/checkpoint.json` and telemetry exist, then retry.',
  postmortem_checkpoint_stale:
    'The checkpoint pre-dates the analysis window — re-run the flywheel session or pass an explicit `--since` argument to widen the window.',
  template_not_found:
    'The named template is not registered in the bead-template library — list available templates and verify the slug spelling before retrying.',
  template_placeholder_missing:
    'A required template placeholder was not provided — see `details.missing` for the field list and pass them in the call.',
  template_expansion_failed:
    'Template expansion threw mid-render — inspect `cause` for the underlying error; this is sometimes transient if the template library is reloading.',
  telemetry_store_failed:
    'Could not write telemetry to disk — check filesystem permissions on `.pi-flywheel/telemetry/` and retry; transient disk contention is recoverable.',
  wave_collision_detected:
    'Two beads in the same wave wrote to overlapping files — re-run the affected beads serially via `flywheel_review hit-me <bead-id>`.',
  review_mode_gate_failed:
    'The review-mode autofix gate refused the change — inspect the gate findings, address each one manually, and re-run review.',
  review_headless_findings:
    'Headless review surfaced findings that require human attention — read the findings list and act on each before closing the bead.',
};

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
  // agent-flywheel-plugin-f0j — autofix gate is not transient; headless
  // findings are a signal to the caller, not a retryable condition.
  review_mode_gate_failed: false,
  review_headless_findings: false,
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
    // Fall back to DEFAULT_HINTS so every FlywheelError carries an
    // actionable hint even if the call site forgot to pass one.
    this.hint = input.hint ?? DEFAULT_HINTS[input.code];
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
