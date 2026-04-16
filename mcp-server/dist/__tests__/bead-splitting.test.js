import { describe, it, expect } from 'vitest';
import { identifyBottlenecks, parseSplitProposal, formatSplitProposal, formatSplitCommands, } from '../bead-splitting.js';
// ─── Helpers ────────────────────────────────────────────────────
function makeBead(overrides = {}) {
    return {
        id: 'test-1',
        title: 'Test bead',
        description: 'A test bead',
        status: 'open',
        priority: 2,
        type: 'task',
        labels: [],
        ...overrides,
    };
}
function makeInsights(bottlenecks = []) {
    return {
        Bottlenecks: bottlenecks,
        Cycles: null,
        Orphans: [],
        Articulation: [],
        Slack: [],
    };
}
// ─── identifyBottlenecks ────────────────────────────────────────
describe('identifyBottlenecks', () => {
    it('returns empty for null/empty Bottlenecks', () => {
        const beads = [makeBead({ id: 'b1' })];
        expect(identifyBottlenecks(makeInsights([]), beads)).toEqual([]);
        expect(identifyBottlenecks({ ...makeInsights(), Bottlenecks: null }, beads)).toEqual([]);
        expect(identifyBottlenecks({ ...makeInsights(), Bottlenecks: undefined }, beads)).toEqual([]);
    });
    it('filters out values below threshold', () => {
        const beads = [makeBead({ id: 'b1' })];
        const insights = makeInsights([{ ID: 'b1', Value: 0.1 }]);
        expect(identifyBottlenecks(insights, beads, 0.3)).toEqual([]);
    });
    it('includes values at threshold', () => {
        const beads = [makeBead({ id: 'b1' })];
        const insights = makeInsights([{ ID: 'b1', Value: 0.3 }]);
        const result = identifyBottlenecks(insights, beads, 0.3);
        expect(result).toHaveLength(1);
        expect(result[0].betweenness).toBe(0.3);
    });
    it('filters out NaN values', () => {
        const beads = [makeBead({ id: 'b1' })];
        const insights = makeInsights([{ ID: 'b1', Value: NaN }]);
        expect(identifyBottlenecks(insights, beads, 0.3)).toEqual([]);
    });
    it('sorts multiple values descending', () => {
        const beads = [makeBead({ id: 'b1' }), makeBead({ id: 'b2' }), makeBead({ id: 'b3' })];
        const insights = makeInsights([
            { ID: 'b1', Value: 0.5 },
            { ID: 'b2', Value: 0.9 },
            { ID: 'b3', Value: 0.7 },
        ]);
        const result = identifyBottlenecks(insights, beads, 0.3);
        expect(result).toHaveLength(3);
        expect(result[0].betweenness).toBe(0.9);
        expect(result[1].betweenness).toBe(0.7);
        expect(result[2].betweenness).toBe(0.5);
    });
    it('excludes bead IDs not in beads map', () => {
        const beads = [makeBead({ id: 'b1' })];
        const insights = makeInsights([
            { ID: 'b1', Value: 0.5 },
            { ID: 'missing', Value: 0.8 },
        ]);
        const result = identifyBottlenecks(insights, beads, 0.3);
        expect(result).toHaveLength(1);
        expect(result[0].bead.id).toBe('b1');
    });
});
// ─── parseSplitProposal ─────────────────────────────────────────
describe('parseSplitProposal', () => {
    it('parses valid JSON with 2+ children', () => {
        const output = JSON.stringify({
            splittable: true,
            reason: 'Can split into API and UI',
            children: [
                { title: 'API layer', description: 'Build API', files: ['src/api.ts'] },
                { title: 'UI layer', description: 'Build UI', files: ['src/ui.ts'] },
            ],
        });
        const result = parseSplitProposal(output, 'b1', 'Test', 0.5);
        expect(result.splittable).toBe(true);
        expect(result.children).toHaveLength(2);
        expect(result.children[0].title).toBe('API layer');
        expect(result.children[1].title).toBe('UI layer');
    });
    it('returns splittable: false when no JSON in output', () => {
        const result = parseSplitProposal('This is just plain text', 'b1', 'Test', 0.5);
        expect(result.splittable).toBe(false);
        expect(result.reason).toContain('Failed to parse');
    });
    it('returns splittable: false when 0 children', () => {
        const output = JSON.stringify({
            splittable: true,
            reason: 'Can split',
            children: [],
        });
        const result = parseSplitProposal(output, 'b1', 'Test', 0.5);
        expect(result.splittable).toBe(false);
        expect(result.reason).toContain('need at least 2');
    });
    it('returns splittable: false when 1 child (single-child override)', () => {
        const output = JSON.stringify({
            splittable: true,
            reason: 'Can split',
            children: [{ title: 'Only child', description: 'Alone', files: ['src/a.ts'] }],
        });
        const result = parseSplitProposal(output, 'b1', 'Test', 0.5);
        expect(result.splittable).toBe(false);
        expect(result.reason).toContain('need at least 2');
    });
    it('adds warning for overlapping files', () => {
        const output = JSON.stringify({
            splittable: true,
            reason: 'Can split',
            children: [
                { title: 'Part A', description: 'A', files: ['src/shared.ts', 'src/a.ts'] },
                { title: 'Part B', description: 'B', files: ['src/shared.ts', 'src/b.ts'] },
            ],
        });
        const result = parseSplitProposal(output, 'b1', 'Test', 0.5);
        expect(result.splittable).toBe(true);
        expect(result.reason).toContain('overlapping files');
        expect(result.reason).toContain('src/shared.ts');
    });
    it('returns splittable: false for malformed JSON', () => {
        // Include a closing } so regex matches but JSON.parse fails
        const output = '{"splittable": true, "children": [broken]}';
        const result = parseSplitProposal(output, 'b1', 'Test', 0.5);
        expect(result.splittable).toBe(false);
        expect(result.reason).toContain('JSON parse error');
    });
});
// ─── formatSplitProposal ────────────────────────────────────────
describe('formatSplitProposal', () => {
    it('formats a non-splittable proposal', () => {
        const result = formatSplitProposal({
            originalBeadId: 'b1',
            originalTitle: 'Test',
            betweennessScore: 0.5,
            dependentCount: 0,
            children: [],
            splittable: false,
            reason: 'inherently sequential',
        });
        expect(result).toContain('Cannot split');
        expect(result).toContain('inherently sequential');
    });
    it('formats a splittable proposal with children', () => {
        const result = formatSplitProposal({
            originalBeadId: 'b1',
            originalTitle: 'Test',
            betweennessScore: 0.75,
            dependentCount: 0,
            children: [
                { title: 'Part A', description: 'Build A', files: ['src/a.ts'] },
                { title: 'Part B', description: 'Build B', files: ['src/b.ts'] },
            ],
            splittable: true,
        });
        expect(result).toContain('Part A');
        expect(result).toContain('Part B');
        expect(result).toContain('0.75');
        expect(result).toContain('split into 2 children');
    });
});
// ─── formatSplitCommands ────────────────────────────────────────
describe('formatSplitCommands', () => {
    it('returns empty string when splittable is false', () => {
        const result = formatSplitCommands({
            originalBeadId: 'b1',
            originalTitle: 'Test',
            betweennessScore: 0.5,
            dependentCount: 0,
            children: [],
            splittable: false,
        });
        expect(result).toBe('');
    });
    it('escapes shell metacharacters in titles', () => {
        const result = formatSplitCommands({
            originalBeadId: 'b1',
            originalTitle: 'Test',
            betweennessScore: 0.5,
            dependentCount: 0,
            children: [
                { title: 'Part $A `cmd`', description: 'Build "A"', files: [] },
                { title: 'Part B', description: 'Build B', files: [] },
            ],
            splittable: true,
        });
        expect(result).toContain('\\$A');
        expect(result).toContain('\\`cmd\\`');
        expect(result).toContain('\\"A\\"');
        expect(result).toContain('br create');
    });
    it('escapes newlines in descriptions', () => {
        const result = formatSplitCommands({
            originalBeadId: 'b1',
            originalTitle: 'Test',
            betweennessScore: 0.5,
            dependentCount: 0,
            children: [
                { title: 'Part A', description: 'Line1\nLine2\rLine3', files: [] },
                { title: 'Part B', description: 'OK', files: [] },
            ],
            splittable: true,
        });
        // shellEscape replaces \n and \r with spaces, so the description
        // should contain "Line1 Line2 Line3" (spaces, not newlines)
        expect(result).toContain('Line1 Line2 Line3');
        expect(result).toContain('br create');
    });
});
//# sourceMappingURL=bead-splitting.test.js.map