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
  // claude-orchestrator-22i — remediation/bundle/viewer
  'remediation_unavailable',
  'remediation_requires_confirm',
  'remediation_failed',
  'remediate_already_running',
  'bundle_integrity_failed',
  'bundle_stale',
  'viewer_port_in_use',
  // claude-orchestrator-xsz — Completion Evidence Attestation gate (T2)
  'attestation_missing',
  'attestation_invalid',
  // v3.13.0 outcome-grading (claude-orchestrator-25w / T1) — rubric synth,
  // grader spawn, verdict parse, iteration loop, decorrelation guards.
  'rubric_synth_invalid',
  'rubric_missing',
  'grader_timeout',
  'verdict_invalid',
  'grader_unavailable',
  'cycle_start_sha_unset',
  'outcome_iteration_capped',
  'concurrent_grade',
  // v3.14.0 beads-compliance audit
  'compliance_false_closed',
] as const;

export const FlywheelErrorCodeSchema = z.enum(FLYWHEEL_ERROR_CODES);
export type FlywheelErrorCode = z.infer<typeof FlywheelErrorCodeSchema>;

/**
 * T1.2 (v3.16.0 noob-onboarding) — type-level enforcement that every
 * FlywheelErrorCode carries both a narrative `hint` and an imperative,
 * paste-ready `tryThis`. The data itself lives in `errors-try-this.ts`
 * as `ERROR_META: Record<FlywheelErrorCode, ErrorMeta>`; a missing key
 * (compile-time) or empty string (runtime test + verify-error-meta.js
 * build gate) fails the build.
 *
 * Field naming: snake_case (`try_this`) is preserved on the wire
 * envelope (`FlywheelToolError`); camelCase (`tryThis`) is the
 * internal-only meta shape consumed by `format-error.ts` (T1.3).
 */
export type ErrorMeta = {
  readonly hint: string;
  readonly tryThis: string;
};

export const FlywheelToolErrorSchema = z.object({
  code: FlywheelErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean().optional(),
  hint: z.string().optional(),
  /**
   * R-007 — concrete next-step the caller can paste/execute. Where `hint`
   * is narrative ("a required prerequisite is missing"), `try_this` is
   * imperative ("Run flywheel_profile(cwd: <repo-root>) first."). Always
   * defaulted from DEFAULT_TRY_THIS; per-call overrides win.
   */
  try_this: z.string().optional(),
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
  compliance_false_closed:
    'Compliance audit found a closed bead that does not meet completion requirements — reopen the bead, fix the evidence or implementation, and rerun the audit.',
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
    'The agent-mail MCP server at http://127.0.0.1:8765/mcp did not respond — start the Rust port with `am serve-http` (or `mcp-agent-mail serve`) and verify with `lsof -i :8765`.',
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
  remediation_unavailable:
    'No automated remediation exists for this check; follow the manual hint in the doctor report.',
  remediation_requires_confirm:
    'Mutating remediation refused without explicit consent. Set `autoConfirm: true` after the user approves.',
  remediation_failed:
    'The remediation handler exited non-zero. Inspect the captured stderr; re-run the original doctor check.',
  remediate_already_running:
    'Another remediation for this check is in flight. Wait for the lock to release or call again with a different `checkName`.',
  bundle_integrity_failed:
    'skills.bundle.json failed its manifestSha256 integrity check. Falling back to disk reads. Re-run `npm run build` to regenerate.',
  bundle_stale:
    "A bundled skill's source `.md` has changed on disk. The bundle is still served (stable-by-default); set FW_SKILL_BUNDLE=off to read live or rebuild.",
  viewer_port_in_use:
    'All retried bead-viewer ports are in use. Try `--port <N>` with a free port or kill the existing viewer.',
  attestation_missing:
    'A bead reported closed but no completion attestation found at `.pi-flywheel/completion/<beadId>.json` — the implementor must write the CompletionReport JSON before the wave can advance.',
  attestation_invalid:
    'A completion attestation failed schema or cross-bead validation — re-read the bead, fix the report shape (or the underlying invariant violation like status=closed without beadClosedVerified=true), and rewrite `.pi-flywheel/completion/<beadId>.json`.',
  // v3.13.0 outcome-grading hints (verbatim from synthesized plan §"Error hints").
  rubric_synth_invalid:
    'Synthesizer returned non-conforming YAML — re-run with force=true, or hand-edit .pi-flywheel/plans/<slug>/rubric.md and set source=user.',
  rubric_missing:
    'No rubric found for the active plan — run flywheel_synthesize_rubric, or pick Skip rubric at the plan-approve gate.',
  grader_timeout:
    'Grader exceeded FW_GRADER_TIMEOUT_MS — raise the budget, retry, or fall back to a smaller diff via artifactRefs.modifiedFilePaths.',
  verdict_invalid:
    'Grader stdout did not parse against GraderVerdictSchemaV1 — one auto-retry has already fired; inspect the raw payload at debug log level.',
  grader_unavailable:
    'Neither codex_cli nor a fresh-context Agent fallback is healthy — run /flywheel-doctor and remediate codex_cli or claude_cli.',
  cycle_start_sha_unset:
    'cycleStartSha was not captured at flywheel_select — using checkpoint.gitHead or HEAD~50 fallback; commit a baseline to fix.',
  outcome_iteration_capped:
    'maxOutcomeIterations reached — accept the verdict, abort the cycle, or raise FW_MAX_OUTCOME_ITERATIONS (bounded [1,5]) before the next cycle.',
  concurrent_grade:
    'Another grader is in flight for this plan — wait for it to complete, or pass force=true to override the in-memory mutex.',
};

/**
 * R-007 — default `try_this` per error code. Imperative, paste-ready.
 *
 * Where DEFAULT_HINTS describes what went wrong, DEFAULT_TRY_THIS tells
 * the agent the exact next call/command to make. Call sites SHOULD pass
 * a more specific try_this when they have one (e.g. naming the exact
 * field, the rejected enum value, the sample corrected invocation) —
 * the per-call value wins.
 *
 * Contract (enforced by error-contract.test.ts and capabilities snapshot):
 *   - every entry MUST be present (TypeScript Record enforces)
 *   - every entry MUST start with an imperative verb (Run, Call, Set, etc.)
 *   - every entry MUST be > 30 chars
 *   - every entry MUST NOT echo the code name verbatim
 */
export const DEFAULT_TRY_THIS: Record<FlywheelErrorCode, string> = {
  missing_prerequisite:
    'Run flywheel_profile(cwd: <repo-root>) first; if that does not clear the error, run /flywheel-doctor and remediate the failing checks.',
  invalid_input:
    'Call flywheel_capabilities to see required/optional fields and enum values for this tool, then re-call with the corrected shape.',
  not_found:
    "Run `br list --json | jq -r '.[].id'` to see valid bead IDs (or flywheel_memory operation:'search') before retrying.",
  cli_failure:
    'Re-run the underlying CLI by hand to see the raw stderr; set FW_LOG_LEVEL=debug for the wrapped trace, then retry.',
  cli_not_available:
    'Install the missing CLI (see the message for the binary name) and re-run /flywheel-doctor to confirm it is on PATH.',
  compliance_false_closed:
    'Reopen the false-closed bead with `br update <id> --status open`, fix the implementation or evidence, then re-run flywheel_compliance_audit.',
  parse_failure:
    'Set FW_LOG_LEVEL=debug, re-run, and inspect the raw payload in the trace; if the upstream shape is wrong, file an upstream bug.',
  exec_timeout:
    'Retry once. If it persists, raise the timeout via the relevant FW_*_TIMEOUT_MS env var (see flywheel_capabilities env_vars) or split the work.',
  exec_aborted:
    'This was a caller-initiated abort and is not auto-retried; re-issue the call when ready.',
  blocked_state:
    'Call flywheel_observe(cwd) to see the current phase, then run the appropriate transition tool before retrying.',
  concurrent_write:
    'Wait briefly and retry. If a stuck lock is suspected, run /flywheel-cleanup --dry-run first to see what would be released.',
  agent_mail_unreachable:
    'Start the agent-mail server with `am serve-http` (or `mcp-agent-mail serve`); verify with `lsof -i :8765` then retry.',
  deep_plan_all_failed:
    'Run /flywheel-doctor to inspect provider health (codex, claude, gemini); fix credentials/rate limits; retry flywheel_plan.',
  empty_plan:
    'Refine the goal with concrete acceptance criteria (one paragraph), then re-run flywheel_plan; pass mode:"deep" if a richer plan is needed.',
  already_closed:
    'No action needed. To re-open intentionally: `br update <id> --status open`.',
  unsupported_action:
    'Call flywheel_capabilities and read mcp_tools[] for the action enum valid in this phase; pick one of those values.',
  internal_error:
    'Capture the cause string for the bug report, then retry once. If it reproduces, set FW_LOG_LEVEL=debug for a fuller trace.',
  doctor_check_failed:
    'Read the cause field for the failing check, fix the underlying issue, then re-run /flywheel-doctor.',
  doctor_partial_report:
    'Inspect details.skipped to see which checks did not run; the remaining report is still actionable.',
  hotspot_parse_failure:
    'Verify the input file exists and is well-formed JSON/markdown (cat or jq it), then retry.',
  hotspot_bead_body_unparseable:
    'Run `br show <id>` to inspect the bead body; reformat to match the hotspot schema, then retry.',
  postmortem_empty_session:
    'Confirm `.pi-flywheel/checkpoint.json` and `.pi-flywheel/telemetry/` exist; if not, no session has been run yet — start a flywheel cycle first.',
  postmortem_checkpoint_stale:
    'Pass an explicit `--since <iso-date>` argument to widen the analysis window, or start a fresh flywheel cycle.',
  template_not_found:
    'List available templates via the bead-templates tool; verify the slug spelling, then retry with the correct slug.',
  template_placeholder_missing:
    'Read details.missing for the field list, then re-call with all required placeholders provided.',
  template_expansion_failed:
    'Inspect cause for the underlying error; if it mentions reload, retry once — template library may have been mid-refresh.',
  telemetry_store_failed:
    'Check filesystem permissions on `.pi-flywheel/telemetry/`; if the disk is full, free space and retry.',
  wave_collision_detected:
    'Re-run the colliding beads serially via `flywheel_review(cwd, beadId, action:"hit-me")` one at a time.',
  review_mode_gate_failed:
    'Read the gate findings, address each one manually (commit the fixes), then re-run flywheel_review with the same beadId.',
  review_headless_findings:
    'Read the findings list, act on each, then re-run flywheel_review(action:"looks-good") to close the bead.',
  remediation_unavailable:
    'Read the failing doctor check\'s manual hint; flywheel_remediate has no automated handler for this check.',
  remediation_requires_confirm:
    'Re-call flywheel_remediate with autoConfirm:true after the user approves the dry_run plan.',
  remediation_failed:
    'Inspect the captured stderr in the response; re-run /flywheel-doctor to see whether the original symptom persists.',
  remediate_already_running:
    'Wait for the in-flight remediation to settle (see the lock holder in details), then retry.',
  bundle_integrity_failed:
    'Run `npm run build` in mcp-server/ to regenerate skills.bundle.json; the server falls back to disk reads in the meantime.',
  bundle_stale:
    'Run `npm run build` to refresh the bundle; or set FW_SKILL_BUNDLE=off to bypass and read live from disk.',
  viewer_port_in_use:
    'Pass `--port <N>` with a free port (e.g. 8766), or kill the existing viewer (lsof -i :<port>).',
  attestation_missing:
    'The implementor must write `.pi-flywheel/completion/<beadId>.json` (CompletionReport schema) before flywheel_advance_wave can proceed.',
  attestation_invalid:
    'Run `cat .pi-flywheel/completion/<beadId>.json | jq .` to see the current shape; fix per the schema_url for CompletionReport, then retry.',
  rubric_synth_invalid:
    'Re-run flywheel_synthesize_rubric with force:true; or hand-edit `.pi-flywheel/plans/<slug>/rubric.md` and the source field flips to "user".',
  rubric_missing:
    'Run flywheel_synthesize_rubric(cwd, planSlug:"<slug>") first; or pass force:true on grade_outcome to skip the rubric gate.',
  grader_timeout:
    'Raise FW_GRADER_TIMEOUT_MS (default 180000) or pass artifactRefs.modifiedFilePaths to scope the grader to a smaller diff.',
  verdict_invalid:
    'Set FW_LOG_LEVEL=debug and re-run; inspect the raw grader stdout in the trace. The auto-retry has already fired once.',
  grader_unavailable:
    'Run /flywheel-doctor to triage codex_cli and claude_cli health; install the missing one or set FW_GRADER_FORCE_CLAUDE=1.',
  cycle_start_sha_unset:
    'Commit a baseline (git commit --allow-empty -m "baseline"), or pass an explicit cycleStartSha; the fallback (HEAD~50) is in use.',
  outcome_iteration_capped:
    'Accept the current verdict, abort the cycle, or raise FW_MAX_OUTCOME_ITERATIONS (max 5) before starting the next cycle.',
  concurrent_grade:
    'Wait for the in-flight grader to settle, or pass force:true to override the in-memory mutex.',
};

export const DEFAULT_RETRYABLE: Record<FlywheelErrorCode, boolean> = {
  missing_prerequisite: false,
  invalid_input: false,
  not_found: false,
  cli_failure: true,
  cli_not_available: false,
  compliance_false_closed: false,
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
  // claude-orchestrator-22i — remediation/bundle/viewer
  remediation_unavailable: false,
  remediation_requires_confirm: false,
  remediation_failed: false,
  remediate_already_running: true,
  bundle_integrity_failed: true,
  bundle_stale: false,
  viewer_port_in_use: false,
  // claude-orchestrator-xsz — attestation gate; missing/invalid is on the
  // implementor to fix, not transient
  attestation_missing: false,
  attestation_invalid: false,
  // v3.13.0 outcome-grading retryability — grader_timeout is transient (raise
  // the budget or retry); rubric/verdict/cycle/iteration codes are operator-
  // or implementor-fix conditions; concurrent_grade clears once the in-flight
  // call settles but is not auto-retried inside the same caller.
  rubric_synth_invalid: false,
  rubric_missing: false,
  grader_timeout: true,
  verdict_invalid: false,
  grader_unavailable: false,
  cycle_start_sha_unset: false,
  outcome_iteration_capped: false,
  concurrent_grade: false,
};

export class FlywheelError extends Error {
  readonly code: FlywheelErrorCode;
  readonly retryable: boolean;
  readonly hint?: string;
  /** R-007 — paste-ready next-step. Defaulted from DEFAULT_TRY_THIS. */
  readonly try_this?: string;
  override readonly cause?: string;
  readonly details?: Record<string, unknown>;

  constructor(input: { code: FlywheelErrorCode; message: string; retryable?: boolean; hint?: string; try_this?: string; cause?: string; details?: Record<string, unknown> }) {
    super(input.message);
    this.name = 'FlywheelError';
    this.code = input.code;
    this.retryable = input.retryable ?? DEFAULT_RETRYABLE[input.code];
    // Fall back to DEFAULT_HINTS / DEFAULT_TRY_THIS so every FlywheelError
    // carries actionable guidance even if the call site forgot to pass it.
    this.hint = input.hint ?? DEFAULT_HINTS[input.code];
    this.try_this = input.try_this ?? DEFAULT_TRY_THIS[input.code];
    this.cause = input.cause;
    this.details = input.details;
  }

  toJSON(): FlywheelToolError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.hint !== undefined && this.hint !== null && { hint: this.hint }),
      ...(this.try_this !== undefined && this.try_this !== null && { try_this: this.try_this }),
      ...(this.cause !== undefined && this.cause !== null && { cause: this.cause }),
      ...(this.details !== undefined && this.details !== null && { details: this.details }),
    };
  }
}

export function throwFlywheelError(input: { code: FlywheelErrorCode; message: string; retryable?: boolean; hint?: string; try_this?: string; cause?: string; details?: Record<string, unknown> }): never {
  throw new FlywheelError(input);
}

/**
 * Coerce an `unknown` caught error to its message string. Equivalent to the
 * inline `err instanceof Error ? err.message : String(err)` pattern but keeps
 * call sites readable. Pure, total over `unknown`, never throws.
 */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  const msg = errMsg(err);
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
    // R-007 — auto-fill hint and try_this from the per-code defaults so
    // every error envelope carries both fields. Per-call values win.
    hint: input.hint ?? DEFAULT_HINTS[input.code],
    try_this: input.try_this ?? DEFAULT_TRY_THIS[input.code],
    ...(input.cause !== undefined && input.cause !== null && { cause: sanitizeCause(input.cause) }),
    phase,
    tool,
    timestamp: new Date().toISOString(),
  };

  // Fire-and-forget telemetry hook (no-op if telemetry module not yet registered)
  try {
    _telemetryHook?.(
      input.code,
      input.cause !== undefined && input.cause !== null ? { hashable: input.cause } : undefined,
    );
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
