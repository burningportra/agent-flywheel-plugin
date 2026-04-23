/**
 * Tests for solution-doc-schema (bead 71x).
 *
 * Coverage:
 *   F-1: entry_id required + non-empty
 *   F-3: path regex enforced (docs/solutions/<cat>/<slug>-YYYY-MM-DD.md)
 *   created_at must be YYYY-MM-DD
 *   slugify is deterministic + filesystem-safe
 *   inferSolutionCategory returns canonical buckets
 *   renderSolutionDoc round-trips frontmatter fields
 */
import { describe, it, expect } from 'vitest';
import { SolutionDocSchema, SolutionDocFrontmatterSchema, SOLUTION_CATEGORIES, inferSolutionCategory, slugifySolutionTitle, renderSolutionDoc, } from '../solution-doc-schema.js';
// ─── Frontmatter schema ────────────────────────────────────────
describe('SolutionDocFrontmatterSchema', () => {
    it('requires non-empty entry_id (F-1 reconciliation invariant)', () => {
        expect(() => SolutionDocFrontmatterSchema.parse({
            entry_id: '',
            problem_type: 'flaky_test',
            component: 'tests',
            tags: [],
            applies_when: '',
            created_at: '2026-04-23',
        })).toThrow();
    });
    it('rejects malformed created_at', () => {
        expect(() => SolutionDocFrontmatterSchema.parse({
            entry_id: 'cass-abc',
            problem_type: 'x',
            component: 'y',
            tags: [],
            applies_when: '',
            created_at: '2026/04/23', // wrong format
        })).toThrow();
    });
    it('defaults tags to [] and applies_when to ""', () => {
        const fm = SolutionDocFrontmatterSchema.parse({
            entry_id: 'cass-abc',
            problem_type: 'x',
            component: 'y',
            created_at: '2026-04-23',
        });
        expect(fm.tags).toEqual([]);
        expect(fm.applies_when).toBe('');
    });
});
// ─── SolutionDocSchema ─────────────────────────────────────────
describe('SolutionDocSchema', () => {
    const validDoc = {
        path: 'docs/solutions/test/foo-bar-2026-04-23.md',
        frontmatter: {
            entry_id: 'cass-abc',
            problem_type: 'flaky_test',
            component: 'episodic-memory',
            tags: ['test', 'flaky_test'],
            applies_when: 'session goal: fix flaky test',
            created_at: '2026-04-23',
        },
        body: '# notes',
    };
    it('accepts a well-formed doc', () => {
        expect(() => SolutionDocSchema.parse(validDoc)).not.toThrow();
    });
    it('rejects path missing date suffix', () => {
        expect(() => SolutionDocSchema.parse({
            ...validDoc,
            path: 'docs/solutions/test/foo-bar.md',
        })).toThrow();
    });
    it('rejects path outside docs/solutions/', () => {
        expect(() => SolutionDocSchema.parse({
            ...validDoc,
            path: 'notes/test/foo-2026-04-23.md',
        })).toThrow();
    });
    it('rejects path with uppercase chars in slug', () => {
        expect(() => SolutionDocSchema.parse({
            ...validDoc,
            path: 'docs/solutions/test/Foo-Bar-2026-04-23.md',
        })).toThrow();
    });
});
// ─── slugifySolutionTitle ──────────────────────────────────────
describe('slugifySolutionTitle', () => {
    it('lowercases and collapses non-alphanumerics to "-"', () => {
        expect(slugifySolutionTitle('Fix Flaky Test In CI!')).toBe('fix-flaky-test-in-ci');
    });
    it('caps length at 60 chars', () => {
        const long = 'a'.repeat(120);
        expect(slugifySolutionTitle(long).length).toBeLessThanOrEqual(60);
    });
    it('falls back to "session" on empty input', () => {
        expect(slugifySolutionTitle('')).toBe('session');
        expect(slugifySolutionTitle('!!!')).toBe('session');
    });
});
// ─── inferSolutionCategory ─────────────────────────────────────
describe('inferSolutionCategory', () => {
    it('returns "test" when goal mentions flaky tests', () => {
        expect(inferSolutionCategory('fix flaky test in CI', [])).toBe('test');
    });
    it('returns "build" when goal mentions tsc compile errors', () => {
        expect(inferSolutionCategory('fix tsc compile errors', [])).toBe('build');
    });
    it('returns "docs" when goal mentions readme', () => {
        expect(inferSolutionCategory('update readme', [])).toBe('docs');
    });
    it('returns "coordination" for swarm / agent-mail goals', () => {
        expect(inferSolutionCategory('debug swarm coordination', [])).toBe('coordination');
    });
    it('returns "refactor" for rename/extract goals', () => {
        expect(inferSolutionCategory('refactor types module', [])).toBe('refactor');
    });
    it('returns "general" when nothing matches', () => {
        expect(inferSolutionCategory('xyz random goal', [])).toBe('general');
    });
    it('every returned category is in SOLUTION_CATEGORIES', () => {
        const samples = [
            'fix flaky test',
            'tsc errors',
            'readme update',
            'swarm bug',
            'rename module',
            'cli ergonomics',
            'runtime crash',
            'foo bar baz',
        ];
        for (const s of samples) {
            const cat = inferSolutionCategory(s, []);
            expect(SOLUTION_CATEGORIES).toContain(cat);
        }
    });
});
// ─── renderSolutionDoc ─────────────────────────────────────────
describe('renderSolutionDoc', () => {
    it('emits parseable YAML frontmatter with quoted strings', () => {
        const doc = {
            path: 'docs/solutions/general/x-2026-04-23.md',
            frontmatter: {
                entry_id: 'cass-1',
                problem_type: 'session_learning',
                component: 'unknown',
                tags: ['general', 'session_learning'],
                applies_when: 'session goal: x',
                created_at: '2026-04-23',
            },
            body: '## Body',
        };
        const out = renderSolutionDoc(doc);
        expect(out.startsWith('---\n')).toBe(true);
        expect(out).toContain('entry_id: "cass-1"');
        expect(out).toContain('problem_type: "session_learning"');
        expect(out).toContain('tags: ["general", "session_learning"]');
        expect(out).toContain('created_at: 2026-04-23');
        expect(out.endsWith('## Body')).toBe(true);
    });
    it('handles strings containing colons safely (JSON-quoted)', () => {
        const doc = {
            path: 'docs/solutions/general/x-2026-04-23.md',
            frontmatter: {
                entry_id: 'cass-1',
                problem_type: 'x',
                component: 'y',
                tags: [],
                applies_when: 'mode: aggressive, retries: 3',
                created_at: '2026-04-23',
            },
            body: '',
        };
        const out = renderSolutionDoc(doc);
        expect(out).toContain('applies_when: "mode: aggressive, retries: 3"');
    });
});
//# sourceMappingURL=solution-doc-schema.test.js.map