/**
 * Step 10.55 integration test (bead 71x).
 *
 * Asserts that skills/start/_wrapup.md contains a Step 10.55 section
 * positioned strictly AFTER Step 10.5 and BEFORE Step 11, and that the
 * section instructs the assistant to call flywheel_memory with
 * operation: "draft_solution_doc" + use the Write tool against
 * docs/solutions/.
 *
 * This is a structural test — it does not parse markdown semantically; it
 * relies on the literal section anchors written in the file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPUP_PATH = join(__dirname, '..', '..', '..', 'skills', 'start', '_wrapup.md');
describe('skills/start/_wrapup.md Step 10.55', () => {
    const content = readFileSync(WRAPUP_PATH, 'utf8');
    it('contains a Step 10.55 section', () => {
        expect(content).toMatch(/##\s+Step 10\.55:/);
    });
    it('Step 10.55 is positioned between Step 10.5 and Step 11', () => {
        const idx105 = content.indexOf('## Step 10.5:');
        const idx1055 = content.indexOf('## Step 10.55:');
        const idx11 = content.indexOf('## Step 11:');
        expect(idx105).toBeGreaterThan(-1);
        expect(idx1055).toBeGreaterThan(idx105);
        expect(idx11).toBeGreaterThan(idx1055);
    });
    it('Step 10.55 invokes flywheel_memory with operation: "draft_solution_doc"', () => {
        // Slice the Step 10.55 region for a tight assertion
        const idx1055 = content.indexOf('## Step 10.55:');
        const idx11 = content.indexOf('## Step 11:');
        const region = content.slice(idx1055, idx11);
        expect(region).toMatch(/operation:\s*["']draft_solution_doc["']/);
    });
    it('Step 10.55 mentions the docs/solutions/ target directory', () => {
        const idx1055 = content.indexOf('## Step 10.55:');
        const idx11 = content.indexOf('## Step 11:');
        const region = content.slice(idx1055, idx11);
        expect(region).toContain('docs/solutions/');
    });
    it('Step 10.55 instructs use of the Write tool (not Bash heredoc)', () => {
        const idx1055 = content.indexOf('## Step 10.55:');
        const idx11 = content.indexOf('## Step 11:');
        const region = content.slice(idx1055, idx11);
        expect(region).toMatch(/\bWrite\b/);
    });
    it('Step 10.55 mentions entry_id reconciliation', () => {
        const idx1055 = content.indexOf('## Step 10.55:');
        const idx11 = content.indexOf('## Step 11:');
        const region = content.slice(idx1055, idx11);
        expect(region).toMatch(/entry_id|entryId/);
    });
});
//# sourceMappingURL=wrapup-step-10-55.test.js.map