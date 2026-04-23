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
import { adaptPromptForCodex, } from './adapters/codex-prompt.js';
/** Maximum number of recent tool calls embedded in a packet. */
export const MAX_RECENT_TOOL_CALLS = 10;
/** Maximum length of any free-text field embedded in the packet. */
export const MAX_TEXT_FIELD_LENGTH = 2000;
/** Truncate to a fixed budget with a single-character ellipsis. */
function clampText(value, maxLen = MAX_TEXT_FIELD_LENGTH) {
    if (value.length <= maxLen)
        return value;
    return `${value.slice(0, maxLen - 1)}…`;
}
/** Truncate a tool-call summary line — tighter cap than free text. */
function clampSummary(value) {
    return clampText(value, 200);
}
/**
 * Build a `RescuePacket` from the coordinator's stall context. Pure: no
 * I/O, no mutation. Defaults apply when fields are absent so callers can't
 * accidentally produce a malformed packet.
 */
export function buildRescuePacket(input) {
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
        proposed_next_step: clampText(input.proposed_next_step ??
            'Diagnose the failing step using artifact_path + recent_tool_calls; propose a concrete fix.'),
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
export function renderRescuePromptForCodex(packet, options) {
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
    const ctx = {
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
export function formatRescueEventForMemory(packet, isoTs = new Date().toISOString()) {
    return [
        `${RESCUE_EVENT_PREFIX} ts=${isoTs} phase=${packet.phase} error_code=${packet.error_code}`,
        `goal: ${packet.goal}`,
        `hint: ${packet.hint || '(none)'}`,
        `artifact: ${packet.artifact_path}`,
        `next_step: ${packet.proposed_next_step}`,
    ].join('\n');
}
// ─── Internal helpers ─────────────────────────────────────────────────
function truncate(s, n) {
    return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
function shortStamp() {
    // YYYYMMDDHHmm — collision-resistant within a session, reproducible per minute.
    const d = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return (`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
        `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`);
}
//# sourceMappingURL=codex-handoff.js.map