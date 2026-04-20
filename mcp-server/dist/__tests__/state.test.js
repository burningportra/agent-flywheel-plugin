import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState, clearState } from '../state.js';
import { createInitialState } from '../types.js';
let testDir;
beforeEach(() => { testDir = mkdtempSync(join(tmpdir(), 'orch-state-test-')); });
afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });
// ─── loadState ─────────────────────────────────────────────────
describe('loadState', () => {
    it('returns initial state on fresh dir (no checkpoint)', () => {
        const state = loadState(testDir);
        expect(state).toEqual(createInitialState());
    });
    it('returns initial state when checkpoint is in "idle" phase', async () => {
        const idle = { ...createInitialState(), phase: 'idle' };
        await saveState(testDir, idle);
        expect(loadState(testDir)).toEqual(createInitialState());
    });
    it('returns initial state when checkpoint is in "complete" phase', async () => {
        const complete = { ...createInitialState(), phase: 'complete' };
        await saveState(testDir, complete);
        expect(loadState(testDir)).toEqual(createInitialState());
    });
    it('restores state when checkpoint is in "profiling" phase', async () => {
        const profiling = { ...createInitialState(), phase: 'profiling' };
        await saveState(testDir, profiling);
        const restored = loadState(testDir);
        expect(restored.phase).toBe('profiling');
    });
    it('restores state when checkpoint is in "implementing" phase', async () => {
        const implementing = {
            ...createInitialState(),
            phase: 'implementing',
            selectedGoal: 'build the thing',
        };
        await saveState(testDir, implementing);
        const restored = loadState(testDir);
        expect(restored.phase).toBe('implementing');
        expect(restored.selectedGoal).toBe('build the thing');
    });
});
// ─── saveState + loadState round-trip ──────────────────────────
describe('saveState + loadState round-trip', () => {
    it('round-trips a state with selectedGoal', async () => {
        const state = {
            ...createInitialState(),
            phase: 'planning',
            selectedGoal: 'add rate limiting',
            constraints: ['must be backward compatible'],
            iterationRound: 2,
        };
        await saveState(testDir, state);
        const restored = loadState(testDir);
        expect(restored.phase).toBe('planning');
        expect(restored.selectedGoal).toBe('add rate limiting');
        expect(restored.constraints).toEqual(['must be backward compatible']);
        expect(restored.iterationRound).toBe(2);
    });
    it('round-trips bead-centric state fields', async () => {
        const state = {
            ...createInitialState(),
            phase: 'reviewing',
            activeBeadIds: ['abc-123', 'def-456'],
            currentBeadId: 'abc-123',
            beadResults: {
                'abc-123': { beadId: 'abc-123', status: 'success', summary: 'done' },
            },
        };
        await saveState(testDir, state);
        const restored = loadState(testDir);
        expect(restored.activeBeadIds).toEqual(['abc-123', 'def-456']);
        expect(restored.currentBeadId).toBe('abc-123');
        expect(restored.beadResults?.['abc-123']?.status).toBe('success');
    });
});
// ─── clearState ────────────────────────────────────────────────
describe('clearState', () => {
    it('subsequent loadState returns initial state after clear', async () => {
        const state = { ...createInitialState(), phase: 'planning' };
        await saveState(testDir, state);
        expect(loadState(testDir).phase).toBe('planning');
        clearState(testDir);
        expect(loadState(testDir)).toEqual(createInitialState());
    });
    it('does not throw on fresh dir', () => {
        expect(() => clearState(testDir)).not.toThrow();
    });
});
// ─── saveState edge cases ──────────────────────────────────────
describe('saveState edge cases', () => {
    it('does not throw when checkpoint dir does not exist yet', async () => {
        await expect(saveState(testDir, createInitialState())).resolves.not.toThrow();
    });
    it('returns true on successful write', async () => {
        const result = await saveState(testDir, createInitialState());
        expect(result).toBe(true);
    });
    it('returns false when checkpoint write fails', async () => {
        const checkpoint = await import('../checkpoint.js');
        const spy = vi.spyOn(checkpoint, 'writeCheckpoint').mockResolvedValueOnce(false);
        const result = await saveState(testDir, createInitialState());
        expect(result).toBe(false);
        spy.mockRestore();
    });
});
//# sourceMappingURL=state.test.js.map