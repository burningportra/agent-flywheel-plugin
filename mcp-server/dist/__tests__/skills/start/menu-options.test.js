import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
/**
 * Asserts that every menu state in `skills/start/SKILL.md` Step 0d surfaces the two
 * top-level entry-point options elevated in claude-orchestrator-1o4:
 *
 *   - "Set a goal"          (type the goal in Other; runs /brainstorming + flywheel_select)
 *   - "Pick up existing plan" (type a docs/plans/<file>.md path in Other; runs flywheel_plan)
 *
 * Both must appear in:
 *   - the printed `Primary entry points` block (operator-visible),
 *   - the labeled `AskUserQuestion` options array (programmatically routable).
 *
 * Lint, not unit — the "menu" is markdown prose, so we lint the document for the
 * required surface area. Catches the regression where someone refactors a menu
 * variant and silently drops one of these elevated options.
 */
const SKILL_PATH = resolve(__dirname, '../../../../../skills/start/SKILL.md');
const VARIANTS = [
    {
        name: 'previous-session-exists',
        anchor: '**If a previous session exists**',
        endAnchor: '**If open/in-progress beads exist**',
    },
    {
        name: 'open-beads-exist',
        anchor: '**If open/in-progress beads exist**',
        endAnchor: '**If no beads and no session**',
    },
    {
        name: 'fresh-start',
        anchor: '**If no beads and no session**',
        endAnchor: '### 0e.',
    },
];
const REQUIRED_LABELS = ['Set a goal', 'Pick up existing plan'];
describe('skills/start/SKILL.md — Step 0d menu options (claude-orchestrator-1o4)', () => {
    let skillBody;
    beforeAll(() => {
        skillBody = readFileSync(SKILL_PATH, 'utf-8');
    });
    function sliceVariant(variant) {
        const start = skillBody.indexOf(variant.anchor);
        const end = skillBody.indexOf(variant.endAnchor, start + variant.anchor.length);
        expect(start, `anchor not found for ${variant.name}: ${variant.anchor}`).toBeGreaterThan(-1);
        expect(end, `endAnchor not found for ${variant.name}: ${variant.endAnchor}`).toBeGreaterThan(start);
        return skillBody.slice(start, end);
    }
    for (const variant of VARIANTS) {
        describe(`menu variant: ${variant.name}`, () => {
            let section;
            beforeAll(() => {
                section = sliceVariant(variant);
            });
            it.each(REQUIRED_LABELS)(`surfaces "%s" in the printed Primary entry points block`, (label) => {
                // The printed block uses `  • <Label>` bullet markers.
                const bulletPattern = new RegExp(`•\\s+${escapeRegex(label)}\\b`);
                expect(bulletPattern.test(section), `expected printed bullet "• ${label}" in ${variant.name} menu`).toBe(true);
            });
            it.each(REQUIRED_LABELS)(`surfaces "%s" as a labeled AskUserQuestion option`, (label) => {
                // Labeled options look like: { label: "Set a goal", description: "..." }
                // Allow optional " (Recommended)" suffix.
                const labelPattern = new RegExp(`\\{\\s*label:\\s*"${escapeRegex(label)}(?:\\s+\\(Recommended\\))?"`);
                expect(labelPattern.test(section), `expected labeled option "{ label: \\"${label}\\" }" (or "${label} (Recommended)") in ${variant.name} menu`).toBe(true);
            });
        });
    }
    it('surfaces RECENT_PLAN_PATHS placeholder in every variant that offers Pick up existing plan', () => {
        for (const variant of VARIANTS) {
            const section = sliceVariant(variant);
            expect(section.includes('RECENT_PLAN_PATHS'), `expected RECENT_PLAN_PATHS reference in ${variant.name} menu (Pick up existing plan needs the suggestion list)`).toBe(true);
        }
    });
    it('Step 0e routing table includes a "Pick up existing plan" handler', () => {
        const routingStart = skillBody.indexOf('### 0e.');
        expect(routingStart).toBeGreaterThan(-1);
        const routingTable = skillBody.slice(routingStart);
        expect(/\|\s*\*\*Pick up existing plan\*\*\s*\|/.test(routingTable), 'expected `| **Pick up existing plan** |` row in Step 0e routing table').toBe(true);
        // The handler must reference flywheel_plan + Step 5.5 (bead creation jump).
        const pickRowMatch = routingTable.match(/\|\s*\*\*Pick up existing plan\*\*[\s\S]*?\n\|/);
        expect(pickRowMatch, 'could not extract Pick up existing plan row body').not.toBeNull();
        const rowBody = pickRowMatch[0];
        expect(rowBody.toLowerCase()).toContain('flywheel_plan');
        expect(rowBody).toContain('5.5');
    });
    it('Step 0e Other-routing rule covers path-shaped input (.md / docs/plans/)', () => {
        const otherRowMatch = skillBody.match(/\|\s*\*\*Other\*\*\s*\|[\s\S]*?\n\|/);
        expect(otherRowMatch, 'could not find Other row in Step 0e routing table').not.toBeNull();
        const otherRow = otherRowMatch[0];
        expect(otherRow.includes('Pick up existing plan'), 'expected Other row to mention Pick up existing plan as the path-shaped destination').toBe(true);
        expect(otherRow.includes('docs/plans/') || otherRow.includes('.md'), 'expected Other row to mention docs/plans/ or .md as the path-shape signal').toBe(true);
    });
});
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
//# sourceMappingURL=menu-options.test.js.map