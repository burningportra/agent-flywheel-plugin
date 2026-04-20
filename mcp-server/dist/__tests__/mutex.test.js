import { describe, it, expect, beforeEach } from 'vitest';
import { acquireBeadMutex, releaseBeadMutex, makeConcurrentWriteError, _resetForTest } from '../mutex.js';
beforeEach(() => _resetForTest());
describe('acquireBeadMutex / releaseBeadMutex', () => {
    it('grants first acquire for a key', () => {
        expect(acquireBeadMutex('review:bead-1')).toBe(true);
    });
    it('rejects second concurrent acquire for same key', () => {
        acquireBeadMutex('review:bead-1');
        expect(acquireBeadMutex('review:bead-1')).toBe(false);
    });
    it('allows acquire after release', () => {
        acquireBeadMutex('review:bead-1');
        releaseBeadMutex('review:bead-1');
        expect(acquireBeadMutex('review:bead-1')).toBe(true);
    });
    it('allows concurrent acquires for different keys', () => {
        expect(acquireBeadMutex('review:bead-1')).toBe(true);
        expect(acquireBeadMutex('review:bead-2')).toBe(true);
    });
    it('release is idempotent', () => {
        acquireBeadMutex('review:bead-1');
        releaseBeadMutex('review:bead-1');
        releaseBeadMutex('review:bead-1');
        expect(acquireBeadMutex('review:bead-1')).toBe(true);
    });
});
describe('makeConcurrentWriteError', () => {
    it('returns structured concurrent_write error', () => {
        const result = makeConcurrentWriteError('flywheel_review', 'implementing', 'review:bead-1');
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
            tool: 'flywheel_review',
            version: 1,
            status: 'error',
            data: {
                kind: 'error',
                error: {
                    code: 'concurrent_write',
                    retryable: true,
                },
            },
        });
    });
});
//# sourceMappingURL=mutex.test.js.map