import { describe, expect, it } from 'vitest';
import { detectSessionStage } from '../session-state.js';
describe('detectSessionStage', () => {
    const createInitialState = () => ({
        phase: 'idle',
        constraints: [],
        retryCount: 0,
        maxRetries: 3,
        maxReviewPasses: 2,
        iterationRound: 0,
        currentGateIndex: 0,
        polishRound: 0,
        polishChanges: [],
        polishConverged: false,
    });
    it('detects fresh-start stage when no beads or plan are present', () => {
        const state = createInitialState();
        const beads = [];
        const stage = detectSessionStage(state, beads);
        expect(stage.phase).toBe('idle');
        expect(stage.confidence).toBe('high');
        expect(stage.label).toBe('Fresh start');
    });
    it('detects open-beads stage when beads are present but no plan', () => {
        const state = createInitialState();
        const beads = [{ id: 'b1', title: 'test', description: 'desc', status: 'open', priority: 1 }];
        const stage = detectSessionStage(state, beads);
        expect(stage.phase).toBe('implementing');
        expect(stage.confidence).toBe('medium');
        expect(stage.openBeadCount).toBe(1);
    });
    it('detects implementing stage when beads are in-progress', () => {
        const state = createInitialState();
        state.phase = 'implementing';
        const beads = [{ id: 'b1', title: 'test', description: 'desc', status: 'in_progress', priority: 1 }];
        const stage = detectSessionStage(state, beads);
        expect(stage.phase).toBe('implementing');
        expect(stage.currentBeadId).toBe('b1');
    });
    it('detects reviewing stage when checkpoint phase is reviewing', () => {
        const state = createInitialState();
        state.phase = 'reviewing';
        const beads = [{ id: 'b1', title: 'test', description: 'desc', status: 'open', priority: 1 }];
        const stage = detectSessionStage(state, beads);
        expect(stage.phase).toBe('reviewing');
    });
    it('detects complete stage when all beads are closed', () => {
        const state = createInitialState();
        state.phase = 'implementing';
        const beads = [{ id: 'b1', title: 'test', description: 'desc', status: 'closed', priority: 1 }];
        const stage = detectSessionStage(state, beads);
        expect(stage.phase).toBe('complete');
    });
    it('detects low confidence when plan file is missing', () => {
        const state = createInitialState();
        state.phase = 'planning';
        state.planDocument = 'docs/plan.md';
        const beads = [{ id: 'b1', title: 'test', description: 'desc', status: 'open', priority: 1 }];
        const evidence = { planDocumentExists: false };
        const stage = detectSessionStage(state, beads, evidence);
        expect(stage.confidence).toBe('low');
        expect(stage.inferredFrom).toContain('plan document "docs/plan.md" is missing');
    });
});
//# sourceMappingURL=session-state.test.js.map