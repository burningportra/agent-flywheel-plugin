import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const repoRoot = resolve(__dirname, '../../../../..');
function read(relativePath) {
    return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}
const implementerSurfaces = [
    'skills/start/_implement.md',
    'skills/flywheel-swarm/SKILL.md',
    'commands/flywheel-swarm.md',
];
describe('server-owned wave-one implementer dispatch', () => {
    it.each(implementerSurfaces)('%s dispatches returned lanes and prompts', (relativePath) => {
        const content = read(relativePath);
        expect(content).toContain('data.lanes');
        expect(content).toContain('data.prompts');
        expect(content).toContain('coordinatorName');
        expect(content).not.toContain('Follow AGENTS.md § "Pre-Completion Quality Gate"');
        expect(content).not.toContain('copy the gate text from AGENTS.md');
    });
    it('keeps the NTM spawn and pane-addressing invariants', () => {
        const content = read('skills/start/_implement.md');
        expect(content).toContain('ntm spawn "$NTM_PROJECT" --label impl-<goal-slug> --no-user');
        expect(content).toContain('--cc=<N_cc> --cod=<N_cod> --gmi=<N_gmi> --pi=<N_pi> --stagger-mode=smart');
        expect(content).toContain('Use `--panes=N`');
        expect(content).toContain('`--pane=N` (singular) is silently broadcast to ALL panes');
    });
    it('branches on every server-owned batch-review next step kind', () => {
        const content = read('skills/start/_implement.md');
        for (const kind of [
            'batch_review_due',
            'advance_wave',
            'needs_attention',
            'synthesized_beads_pending',
        ]) {
            expect(content).toContain(`\`${kind}\``);
        }
    });
});
//# sourceMappingURL=implement-dispatch-contract.test.js.map