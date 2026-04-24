import { describe, expect, it } from 'vitest';
import { AGENT_NAME_ADJECTIVES, AGENT_NAME_NOUNS, AGENT_NAME_POOL_SIZE, allocateAgentNames, pickAgentName, randomAgentName, } from '../../adapters/agent-names.js';
function expectAdjectiveNounName(name) {
    const adjective = AGENT_NAME_ADJECTIVES.find((candidate) => name.startsWith(candidate));
    expect(adjective, `${name} should start with a pooled adjective`).toBeDefined();
    expect(AGENT_NAME_NOUNS, `${name} should end with a pooled noun`).toContain(name.slice(adjective.length));
    expect(name).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+$/);
}
describe('agent-names', () => {
    it('fails fast when the requested allocation exceeds the pool capacity', () => {
        expect(() => allocateAgentNames(AGENT_NAME_POOL_SIZE + 1, 'overflow')).toThrow(`requested ${AGENT_NAME_POOL_SIZE + 1} names`);
    });
    it('skips deterministic name collisions within a single allocation', () => {
        const baseSeed = 'collision-3';
        expect(pickAgentName(`${baseSeed}#14`)).toBe('XenialAnchor');
        expect(pickAgentName(`${baseSeed}#43`)).toBe('XenialAnchor');
        const names = allocateAgentNames(44, baseSeed);
        expect(names).toHaveLength(44);
        expect(new Set(names).size).toBe(44);
        expect(names.filter((name) => name === 'XenialAnchor')).toHaveLength(1);
    });
    it('returns [] for count=0 (no allocation needed)', () => {
        expect(allocateAgentNames(0, 'seed')).toEqual([]);
    });
    it('throws for negative count (underflow guard at the call site)', () => {
        expect(() => allocateAgentNames(-1, 'seed')).toThrow(/count must be >= 0/);
    });
    it('returns only adjective+noun Agent Mail names from every public picker', () => {
        const names = [
            pickAgentName('agent-flywheel-plugin-byx'),
            ...allocateAgentNames(14, 'wave-agent-flywheel-plugin-byx'),
        ];
        for (let i = 0; i < 10; i++) {
            names.push(randomAgentName());
        }
        for (const name of names) {
            expectAdjectiveNounName(name);
        }
    });
});
//# sourceMappingURL=agent-names.test.js.map