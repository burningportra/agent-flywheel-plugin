/**
 * Tests for text-normalize utility (bead agent-flywheel-plugin-i72).
 *
 * Covers all four BOM/line-ending permutations on the same logical input
 * so we can assert byte-identical output. Includes a CI sentinel that
 * reads a real fixture saved with BOM+CRLF on disk to catch regressions
 * where the source-tree canonicalization quietly converts the fixture
 * to LF.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeText } from '../../utils/text-normalize.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, '..', 'fixtures', 'normalize-crlf-bom.md');
const BOM = '\uFEFF';
const BODY_LF = '---\ntitle: "x"\n---\n\nHello\nWorld\n';
const BODY_CRLF = BODY_LF.replace(/\n/g, '\r\n');
describe('normalizeText', () => {
    it('LF-only input is unchanged', () => {
        expect(normalizeText(BODY_LF)).toBe(BODY_LF);
    });
    it('CRLF-only input collapses to LF', () => {
        expect(normalizeText(BODY_CRLF)).toBe(BODY_LF);
    });
    it('BOM + LF input strips the BOM', () => {
        expect(normalizeText(BOM + BODY_LF)).toBe(BODY_LF);
    });
    it('BOM + CRLF input strips the BOM and collapses CRLF', () => {
        expect(normalizeText(BOM + BODY_CRLF)).toBe(BODY_LF);
    });
    it('all four permutations normalize to byte-identical output', () => {
        const permutations = [
            BODY_LF,
            BODY_CRLF,
            BOM + BODY_LF,
            BOM + BODY_CRLF,
        ].map(normalizeText);
        const first = permutations[0];
        for (const p of permutations) {
            expect(p).toBe(first);
        }
    });
    it('strips only a single leading BOM, never an interior one', () => {
        const interior = `hello${BOM}world\r\n`;
        // Interior \uFEFF is preserved; only the leading one is stripped.
        expect(normalizeText(`${BOM}${interior}`)).toBe(`hello${BOM}world\n`);
    });
    it('collapses bare CR (legacy Mac) to LF', () => {
        expect(normalizeText('a\rb\rc')).toBe('a\nb\nc');
    });
    it('handles empty string', () => {
        expect(normalizeText('')).toBe('');
    });
    it('handles a lone BOM', () => {
        expect(normalizeText(BOM)).toBe('');
    });
});
describe('normalizeText fixture (CI sentinel)', () => {
    it('normalizes the on-disk BOM+CRLF fixture to LF without BOM', async () => {
        const raw = await readFile(FIXTURE_PATH, 'utf8');
        // Sanity: the fixture on disk really does have BOM and CRLF. If this
        // assertion fails, somebody (likely a .gitattributes auto-CRLF rule
        // or an editor) silently rewrote the fixture — that defeats the
        // sentinel. Restore the bytes (see fixture file header for the
        // generator command).
        expect(raw.charCodeAt(0)).toBe(0xfeff);
        expect(raw.includes('\r\n')).toBe(true);
        const normalized = normalizeText(raw);
        expect(normalized.charCodeAt(0)).not.toBe(0xfeff);
        expect(normalized.includes('\r')).toBe(false);
        expect(normalized.startsWith('---\n')).toBe(true);
        expect(normalized).toContain('# Heading\n');
    });
});
//# sourceMappingURL=text-normalize.test.js.map