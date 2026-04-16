import { describe, it, expect, vi } from 'vitest';
import { agentMailRPC, matchesReservationPath, normalizeReservations, unwrapRPC, } from '../agent-mail.js';
// ─── Helpers ────────────────────────────────────────────────────
/**
 * Build a mock ExecFn that returns a fixed result.
 */
function makeExec(result) {
    return vi.fn().mockResolvedValue(result);
}
/**
 * Build a mock ExecFn that throws an error (simulates network failure).
 */
function makeThrowingExec(message) {
    return vi.fn().mockRejectedValue(new Error(message));
}
function makeReservation(overrides = {}) {
    return { path_pattern: 'src/**', active: true, ...overrides };
}
// ─── agentMailRPC — success ─────────────────────────────────────
describe('agentMailRPC — ok:true on valid JSON-RPC success response', () => {
    it('returns ok:true with data from result.structuredContent', async () => {
        const payload = { project: { slug: 'my-project' } };
        const stdout = JSON.stringify({ result: { structuredContent: payload } });
        const exec = makeExec({ code: 0, stdout, stderr: '' });
        const result = await agentMailRPC(exec, 'ensure_project', { human_key: '/cwd' });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data).toEqual(payload);
        }
    });
    it('falls back to result when structuredContent is absent', async () => {
        const payload = { status: 'healthy' };
        const stdout = JSON.stringify({ result: payload });
        const exec = makeExec({ code: 0, stdout, stderr: '' });
        const result = await agentMailRPC(exec, 'health_check', {});
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data).toEqual(payload);
        }
    });
});
// ─── agentMailRPC — network failure ────────────────────────────
describe('agentMailRPC — ok:false kind:network on curl failure', () => {
    it('returns network error when exec throws', async () => {
        const exec = makeThrowingExec('Connection refused');
        const result = await agentMailRPC(exec, 'health_check', {});
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(['network', 'timeout'].includes(result.error.kind)).toBe(true);
            expect(result.error.message).toContain('Connection refused');
        }
    });
    it('returns network error when curl exits with non-zero code', async () => {
        const exec = makeExec({ code: 7, stdout: '', stderr: 'Failed to connect' });
        const result = await agentMailRPC(exec, 'health_check', {});
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(['network', 'timeout'].includes(result.error.kind)).toBe(true);
            expect(result.error.message).toContain('curl exited with code');
        }
    });
});
// ─── agentMailRPC — parse error ────────────────────────────────
describe('agentMailRPC — ok:false kind:parse on invalid JSON stdout', () => {
    it('returns parse error when stdout is not valid JSON', async () => {
        const exec = makeExec({ code: 0, stdout: 'not-json-at-all', stderr: '' });
        const result = await agentMailRPC(exec, 'health_check', {});
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('parse');
        }
    });
    it('returns parse error for empty stdout', async () => {
        const exec = makeExec({ code: 0, stdout: '', stderr: '' });
        const result = await agentMailRPC(exec, 'health_check', {});
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('parse');
        }
    });
});
// ─── agentMailRPC — rpc_error ──────────────────────────────────
describe('agentMailRPC — ok:false kind:rpc_error on JSON-RPC error field', () => {
    it('returns rpc_error when response contains error field', async () => {
        const stdout = JSON.stringify({
            error: { code: -32601, message: 'Method not found' },
        });
        const exec = makeExec({ code: 0, stdout, stderr: '' });
        const result = await agentMailRPC(exec, 'unknown_tool', {});
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('rpc_error');
            expect(result.error.message).toContain('Method not found');
        }
    });
    it('returns rpc_error with stringified error when message is absent', async () => {
        const stdout = JSON.stringify({ error: { code: -32000 } });
        const exec = makeExec({ code: 0, stdout, stderr: '' });
        const result = await agentMailRPC(exec, 'unknown_tool', {});
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('rpc_error');
        }
    });
});
// ─── matchesReservationPath ─────────────────────────────────────
describe('matchesReservationPath', () => {
    it('returns true on exact match', () => {
        const reservation = makeReservation({ path_pattern: 'src/agent-mail.ts' });
        expect(matchesReservationPath('src/agent-mail.ts', reservation)).toBe(true);
    });
    it('returns false when path does not match exactly', () => {
        const reservation = makeReservation({ path_pattern: 'src/agent-mail.ts' });
        expect(matchesReservationPath('src/other.ts', reservation)).toBe(false);
    });
    it('strips leading ./ from pattern before matching', () => {
        const reservation = makeReservation({ path_pattern: './src/agent-mail.ts' });
        expect(matchesReservationPath('src/agent-mail.ts', reservation)).toBe(true);
    });
    it('matches single wildcard glob within a directory segment', () => {
        const reservation = makeReservation({ path_pattern: 'src/*.ts' });
        expect(matchesReservationPath('src/foo.ts', reservation)).toBe(true);
        expect(matchesReservationPath('src/nested/foo.ts', reservation)).toBe(false);
    });
    it('matches double wildcard /** against directory and children', () => {
        const reservation = makeReservation({ path_pattern: 'src/**' });
        expect(matchesReservationPath('src', reservation)).toBe(true);
        expect(matchesReservationPath('src/foo.ts', reservation)).toBe(true);
        expect(matchesReservationPath('src/nested/bar.ts', reservation)).toBe(true);
        expect(matchesReservationPath('other/foo.ts', reservation)).toBe(false);
    });
    it('falls back to path when path_pattern is absent', () => {
        const reservation = makeReservation({ path_pattern: undefined, path: 'src/foo.ts' });
        expect(matchesReservationPath('src/foo.ts', reservation)).toBe(true);
    });
    it('returns false when both path_pattern and path are absent', () => {
        const reservation = {};
        expect(matchesReservationPath('src/foo.ts', reservation)).toBe(false);
    });
});
// ─── normalizeReservations ──────────────────────────────────────
describe('normalizeReservations', () => {
    it('returns the array as-is when payload is already an array', () => {
        const arr = [makeReservation(), makeReservation({ path_pattern: 'lib/**' })];
        expect(normalizeReservations(arr)).toBe(arr);
    });
    it('extracts reservations[] from wrapped object', () => {
        const arr = [makeReservation()];
        expect(normalizeReservations({ reservations: arr })).toBe(arr);
    });
    it('extracts items[] from wrapped object', () => {
        const arr = [makeReservation()];
        expect(normalizeReservations({ items: arr })).toBe(arr);
    });
    it('returns [] for null', () => {
        expect(normalizeReservations(null)).toEqual([]);
    });
    it('returns [] for undefined', () => {
        expect(normalizeReservations(undefined)).toEqual([]);
    });
    it('returns [] for an unrecognised object shape', () => {
        expect(normalizeReservations({ data: [] })).toEqual([]);
    });
});
// ─── unwrapRPC ──────────────────────────────────────────────────
describe('unwrapRPC', () => {
    it('returns data when result is ok:true', () => {
        const data = { status: 'healthy' };
        expect(unwrapRPC({ ok: true, data })).toBe(data);
    });
    it('returns null when result is ok:false (network)', () => {
        expect(unwrapRPC({ ok: false, error: { kind: 'network', message: 'timeout' } })).toBeNull();
    });
    it('returns null when result is ok:false (parse)', () => {
        expect(unwrapRPC({ ok: false, error: { kind: 'parse', message: 'bad json' } })).toBeNull();
    });
    it('returns null when result is ok:false (rpc_error)', () => {
        expect(unwrapRPC({ ok: false, error: { kind: 'rpc_error', message: 'not found' } })).toBeNull();
    });
});
//# sourceMappingURL=agent-mail.test.js.map