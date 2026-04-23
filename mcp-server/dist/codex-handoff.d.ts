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
import { type AdaptedPrompt } from './adapters/codex-prompt.js';
import type { FlywheelErrorCode } from './errors.js';
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
export declare const MAX_RECENT_TOOL_CALLS = 10;
/** Maximum length of any free-text field embedded in the packet. */
export declare const MAX_TEXT_FIELD_LENGTH = 2000;
/**
 * Build a `RescuePacket` from the coordinator's stall context. Pure: no
 * I/O, no mutation. Defaults apply when fields are absent so callers can't
 * accidentally produce a malformed packet.
 */
export declare function buildRescuePacket(input: BuildRescuePacketInput): RescuePacket;
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
export declare function renderRescuePromptForCodex(packet: RescuePacket, options: {
    /** Coordinator's Agent Mail name (for the bootstrap STEP 0). */
    coordinatorName: string;
    /** Project key (basename of cwd). */
    projectKey: string;
    /** Adjective+noun rescue agent name. */
    rescueAgentName: string;
}): AdaptedPrompt;
/**
 * Format a rescue event for storage via
 * `flywheel_memory(operation="store", content=<this>)`. The doctor's
 * `rescues_last_30d` synthesis row counts entries whose body contains the
 * canonical prefix below, so callers MUST persist via this formatter rather
 * than rolling their own free-text version.
 */
export declare const RESCUE_EVENT_PREFIX = "flywheel-rescue";
export declare function formatRescueEventForMemory(packet: RescuePacket, isoTs?: string): string;
//# sourceMappingURL=codex-handoff.d.ts.map