/**
 * Tests for bead `agent-flywheel-plugin-1qn` — codex rescue handoff.
 *
 * Covers:
 *   1. Round-trip: buildRescuePacket preserves every field, clamps oversized
 *      free-text, truncates the recent-tool-calls history, and substitutes
 *      a sensible default proposed_next_step when absent.
 *   2. hint contract (bead 478): the packet's hint is copied verbatim from
 *      the caller, and absent hints become the empty string so downstream
 *      renderers can detect "envelope had no hint" themselves.
 *   3. Doctor rescue count synthesis: countRescueEntriesWithin30Days
 *      accepts both cm payload shapes and respects the 30-day cutoff.
 *   4. Simulated stall-detection: a phase that hits the N-1th retry on the
 *      same FlywheelErrorCode produces a RescuePacket whose error_code and
 *      hint match the failing envelope.
 */
import { describe, it, expect } from 'vitest';
import { buildRescuePacket, formatRescueEventForMemory, renderRescuePromptForCodex, MAX_RECENT_TOOL_CALLS, MAX_TEXT_FIELD_LENGTH, RESCUE_EVENT_PREFIX, } from '../codex-handoff.js';
import { countRescueEntriesWithin30Days } from '../tools/doctor.js';
// ─── Helpers ───────────────────────────────────────────────────────────
function makeToolCall(name, outcome = 'error') {
    return {
        ts: '2026-04-23T12:00:00.000Z',
        name,
        outcome,
        summary: `${name} failed with exit 1`,
    };
}
// ─── Packet round-trip ────────────────────────────────────────────────
describe('buildRescuePacket', () => {
    it('preserves every field through a round-trip for a well-formed input', () => {
        const packet = buildRescuePacket({
            phase: 'impl',
            goal: 'Wire codex-rescue handoff',
            artifact_path: '.pi-flywheel/rescue/impl-foo-123.diff',
            error_code: 'cli_failure',
            hint: 'Run `npm run build` manually to inspect the failure.',
            recent_tool_calls: [makeToolCall('npm run build'), makeToolCall('git diff')],
            proposed_next_step: 'Apply a minimal fixup then re-run tests.',
        });
        expect(packet.phase).toBe('impl');
        expect(packet.goal).toBe('Wire codex-rescue handoff');
        expect(packet.artifact_path).toBe('.pi-flywheel/rescue/impl-foo-123.diff');
        expect(packet.error_code).toBe('cli_failure');
        expect(packet.hint).toBe('Run `npm run build` manually to inspect the failure.');
        expect(packet.recent_tool_calls).toHaveLength(2);
        expect(packet.recent_tool_calls[0].name).toBe('npm run build');
        expect(packet.proposed_next_step).toBe('Apply a minimal fixup then re-run tests.');
    });
    it('clamps oversized free-text fields to MAX_TEXT_FIELD_LENGTH', () => {
        const huge = 'x'.repeat(MAX_TEXT_FIELD_LENGTH * 3);
        const packet = buildRescuePacket({
            phase: 'plan',
            goal: huge,
            artifact_path: 'docs/plans/huge.md',
            error_code: 'parse_failure',
            hint: huge,
            proposed_next_step: huge,
        });
        expect(packet.goal.length).toBe(MAX_TEXT_FIELD_LENGTH);
        expect(packet.hint.length).toBe(MAX_TEXT_FIELD_LENGTH);
        expect(packet.proposed_next_step.length).toBe(MAX_TEXT_FIELD_LENGTH);
    });
    it('caps recent_tool_calls at MAX_RECENT_TOOL_CALLS, keeping the newest', () => {
        const calls = [];
        for (let i = 0; i < 25; i++)
            calls.push(makeToolCall(`tool-${i}`));
        const packet = buildRescuePacket({
            phase: 'impl',
            goal: 'stall sim',
            artifact_path: 'x.diff',
            error_code: 'cli_failure',
            recent_tool_calls: calls,
        });
        expect(packet.recent_tool_calls).toHaveLength(MAX_RECENT_TOOL_CALLS);
        expect(packet.recent_tool_calls[0].name).toBe(`tool-${25 - MAX_RECENT_TOOL_CALLS}`);
        expect(packet.recent_tool_calls[MAX_RECENT_TOOL_CALLS - 1].name).toBe('tool-24');
    });
    it('substitutes a sensible default proposed_next_step when absent', () => {
        const packet = buildRescuePacket({
            phase: 'review',
            goal: 'tie-break reviewers',
            artifact_path: '.pi-flywheel/rescue/review-foo.md',
            error_code: 'parse_failure',
        });
        expect(packet.proposed_next_step).toMatch(/diagnose|artifact_path/i);
    });
    it('copies the hint verbatim from the failing envelope (bead 478 contract)', () => {
        // Simulate the coordinator reading a FlywheelToolError:
        const simulatedEnvelope = {
            code: 'cli_failure',
            message: 'npm run build failed',
            hint: 'Run `npm run build` locally and paste the first error message.',
        };
        const packet = buildRescuePacket({
            phase: 'impl',
            goal: 'wire rescue',
            artifact_path: 'x.diff',
            error_code: simulatedEnvelope.code,
            hint: simulatedEnvelope.hint,
        });
        expect(packet.hint).toBe(simulatedEnvelope.hint);
    });
    it('absent hint becomes the empty string so renderers detect "no hint"', () => {
        const packet = buildRescuePacket({
            phase: 'plan',
            goal: 'g',
            artifact_path: 'p.md',
            error_code: 'empty_plan',
        });
        expect(packet.hint).toBe('');
    });
});
// ─── Memory-event formatter ───────────────────────────────────────────
describe('formatRescueEventForMemory', () => {
    it('emits the canonical RESCUE_EVENT_PREFIX so the doctor synthesis can count it', () => {
        const packet = buildRescuePacket({
            phase: 'impl',
            goal: 'g',
            artifact_path: 'p.diff',
            error_code: 'cli_failure',
            hint: 'h',
        });
        const body = formatRescueEventForMemory(packet, '2026-04-23T10:00:00.000Z');
        expect(body.startsWith(RESCUE_EVENT_PREFIX)).toBe(true);
        expect(body).toContain('phase=impl');
        expect(body).toContain('error_code=cli_failure');
        expect(body).toContain('ts=2026-04-23T10:00:00.000Z');
    });
    it('represents an absent hint explicitly so the row is still auditable', () => {
        const packet = buildRescuePacket({
            phase: 'plan',
            goal: 'g',
            artifact_path: 'p.md',
            error_code: 'empty_plan',
        });
        expect(formatRescueEventForMemory(packet, '2026-04-23T10:00:00.000Z')).toContain('hint: (none)');
    });
});
// ─── Codex-prompt adapter consumption ─────────────────────────────────
describe('renderRescuePromptForCodex', () => {
    it('delegates to codex-prompt.ts and returns provider=codex with 2 trailing newlines', () => {
        const packet = buildRescuePacket({
            phase: 'impl',
            goal: 'g',
            artifact_path: 'x.diff',
            error_code: 'cli_failure',
            hint: 'Run npm run build manually.',
            recent_tool_calls: [makeToolCall('npm run build')],
        });
        const out = renderRescuePromptForCodex(packet, {
            coordinatorName: 'CoralDune',
            projectKey: 'agent-flywheel-plugin',
            rescueAgentName: 'AmberLynx',
        });
        expect(out.provider).toBe('codex');
        expect(out.trailingNewlines).toBe(2);
        // The adapter's STEP 0 bootstrap is mandatory — verify it's embedded.
        expect(out.prompt).toContain('STEP 0 — AGENT MAIL BOOTSTRAP');
        expect(out.prompt).toContain('AmberLynx');
        expect(out.prompt).toContain('CoralDune');
        // Rescue-specific context bleeds through the description block.
        expect(out.prompt).toContain('cli_failure');
        expect(out.prompt).toContain('Run npm run build manually.');
    });
});
// ─── Doctor synthesis: countRescueEntriesWithin30Days ─────────────────
describe('countRescueEntriesWithin30Days', () => {
    const NOW = Date.UTC(2026, 3, 23, 12, 0, 0); // 2026-04-23T12:00:00Z
    const WITHIN = new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5d ago
    const OUTSIDE = new Date(NOW - 45 * 24 * 60 * 60 * 1000).toISOString(); // 45d ago
    it('returns 0 on empty / unparseable payloads', () => {
        expect(countRescueEntriesWithin30Days('', NOW)).toBe(0);
        expect(countRescueEntriesWithin30Days('not-json', NOW)).toBe(0);
    });
    it('counts only rows with the flywheel-rescue prefix and ts within 30d', () => {
        const bullets = [
            { content: `flywheel-rescue ts=${WITHIN} phase=impl error_code=cli_failure` },
            { content: `flywheel-rescue ts=${WITHIN} phase=plan error_code=parse_failure` },
            { content: `flywheel-rescue ts=${OUTSIDE} phase=impl error_code=cli_failure` },
            { content: 'unrelated entry without the prefix' },
        ];
        expect(countRescueEntriesWithin30Days(JSON.stringify(bullets), NOW)).toBe(2);
    });
    it('accepts the { bullets: [...] } shape as well as a bare array', () => {
        const wrapped = { bullets: [{ text: `flywheel-rescue ts=${WITHIN} phase=impl` }] };
        expect(countRescueEntriesWithin30Days(JSON.stringify(wrapped), NOW)).toBe(1);
    });
    it('accepts the cm context JSON shape from cm 0.2.x', () => {
        const wrapped = {
            success: true,
            data: {
                relevantBullets: [{ content: `flywheel-rescue ts=${WITHIN} phase=impl` }],
                historySnippets: [{ snippet: `flywheel-rescue ts=${WITHIN} phase=review` }],
            },
        };
        expect(countRescueEntriesWithin30Days(JSON.stringify(wrapped), NOW)).toBe(2);
    });
    it('ignores rows with missing or malformed ts', () => {
        const bullets = [
            { content: 'flywheel-rescue phase=impl' }, // no ts
            { content: 'flywheel-rescue ts=not-a-date phase=impl' },
        ];
        expect(countRescueEntriesWithin30Days(JSON.stringify(bullets), NOW)).toBe(0);
    });
});
// ─── Stall-detection simulation ───────────────────────────────────────
describe('stall-detection simulation', () => {
    /**
     * Simulate the coordinator's N-1 stall detector: a helper that takes a
     * history of error codes observed on the same operation and returns true
     * iff the same code has fired on two consecutive attempts AND the next
     * attempt would be the second retry.
     */
    function shouldOfferRescue(history) {
        if (history.length < 2)
            return false;
        const last = history[history.length - 1];
        const prev = history[history.length - 2];
        return last.code === prev.code && last.attempt >= 1; // next would be retry #2
    }
    it('does NOT trigger rescue on a single failure', () => {
        expect(shouldOfferRescue([{ code: 'cli_failure', attempt: 0 }])).toBe(false);
    });
    it('triggers rescue on the 2nd consecutive same-code failure', () => {
        expect(shouldOfferRescue([
            { code: 'cli_failure', attempt: 0 },
            { code: 'cli_failure', attempt: 1 },
        ])).toBe(true);
    });
    it('does NOT trigger rescue if the two failures had different codes (different root cause)', () => {
        expect(shouldOfferRescue([
            { code: 'cli_failure', attempt: 0 },
            { code: 'parse_failure', attempt: 1 },
        ])).toBe(false);
    });
    it('handoff packet carries the failing envelope hint verbatim', () => {
        // Simulate a 2nd consecutive cli_failure — trigger fires, coordinator
        // reads the last error envelope and builds the packet.
        const history = [
            { code: 'cli_failure', attempt: 0 },
            { code: 'cli_failure', attempt: 1 },
        ];
        expect(shouldOfferRescue(history)).toBe(true);
        const failingEnvelope = {
            code: 'cli_failure',
            message: 'npm test failed',
            hint: 'Run `npm test -- <file>` to isolate the regression.',
        };
        const packet = buildRescuePacket({
            phase: 'impl',
            goal: 'Run codex rescue',
            artifact_path: 'x.diff',
            error_code: failingEnvelope.code,
            hint: failingEnvelope.hint,
        });
        expect(packet.error_code).toBe('cli_failure');
        expect(packet.hint).toBe(failingEnvelope.hint);
    });
});
//# sourceMappingURL=codex-handoff.test.js.map