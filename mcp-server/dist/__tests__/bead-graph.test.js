/**
 * Pure data-layer tests for buildBeadGraph (T4).
 * Covers: round-trip, cycles (3-node, self-loop), disjoint subgraphs,
 * no-edge graphs, deterministic ordering, and empty input.
 */
import { describe, expect, it } from 'vitest';
import { buildBeadGraph } from '../bead-graph.js';
// generatedAt is non-deterministic ISO timestamp; strip for snapshots.
function stripGeneratedAt(g) {
    const { generatedAt: _ignored, ...rest } = g;
    void _ignored;
    return rest;
}
describe('buildBeadGraph — round-trip', () => {
    it('returns nodes/edges/cycles shapes for a simple fixture', () => {
        const list = [
            { id: 'A', title: 'Alpha', status: 'open', priority: 1, labels: ['x'] },
            { id: 'B', title: 'Beta', status: 'in_progress' },
        ];
        const deps = [{ from: 'A', to: 'B', type: 'blocks' }];
        const g = buildBeadGraph(list, deps);
        expect(g.nodes).toHaveLength(2);
        expect(g.nodes[0]).toMatchObject({
            id: 'A',
            title: 'Alpha',
            status: 'open',
            priority: 1,
            labels: ['x'],
        });
        expect(g.nodes[1]).toMatchObject({ id: 'B', status: 'in_progress' });
        expect(g.edges).toEqual([{ from: 'A', to: 'B', type: 'blocks' }]);
        expect(g.cycles).toEqual([]);
        expect(typeof g.generatedAt).toBe('string');
        expect(() => new Date(g.generatedAt).toISOString()).not.toThrow();
    });
    it('mines inline dependencies[] from list rows', () => {
        const list = [
            { id: 'A', title: 'A', status: 'open', dependencies: ['B'] },
            { id: 'B', title: 'B', status: 'open' },
        ];
        const g = buildBeadGraph(list, []);
        expect(g.edges).toEqual([{ from: 'A', to: 'B', type: 'blocks' }]);
    });
});
describe('buildBeadGraph — cycles', () => {
    it('detects 3-node cycle A→B→C→A and emits sorted beadIds', () => {
        const list = [
            { id: 'A', title: 'A', status: 'open' },
            { id: 'B', title: 'B', status: 'open' },
            { id: 'C', title: 'C', status: 'open' },
        ];
        const deps = [
            { from: 'A', to: 'B', type: 'blocks' },
            { from: 'B', to: 'C', type: 'blocks' },
            { from: 'C', to: 'A', type: 'blocks' },
        ];
        const g = buildBeadGraph(list, deps);
        expect(g.cycles).toHaveLength(1);
        expect(g.cycles[0].beadIds).toEqual(['A', 'B', 'C']);
    });
    it('detects a self-loop A→A as a cycle of length 1', () => {
        const list = [{ id: 'A', title: 'A', status: 'open' }];
        const deps = [{ from: 'A', to: 'A', type: 'blocks' }];
        const g = buildBeadGraph(list, deps);
        expect(g.cycles).toEqual([{ beadIds: ['A'] }]);
    });
});
describe('buildBeadGraph — disjoint subgraphs', () => {
    it('renders two disconnected components with no cross edges', () => {
        const list = [
            { id: 'A', title: 'A', status: 'open' },
            { id: 'B', title: 'B', status: 'open' },
            { id: 'C', title: 'C', status: 'open' },
            { id: 'D', title: 'D', status: 'open' },
        ];
        const deps = [
            { from: 'A', to: 'B', type: 'blocks' },
            { from: 'C', to: 'D', type: 'blocks' },
        ];
        const g = buildBeadGraph(list, deps);
        expect(g.nodes.map((n) => n.id).sort()).toEqual(['A', 'B', 'C', 'D']);
        expect(g.edges).toHaveLength(2);
        // No cross-component edges.
        const crosses = g.edges.filter((e) => (['A', 'B'].includes(e.from) && ['C', 'D'].includes(e.to)) ||
            (['C', 'D'].includes(e.from) && ['A', 'B'].includes(e.to)));
        expect(crosses).toEqual([]);
        expect(g.cycles).toEqual([]);
    });
});
describe('buildBeadGraph — degenerate inputs', () => {
    it('5-node graph with 0 edges yields cycles=[]', () => {
        const list = ['A', 'B', 'C', 'D', 'E'].map((id) => ({
            id,
            title: id,
            status: 'open',
        }));
        const g = buildBeadGraph(list, []);
        expect(g.nodes).toHaveLength(5);
        expect(g.edges).toEqual([]);
        expect(g.cycles).toEqual([]);
    });
    it('empty input returns empty graph with iso generatedAt', () => {
        const g = buildBeadGraph([], []);
        expect(g.nodes).toEqual([]);
        expect(g.edges).toEqual([]);
        expect(g.cycles).toEqual([]);
        expect(typeof g.generatedAt).toBe('string');
        expect(g.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
});
describe('buildBeadGraph — deterministic ordering', () => {
    it('produces stable output for same input (snapshot)', () => {
        const list = [
            { id: 'B', title: 'B', status: 'open', priority: 2 },
            { id: 'A', title: 'A', status: 'open', priority: 1 },
            { id: 'D', title: 'D', status: 'closed' },
            { id: 'C', title: 'C', status: 'in_progress', labels: ['x', 'y'] },
        ];
        const deps = [
            { from: 'A', to: 'B', type: 'blocks' },
            { from: 'C', to: 'D', type: 'blocks' },
            { from: 'B', to: 'A', type: 'blocks' }, // creates A↔B cycle
        ];
        const g1 = buildBeadGraph(list, deps);
        const g2 = buildBeadGraph(list, deps);
        expect(stripGeneratedAt(g1)).toEqual(stripGeneratedAt(g2));
        expect(stripGeneratedAt(g1)).toMatchSnapshot();
    });
});
//# sourceMappingURL=bead-graph.test.js.map