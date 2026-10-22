import { describe, expect, it } from 'vitest';
import { splitBeadsByProvider, swarmMixFor, } from '../adapters/model-diversity.js';
const SIX = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
function capsWithAgy(available = {}, disabled = {}) {
    const mk = (p, a, off = false) => a
        ? { provider: p, available: true, path: `/usr/local/bin/${p}` }
        : {
            provider: p,
            available: false,
            ...(off ? { disabled: true } : {}),
            reason: off ? 'disabled in flywheel.config.yaml' : `${p} not on PATH`,
        };
    return {
        claude: mk('claude', available.claude !== false, disabled.claude),
        codex: mk('codex', available.codex !== false),
        gemini: mk('gemini', available.gemini !== false, disabled.gemini),
        pi: mk('pi', available.pi !== false, disabled.pi),
        agy: mk('agy', available.agy !== false),
    };
}
describe('splitBeadsByProvider & swarmMixFor — includePi opt-in with AGY', () => {
    it('defaults to Claude + AGY 1:1 (3:3 on 6 panes) when includePi is omitted or false', () => {
        const omitted = splitBeadsByProvider(SIX, capsWithAgy());
        const explicitFalse = { includePi: false };
        const withFalse = splitBeadsByProvider(SIX, capsWithAgy(), explicitFalse);
        for (const plan of [omitted, withFalse]) {
            expect(plan.lanes).toEqual([
                { provider: 'claude', beadIds: ['b1', 'b2', 'b3'] },
                { provider: 'agy', beadIds: ['b4', 'b5', 'b6'] },
            ]);
            expect(plan.degraded).toBe(false);
            expect(plan.warnings).toEqual([]);
        }
        expect(swarmMixFor(capsWithAgy(), 6)).toEqual({
            label: 'cc:agy 3:3',
            spawnFlags: '--cc=3 --agy=3',
        });
        expect(swarmMixFor(capsWithAgy(), 6, { includePi: false })).toEqual({
            label: 'cc:agy 3:3',
            spawnFlags: '--cc=3 --agy=3',
        });
    });
    it('splits 1:1:1 across Claude, Pi, and AGY (2:2:2 on 6 panes) when includePi is true', () => {
        const plan = splitBeadsByProvider(SIX, capsWithAgy(), { includePi: true });
        expect(plan.lanes).toEqual([
            { provider: 'claude', beadIds: ['b1', 'b2'] },
            { provider: 'pi', beadIds: ['b3', 'b4'] },
            { provider: 'agy', beadIds: ['b5', 'b6'] },
        ]);
        expect(plan.degraded).toBe(false);
        expect(plan.warnings).toEqual([]);
        expect(plan.ratio).toBe('2:2:0');
        expect(swarmMixFor(capsWithAgy(), 6, { includePi: true })).toEqual({
            label: 'cc:pi:agy 2:2:2',
            spawnFlags: '--cc=2 --pi=2 --agy=2',
        });
    });
    it('falls back cleanly with a warning when includePi is true but Pi is unavailable', () => {
        const plan = splitBeadsByProvider(SIX, capsWithAgy({ pi: false }), { includePi: true });
        expect(plan.lanes).toEqual([
            { provider: 'claude', beadIds: ['b1', 'b2', 'b3', 'b4'] },
            { provider: 'agy', beadIds: ['b5', 'b6'] },
        ]);
        expect(plan.degraded).toBe(true);
        expect(plan.warnings).toEqual([
            'pi lane not available (pi not on PATH); reassigned 2 bead(s) to claude',
        ]);
        expect(swarmMixFor(capsWithAgy({ pi: false }), 6, { includePi: true })).toEqual({
            label: 'cc:agy 4:2',
            spawnFlags: '--cc=4 --agy=2',
        });
    });
    it('falls back cleanly with a warning when includePi is true but Claude is unavailable', () => {
        const plan = splitBeadsByProvider(SIX, capsWithAgy({ claude: false }), { includePi: true });
        expect(plan.lanes).toEqual([
            { provider: 'pi', beadIds: ['b1', 'b2', 'b3', 'b4'] },
            { provider: 'agy', beadIds: ['b5', 'b6'] },
        ]);
        expect(plan.degraded).toBe(true);
        expect(plan.warnings).toEqual([
            'claude lane not available (claude not on PATH); reassigned 2 bead(s) to pi',
        ]);
        expect(swarmMixFor(capsWithAgy({ claude: false }), 6, { includePi: true })).toEqual({
            label: 'pi:agy 4:2',
            spawnFlags: '--pi=4 --agy=2',
        });
    });
    it('does not warn or degrade when includePi is true and Pi is explicitly disabled in config', () => {
        const plan = splitBeadsByProvider(SIX, capsWithAgy({ pi: false }, { pi: true }), { includePi: true });
        expect(plan.lanes).toEqual([
            { provider: 'claude', beadIds: ['b1', 'b2', 'b3', 'b4'] },
            { provider: 'agy', beadIds: ['b5', 'b6'] },
        ]);
        expect(plan.degraded).toBe(false);
        expect(plan.warnings).toEqual([]);
    });
});
//# sourceMappingURL=model-diversity.test.js.map