import { describe, it, expect } from 'vitest';
import { classifyBeadComplexity, routeModel, routeBeads, formatRoutingSummary, } from '../model-routing.js';
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
// ─── classifyBeadComplexity ─────────────────────────────────────
describe('classifyBeadComplexity', () => {
    it('classifies a simple doc/typo bead as "simple"', () => {
        const bead = makeBead({ title: 'Fix typo in README', description: 'Fix documentation typo', priority: 3 });
        const { complexity } = classifyBeadComplexity(bead);
        expect(complexity).toBe('simple');
    });
    it('classifies a medium bead (4 files, long description) as "medium"', () => {
        const bead = makeBead({
            title: 'Add user endpoint with integration',
            description: '### Files:\nsrc/routes.ts, src/controller.ts, src/model.ts, src/validator.ts\n\n' +
                'Implement new user endpoint. ' + 'x'.repeat(500),
            priority: 2,
        });
        const { complexity } = classifyBeadComplexity(bead);
        expect(complexity).toBe('medium');
    });
    it('classifies a complex bead (auth/security, 8+ files) as "complex"', () => {
        const bead = makeBead({
            title: 'Major authentication refactor',
            description: '### Files:\nsrc/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts, src/f.ts, src/g.ts, src/h.ts\n\n' +
                'This is a major security and authentication overhaul with breaking changes and migration.',
            priority: 0,
        });
        const { complexity } = classifyBeadComplexity(bead);
        expect(complexity).toBe('complex');
    });
    it('does not throw when bead.priority is undefined and excludes priority signal', () => {
        const bead = makeBead({ priority: undefined });
        expect(() => classifyBeadComplexity(bead)).not.toThrow();
        const { reason } = classifyBeadComplexity(bead);
        expect(reason).not.toContain('high priority');
    });
    it('does not throw when bead.priority is NaN and excludes priority signal', () => {
        const bead = makeBead({ priority: NaN });
        expect(() => classifyBeadComplexity(bead)).not.toThrow();
        const { reason } = classifyBeadComplexity(bead);
        expect(reason).not.toContain('high priority');
    });
    it('treats priority 0 as high-priority signal', () => {
        const bead = makeBead({ priority: 0 });
        const { reason } = classifyBeadComplexity(bead);
        expect(reason).toContain('high priority');
    });
    it('treats priority 1 as high-priority signal', () => {
        const bead = makeBead({ priority: 1 });
        const { reason } = classifyBeadComplexity(bead);
        expect(reason).toContain('high priority');
    });
    it('does not throw when bead.description is undefined', () => {
        const bead = makeBead({ description: undefined });
        expect(() => classifyBeadComplexity(bead)).not.toThrow();
    });
    it('gives "simple" for a low-scoring bead with simplicity signals', () => {
        const bead = makeBead({ title: 'Update config and format lint', description: 'bump version', priority: 4 });
        const { complexity } = classifyBeadComplexity(bead);
        expect(complexity).toBe('simple');
    });
});
// ─── routeModel ─────────────────────────────────────────────────
describe('routeModel', () => {
    it('returns expected models for default tiers', () => {
        const bead = makeBead({ title: 'Fix typo in docs', description: 'readme fix', priority: 3 });
        const route = routeModel(bead);
        expect(route.implementation).toBeTruthy();
        expect(route.review).toBeTruthy();
        expect(route.complexity).toBe('simple');
    });
    it('uses custom tiers when all keys are provided', () => {
        const customTiers = {
            simple: { implementation: 'custom/simple-impl', review: 'custom/simple-rev' },
            medium: { implementation: 'custom/medium-impl', review: 'custom/medium-rev' },
            complex: { implementation: 'custom/complex-impl', review: 'custom/complex-rev' },
        };
        const bead = makeBead({ title: 'Fix typo in docs', description: 'readme fix', priority: 3 });
        const route = routeModel(bead, customTiers);
        expect(route.implementation).toBe('custom/simple-impl');
        expect(route.review).toBe('custom/simple-rev');
    });
    it('falls back to DEFAULT_TIERS when custom tier has empty implementation', () => {
        const customTiers = {
            simple: { implementation: '', review: 'custom/rev' },
            medium: { implementation: 'custom/medium-impl', review: 'custom/medium-rev' },
            complex: { implementation: 'custom/complex-impl', review: 'custom/complex-rev' },
        };
        const bead = makeBead({ title: 'Fix typo in docs', description: 'readme fix', priority: 3 });
        const route = routeModel(bead, customTiers);
        // Should fall back to DEFAULT_TIERS.simple — verify exact model string
        expect(route.implementation).toBe('anthropic/claude-haiku-4-5');
    });
    it('falls back to DEFAULT_TIERS when custom tier is missing a key', () => {
        const customTiers = {
            simple: { implementation: 'custom/simple-impl', review: 'custom/simple-rev' },
            medium: { implementation: 'custom/medium-impl', review: 'custom/medium-rev' },
        };
        const bead = makeBead({
            title: 'Major authentication refactor',
            description: '### Files:\nsrc/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts, src/f.ts, src/g.ts, src/h.ts\n\n' +
                'security overhaul with breaking changes and migration',
            priority: 0,
        });
        const route = routeModel(bead, customTiers);
        // Should fall back — implementation should still be truthy
        expect(route.implementation).toBeTruthy();
        expect(route.complexity).toBe('complex');
    });
    it('assigns correct model for a single bead complexity', () => {
        const bead = makeBead({
            title: 'Add user endpoint with integration',
            description: '### Files:\nsrc/routes.ts, src/controller.ts, src/model.ts, src/validator.ts\n\n' +
                'Implement endpoint. ' + 'x'.repeat(500),
            priority: 2,
        });
        const route = routeModel(bead);
        expect(route.complexity).toBe('medium');
        expect(route.implementation).toBeTruthy();
        expect(route.review).toBeTruthy();
        expect(route.reason).toBeTruthy();
    });
});
// ─── routeBeads ─────────────────────────────────────────────────
describe('routeBeads', () => {
    it('returns empty result for empty array', () => {
        const { routes, summary } = routeBeads([]);
        expect(routes.size).toBe(0);
        expect(summary.simple).toBe(0);
        expect(summary.medium).toBe(0);
        expect(summary.complex).toBe(0);
    });
    it('routes mixed complexities correctly', () => {
        const beads = [
            makeBead({ id: 'b1', title: 'Fix typo in README', description: 'docs typo', priority: 3 }),
            makeBead({
                id: 'b2',
                title: 'Add endpoint',
                description: '### Files:\nsrc/a.ts, src/b.ts, src/c.ts\n\nAdd endpoint',
                priority: 2,
            }),
            makeBead({
                id: 'b3',
                title: 'Auth security migration',
                description: '### Files:\nsrc/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts, src/f.ts\n\nsecurity authentication breaking change',
                priority: 0,
            }),
        ];
        const { routes, summary } = routeBeads(beads);
        expect(routes.size).toBe(3);
        expect(summary.simple + summary.medium + summary.complex).toBe(3);
        // b1 should be simple
        expect(routes.get('b1').complexity).toBe('simple');
        // b3 should be complex
        expect(routes.get('b3').complexity).toBe('complex');
    });
});
// ─── formatRoutingSummary ───────────────────────────────────────
describe('formatRoutingSummary', () => {
    it('returns empty string for empty routes map', () => {
        const result = formatRoutingSummary(new Map(), []);
        expect(result).toBe('');
    });
    it('contains model class names for normal routes', () => {
        const beads = [
            makeBead({ id: 'b1', title: 'Fix typo', description: 'docs', priority: 3 }),
            makeBead({
                id: 'b2',
                title: 'Major auth refactor',
                description: '### Files:\nsrc/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts, src/f.ts\n\nsecurity authentication breaking change',
                priority: 0,
            }),
        ];
        const { routes } = routeBeads(beads);
        const result = formatRoutingSummary(routes, beads);
        expect(result).toContain('haiku');
        expect(result).toContain('opus');
        expect(result).toContain('Model Routing');
    });
});
//# sourceMappingURL=model-routing.test.js.map