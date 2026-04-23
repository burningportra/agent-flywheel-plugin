/**
 * Codex rescue handoff — bead `agent-flywheel-plugin-1qn`.
 *
 * When a flywheel phase (plan / impl / review) stalls — that is, retries
 * on the same operation are about to exhaust — the coordinator surfaces an
 * `AskUserQuestion` offering a `/codex:rescue` handoff. Choosing that branch
 * builds a `RescuePacket` from the live phase state and feeds it to the
 * Codex rescue subagent as a single, structured prompt.
 *
 * DESIGN NOTES
 * ------------
 *  - The packet is the **single source of truth** for everything Codex needs.
 *    It deliberately mirrors the shape of bead 478's actionable `hint` field
 *    (the FlywheelToolError envelope) so the rescue context is a pure copy
 *    of the failing operation's last-known error envelope.
 *  - Rendering is delegated to `adapters/codex-prompt.ts` via its public
 *    `BeadDispatchContext` / `AdaptedPrompt` surface — this module is a
 *    *consumer*, never a modifier of the adapter (per coordination rules
 *    with bead `x6g`).
 *  - This file is pure: zero side effects, zero I/O. Persistence of the
 *    rescue *event* (so `flywheel_doctor` can synthesise `rescues_last_30d`)
 *    happens via `flywheel_memory` `operation="store"` — see
 *    `formatRescueEventForMemory`.
 */

import {
  adaptPromptForCodex,
  type AdaptedPrompt,
  type BeadDispatchContext,
} from './adapters/codex-prompt.js';
import type { FlywheelErrorCode } from './errors.js';

// ─── Types ────────────────────────────────────────────────────────────

/** Which flywheel phase stalled. */
export type RescuePhase = 'plan' | 'impl' | 'review';

/**
 * A single recent tool/CLI call observed before the stall — kept short so
 * the packet stays compact and Codex can scan it without scrolling.
 */
export interface RescueToolCall {
  /** Wall-clock ISO timestamp of the call. */
  readonly ts: string;
  /** Name of the tool / CLI command. */
  readonly name: string;
  /** Outcome — used by Codex to triage what to retry vs. avoid. */
  readonly outcome: 'ok' | 'error' | 'timeout';
  /** One-line summary (≤200 chars; truncate aggressively). */
  readonly summary: string;
}

/**
 * Structured payload handed to `/codex:rescue`. Every field is required so
 * Codex receives a complete frame — there is no "discover from CWD" implied.
 */
export interface RescuePacket {
  /** Stalled phase. */
  readonly phase: RescuePhase;
  /** The user's selected goal or the bead's title — what we were trying to do. */
  readonly goal: string;
  /**
   * Path on disk to the phase artifact (plan markdown, impl diff dump,
   * review-comments file). Codex reads this for full context.
   */
  readonly artifact_path: string;
  /**
   * The terminal `FlywheelErrorCode` on the failing operation. Drives Codex's
   * triage decision (e.g. `cli_failure` → run the command manually,
   * `parse_failure` → inspect the raw output).
   */
  readonly error_code: FlywheelErrorCode;
  /**
   * Actionable hint copied **verbatim** from the failing operation's
   * `FlywheelToolError.hint` (bead 478 contract). MUST be a single-sentence
   * imperative. Empty string is allowed only when the error envelope had no
   * hint — callers should treat that as a bug to log.
   */
  readonly hint: string;
  /** Up to 10 recent tool calls (oldest → newest). */
  readonly recent_tool_calls: readonly RescueToolCall[];
  /**
   * Coordinator's best guess at what to try next — Codex may override, but
   * this anchors the rescue conversation.
   */
  readonly proposed_next_step: string;
}

// ─── Builder ──────────────────────────────────────────────────────────

/**
 * Inputs the coordinator already has when a stall fires. Keeping this
 * separate from `RescuePacket` lets us validate / clamp / default fields
 * without leaking those rules into the packet shape.
 */
export interface BuildRescuePacketInput {
  readonly phase: RescuePhase;
  readonly goal: string;
  readonly artifact_path: string;
  readonly error_code: FlywheelErrorCode;
  /** Hint from the failing tool's error envelope (bead 478 contract). */
  readonly hint?: string;
  readonly recent_tool_calls?: readonly RescueToolCall[];
  readonly proposed_next_step?: string;
}

/** Maximum number of recent tool calls embedded in a packet. */
export const MAX_RECENT_TOOL_CALLS = 10;

/** Maximum length of any free-text field embedded in the packet. */
export const MAX_TEXT_FIELD_LENGTH = 2000;

/** Truncate to a fixed budget with a single-character ellipsis. */
function clampText(value: string, maxLen: number = MAX_TEXT_FIELD_LENGTH): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen - 1)}…`;
}

/** Truncate a tool-call summary line — tighter cap than free text. */
function clampSummary(value: string): string {
  return clampText(value, 200);
}

/**
 * Build a `RescuePacket` from the coordinator's stall context. Pure: no
 * I/O, no mutation. Defaults apply when fields are absent so callers can't
 * accidentally produce a malformed packet.
 */
export function buildRescuePacket(input: BuildRescuePacketInput): RescuePacket {
  const recent = (input.recent_tool_calls ?? []).slice(-MAX_RECENT_TOOL_CALLS).map((c) => ({
    ts: c.ts,
    name: c.name,
    outcome: c.outcome,
    summary: clampSummary(c.summary),
  }));

  return {
    phase: input.phase,
    goal: clampText(input.goal),
    artifact_path: input.artifact_path,
    error_code: input.error_code,
    hint: clampText(input.hint ?? ''),
    recent_tool_calls: recent,
    proposed_next_step: clampText(
      input.proposed_next_step ??
        'Diagnose the failing step using artifact_path + recent_tool_calls; propose a concrete fix.',
    ),
  };
}

// ─── Rendering ────────────────────────────────────────────────────────

/**
 * Render a rescue packet into the Codex-tuned prompt body that
 * `/codex:rescue` consumes. Internally builds a `BeadDispatchContext` and
 * delegates to `adaptPromptForCodex` — this is the **only** way this module
 * touches the adapter (per coordination rule with bead `x6g`).
 *
 * The packet's `hint`, `error_code`, and `proposed_next_step` are folded
 * into the dispatch context's `description` so the adapter's existing
 * STEP 1 / STEP 2 / STEP 3 / STEP 4 scaffolding still applies.
 */
export function renderRescuePromptForCodex(
  packet: RescuePacket,
  options: {
    /** Coordinator's Agent Mail name (for the bootstrap STEP 0). */
    coordinatorName: string;
    /** Project key (basename of cwd). */
    projectKey: string;
    /** Adjective+noun rescue agent name. */
    rescueAgentName: string;
  },
): AdaptedPrompt {
  const beadId = `rescue-${packet.phase}-${shortStamp()}`;
  const title = `${packet.phase} rescue — ${truncate(packet.goal, 80)}`;

  const description = [
    `Phase that stalled: ${packet.phase}`,
    `Goal: ${packet.goal}`,
    `Stalled error_code: ${packet.error_code}`,
    `Hint (verbatim from failing operation): ${packet.hint || '(none — error envelope was missing a hint; investigate)'}`,
    `Phase artifact: ${packet.artifact_path}`,
    '',
    'Recent tool calls (oldest → newest):',
    ...packet.recent_tool_calls.map((c) => `  - ${c.ts} ${c.name} [${c.outcome}] ${c.summary}`),
    '',
    `Coordinator's proposed next step (you may override): ${packet.proposed_next_step}`,
  ].join('\n');

  const acceptance = [
    'Diagnose the root cause of the stall using the artifact + recent tool calls.',
    'Propose a concrete next step (commands, code edits, or a clarifying question).',
    'If you produce a code fix, return a unified diff in the COMPLETION_REPORT block.',
    'If you cannot proceed, explain WHY in one paragraph and list what would unblock you.',
  ];

  const ctx: BeadDispatchContext = {
    beadId,
    title,
    description,
    acceptance,
    complexity: 'complex', // rescue == hard by definition; trigger reasoning preamble.
    relevantFiles: [packet.artifact_path],
    priorArtBeads: [],
    agentName: options.rescueAgentName,
    coordinatorName: options.coordinatorName,
    projectKey: options.projectKey,
  };

  return adaptPromptForCodex(ctx);
}

// ─── Persistence helper ───────────────────────────────────────────────

/**
 * Format a rescue event for storage via
 * `flywheel_memory(operation="store", content=<this>)`. The doctor's
 * `rescues_last_30d` synthesis row counts entries whose body contains the
 * canonical prefix below, so callers MUST persist via this formatter rather
 * than rolling their own free-text version.
 */
export const RESCUE_EVENT_PREFIX = 'flywheel-rescue';

export function formatRescueEventForMemory(packet: RescuePacket, isoTs: string = new Date().toISOString()): string {
  return [
    `${RESCUE_EVENT_PREFIX} ts=${isoTs} phase=${packet.phase} error_code=${packet.error_code}`,
    `goal: ${packet.goal}`,
    `hint: ${packet.hint || '(none)'}`,
    `artifact: ${packet.artifact_path}`,
    `next_step: ${packet.proposed_next_step}`,
  ].join('\n');
}

// ─── Internal helpers ─────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function shortStamp(): string {
  // YYYYMMDDHHmm — collision-resistant within a session, reproducible per minute.
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`
  );
}
