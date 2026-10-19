import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { detectCliCapabilities, splitBeadsByProvider, describeCapabilities, swarmMixFor, adaptPromptFor, } from '../../adapters/model-diversity.js';
import { pickAgentName, allocateAgentNames, randomAgentName, AGENT_NAME_POOL_SIZE, AGENT_NAME_ADJECTIVES, AGENT_NAME_NOUNS, } from '../../adapters/agent-names.js';
// ─── Helpers ───────────────────────────────────────────────────────────────
/** `which` finds the listed binaries; `pi auth check` answers `ready` unless `piAuth` is false. */
function makeWhichExec(present, piAuth = true) {
    return async (cmd, args) => {
        if (cmd === 'pi' || cmd === present['pi']) {
            return piAuth && args[0] === 'auth'
                ? { code: 0, stdout: '{"status":"ready","provider":"vercel-ai-gateway","authType":"api_key"}\n', stderr: '' }
                : { code: 1, stdout: '{"status":"not_ready","provider":"vercel-ai-gateway","reason":"credentials_not_configured"}\n', stderr: '' };
        }
        if (cmd !== 'which') {
            return { code: 1, stdout: '', stderr: 'unexpected cmd' };
        }
        const target = args[0];
        const path = present[target];
        if (path)
            return { code: 0, stdout: `${path}\n`, stderr: '' };
        return { code: 1, stdout: '', stderr: `${target} not found` };
    };
}
function caps(available = {}) {
    const mk = (p, a) => a
        ? { provider: p, available: true, path: `/usr/local/bin/${p}` }
        : { provider: p, available: false, reason: `${p} not on PATH` };
    return {
        claude: mk('claude', available.claude !== false),
        codex: mk('codex', available.codex !== false),
        gemini: mk('gemini', available.gemini !== false),
        pi: mk('pi', available.pi !== false),
    };
}
const SIX = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
function geminiOff(base = caps()) {
    return { ...base, gemini: { provider: 'gemini', available: false, disabled: true, reason: 'disabled in flywheel.config.yaml' } };
}
// ─── CLI detection ─────────────────────────────────────────────────────────
describe('detectCliCapabilities', () => {
    it('reports every lane when which finds the CLIs and Pi has gateway credentials, running Gemini on pi', async () => {
        const exec = vi.fn(makeWhichExec({
            claude: '/usr/local/bin/claude',
            codex: '/usr/local/bin/codex',
            gemini: '/usr/local/bin/gemini',
            pi: '/usr/local/bin/pi',
        }));
        const result = await detectCliCapabilities(exec);
        expect(result.claude.available).toBe(true);
        expect(result.codex.available).toBe(true);
        expect(result.gemini).toEqual({ provider: 'gemini', available: true, path: '/usr/local/bin/pi' });
        expect(result.pi.available).toBe(true);
        expect(result.claude.path).toBe('/usr/local/bin/claude');
        expect(exec.mock.calls.some(([cmd, args]) => cmd === 'which' && args[0] === 'gemini')).toBe(false);
    });
    it('ignores an installed gemini CLI: the Gemini lane needs pi', async () => {
        const exec = makeWhichExec({ claude: '/usr/local/bin/claude', gemini: '/opt/bin/gemini' });
        const result = await detectCliCapabilities(exec);
        expect(result.gemini).toEqual({ provider: 'gemini', available: false, reason: 'which pi exited 1' });
    });
    it('needs the gateway for the Gemini lane even when Pi runs on a direct login', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'model-diversity-gemini-'));
        try {
            mkdirSync(join(cwd, '.pi-flywheel'));
            writeFileSync(join(cwd, '.pi-flywheel', 'pi-models.json'), JSON.stringify({ version: 2, picks: { implementer: { piModels: ['xai/grok-4.7'], chosenAt: '2026-10-19T00:00:00.000Z' } } }));
            const exec = async (cmd, args) => {
                if (cmd === 'which') {
                    return args[0] === 'pi' || args[0] === 'claude'
                        ? { code: 0, stdout: `/usr/local/bin/${args[0]}\n`, stderr: '' }
                        : { code: 1, stdout: '', stderr: '' };
                }
                const provider = args[args.indexOf('--provider') + 1];
                return provider === 'xai'
                    ? { code: 0, stdout: '{"status":"ready","provider":"xai","authType":"oauth"}\n', stderr: '' }
                    : { code: 1, stdout: `{"status":"not_ready","provider":"${provider}","reason":"credentials_not_configured"}\n`, stderr: '' };
            };
            const result = await detectCliCapabilities(exec, { cwd });
            expect(result.pi.available).toBe(true);
            expect(result.gemini).toEqual({
                provider: 'gemini',
                available: false,
                path: '/usr/local/bin/pi',
                reason: 'pi auth check: vercel-ai-gateway not_ready (credentials_not_configured)',
            });
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('reports Pi as unavailable, keeping its path, when the gateway auth check fails', async () => {
        const exec = makeWhichExec({ claude: '/usr/local/bin/claude', pi: '/usr/local/bin/pi' }, false);
        const result = await detectCliCapabilities(exec);
        expect(result.pi.available).toBe(false);
        expect(result.pi.path).toBe('/usr/local/bin/pi');
        expect(result.pi.reason).toBe('pi auth check: vercel-ai-gateway not_ready (credentials_not_configured)');
    });
    it('reports missing CLIs as unavailable with a reason', async () => {
        const exec = makeWhichExec({
            claude: '/usr/local/bin/claude',
            codex: false,
        });
        const result = await detectCliCapabilities(exec);
        expect(result.claude.available).toBe(true);
        expect(result.codex.available).toBe(false);
        expect(result.codex.reason).toBeTruthy();
        expect(result.gemini.available).toBe(false);
        expect(result.pi.available).toBe(false);
    });
    it('reports a lane switched off in flywheel.config.yaml as disabled without probing it', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'model-diversity-lanes-'));
        try {
            writeFileSync(join(cwd, 'flywheel.config.yaml'), 'lanes:\n  gemini: false\n');
            const exec = vi.fn(makeWhichExec({ claude: '/usr/local/bin/claude', gemini: '/opt/bin/gemini', pi: '/usr/local/bin/pi' }));
            const result = await detectCliCapabilities(exec, { cwd });
            expect(result.gemini).toEqual({ provider: 'gemini', available: false, disabled: true, reason: 'disabled in flywheel.config.yaml' });
            expect(result.pi.available).toBe(true);
            expect(exec.mock.calls.filter(([cmd, args]) => cmd === 'which' && args[0] === 'pi')).toHaveLength(1);
        }
        finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('does not throw when exec rejects — surfaces as unavailable', async () => {
        const exec = async () => {
            throw new Error('spawn which ENOENT');
        };
        const result = await detectCliCapabilities(exec);
        expect(result.claude.available).toBe(false);
        expect(result.claude.reason).toMatch(/ENOENT/);
    });
});
// ─── Split logic ───────────────────────────────────────────────────────────
describe('splitBeadsByProvider', () => {
    it('six-bead wave with all CLIs present assigns Claude, Pi, and Gemini 2/2/2', () => {
        const plan = splitBeadsByProvider(SIX, caps());
        expect(plan.lanes).toEqual([
            { provider: 'claude', beadIds: ['b1', 'b2'] },
            { provider: 'pi', beadIds: ['b3', 'b4'] },
            { provider: 'gemini', beadIds: ['b5', 'b6'] },
        ]);
        expect(plan.ratio).toBe('2:2:2');
        expect(plan.degraded).toBe(false);
        expect(plan.warnings).toEqual([]);
    });
    it('missing Pi hands its share to Codex', () => {
        const plan = splitBeadsByProvider(SIX, caps({ pi: false }));
        expect(plan.lanes).toEqual([
            { provider: 'claude', beadIds: ['b1', 'b2'] },
            { provider: 'gemini', beadIds: ['b5', 'b6'] },
            { provider: 'codex', beadIds: ['b3', 'b4'] },
        ]);
        expect(plan.warnings).toEqual([
            'pi lane not available (pi not on PATH); reassigned 2 bead(s) to codex',
        ]);
        expect(plan.ratio).toBe('2:0:2');
        expect(plan.degraded).toBe(true);
    });
    it('missing Pi and Codex hands the Pi share to Gemini', () => {
        const plan = splitBeadsByProvider(SIX, caps({ pi: false, codex: false }));
        expect(plan.lanes).toEqual([
            { provider: 'claude', beadIds: ['b1', 'b2'] },
            { provider: 'gemini', beadIds: ['b3', 'b4', 'b5', 'b6'] },
        ]);
        expect(plan.ratio).toBe('2:0:4');
    });
    it('missing Gemini hands its share to Pi, not Codex', () => {
        const plan = splitBeadsByProvider(SIX, caps({ gemini: false }));
        expect(plan.lanes).toEqual([
            { provider: 'claude', beadIds: ['b1', 'b2'] },
            { provider: 'pi', beadIds: ['b3', 'b4', 'b5', 'b6'] },
        ]);
        expect(plan.warnings).toEqual([
            'gemini lane not available (gemini not on PATH); reassigned 2 bead(s) to pi',
        ]);
        expect(plan.ratio).toBe('2:4:0');
    });
    it('a disabled Gemini hands its share to Pi without warning or degrading', () => {
        const plan = splitBeadsByProvider(SIX, geminiOff());
        expect(plan.lanes).toEqual([
            { provider: 'claude', beadIds: ['b1', 'b2'] },
            { provider: 'pi', beadIds: ['b3', 'b4', 'b5', 'b6'] },
        ]);
        expect(plan.warnings).toEqual([]);
        expect(plan.degraded).toBe(false);
        expect(plan.ratio).toBe('2:4:0');
    });
    it('a disabled Gemini still degrades when Pi is missing too', () => {
        const plan = splitBeadsByProvider(SIX, geminiOff(caps({ pi: false })));
        expect(plan.lanes).toEqual([
            { provider: 'claude', beadIds: ['b1', 'b2'] },
            { provider: 'codex', beadIds: ['b3', 'b4', 'b5', 'b6'] },
        ]);
        expect(plan.warnings).toEqual(['pi lane not available (pi not on PATH); reassigned 2 bead(s) to codex']);
        expect(plan.degraded).toBe(true);
    });
    it('missing Pi and Gemini hands both shares to Codex', () => {
        const plan = splitBeadsByProvider(SIX, caps({ pi: false, gemini: false }));
        expect(plan.lanes).toEqual([
            { provider: 'claude', beadIds: ['b1', 'b2'] },
            { provider: 'codex', beadIds: ['b3', 'b4', 'b5', 'b6'] },
        ]);
        expect(plan.warnings).toEqual([
            'pi lane not available (pi not on PATH); reassigned 2 bead(s) to codex',
            'gemini lane not available (gemini not on PATH); reassigned 2 bead(s) to codex',
        ]);
        expect(plan.ratio).toBe('2:0:0');
    });
    it('only Claude left takes every share', () => {
        const plan = splitBeadsByProvider(SIX, caps({ pi: false, gemini: false, codex: false }));
        expect(plan.lanes).toEqual([{ provider: 'claude', beadIds: SIX }]);
        expect(plan.ratio).toBe('6:0:0');
    });
    it('3-bead wave with all CLIs present → 1 Claude + 1 Pi + 1 Gemini', () => {
        const plan = splitBeadsByProvider(['b1', 'b2', 'b3'], caps());
        expect(plan.lanes).toEqual([
            { provider: 'claude', beadIds: ['b1'] },
            { provider: 'pi', beadIds: ['b2'] },
            { provider: 'gemini', beadIds: ['b3'] },
        ]);
        expect(plan.ratio).toBe('1:1:1');
    });
    it('N % 3 = 1 → claude gets the extra bead', () => {
        const plan = splitBeadsByProvider(['a', 'b', 'c', 'd'], caps());
        expect(plan.lanes.map((l) => l.beadIds.length)).toEqual([2, 1, 1]);
        expect(plan.ratio).toBe('2:1:1');
    });
    it('N % 3 = 2 → claude + pi get the extras', () => {
        const plan = splitBeadsByProvider(['a', 'b', 'c', 'd', 'e'], caps());
        expect(plan.lanes.map((l) => [l.provider, l.beadIds.length])).toEqual([
            ['claude', 2],
            ['pi', 2],
            ['gemini', 1],
        ]);
        expect(plan.ratio).toBe('2:2:1');
    });
    it('all CLIs missing → empty lanes + degraded + actionable warning', () => {
        const plan = splitBeadsByProvider(['b1'], caps({ claude: false, codex: false, gemini: false, pi: false }));
        expect(plan.lanes).toEqual([]);
        expect(plan.degraded).toBe(true);
        expect(plan.warnings.length).toBeGreaterThan(0);
        expect(plan.ratio).toBe('0:0:0');
    });
    it('preserves bead order within lanes (priority-sorted input)', () => {
        const plan = splitBeadsByProvider(['p0', 'p1', 'p2', 'p3', 'p4', 'p5'], caps());
        expect(plan.lanes.map((l) => l.beadIds)).toEqual([['p0', 'p1'], ['p2', 'p3'], ['p4', 'p5']]);
    });
    it('describeCapabilities formats the doctor one-liner', () => {
        expect(describeCapabilities(caps())).toBe('claude+pi+gemini available; ratio 1:1:1 achievable; codex fallback available');
        expect(describeCapabilities(caps({ pi: false, codex: false }))).toBe('claude+gemini available; pi missing; ratio 1:0:1 achievable');
        expect(describeCapabilities(geminiOff())).toBe('claude+pi available; gemini disabled; ratio 1:1:0 achievable; codex fallback available');
    });
});
describe('swarmMixFor', () => {
    it('names only the lanes a six-pane swarm spawns on this host', () => {
        expect(swarmMixFor(caps())).toEqual({ label: 'cc:pi:gmi 2:2:2', spawnFlags: '--cc=2 --pi=2 --gmi=2' });
        expect(swarmMixFor(geminiOff())).toEqual({ label: 'cc:pi 2:4', spawnFlags: '--cc=2 --pi=4' });
        expect(swarmMixFor(caps({ pi: false }))).toEqual({ label: 'cc:gmi:cod 2:2:2', spawnFlags: '--cc=2 --gmi=2 --cod=2' });
        expect(swarmMixFor(geminiOff(caps({ pi: false })))).toEqual({ label: 'cc:cod 2:4', spawnFlags: '--cc=2 --cod=4' });
        expect(swarmMixFor(caps({ pi: false, gemini: false, codex: false }))).toEqual({ label: 'cc 6', spawnFlags: '--cc=6' });
    });
    it('scales with the pane count and is undefined when no lane is usable', () => {
        expect(swarmMixFor(geminiOff(), 3)).toEqual({ label: 'cc:pi 1:2', spawnFlags: '--cc=1 --pi=2' });
        expect(swarmMixFor(caps({ claude: false, pi: false, gemini: false, codex: false }))).toBeUndefined();
    });
});
// ─── Prompt adaptation facade ──────────────────────────────────────────────
describe('adaptPromptFor', () => {
    const ctx = {
        beadId: 'agent-flywheel-plugin-x6g',
        title: 'codex parity',
        description: 'wire up swarm model diversity',
        acceptance: ['claude/codex/gemini at 1:1:1', 'doctor reports CLIs'],
        complexity: 'medium',
        relevantFiles: ['mcp-server/src/adapters/model-diversity.ts'],
        priorArtBeads: [],
        agentName: 'CoralDune',
        coordinatorName: 'SilentHarbor',
        projectKey: 'agent-flywheel-plugin',
    };
    it('claude adapter emits a Step 0 bootstrap with macro_start_session', () => {
        const out = adaptPromptFor('claude', ctx);
        expect(out.provider).toBe('claude');
        expect(out.prompt).toContain('macro_start_session');
        expect(out.prompt).toContain('CoralDune');
        expect(out.prompt).toContain('SilentHarbor');
        expect(out.prompt).toContain('agent-flywheel-plugin-x6g');
        expect(out.trailingNewlines).toBe(1);
    });
    it('codex adapter requests 2 trailing newlines for input-buffer quirk', () => {
        const out = adaptPromptFor('codex', ctx);
        expect(out.provider).toBe('codex');
        expect(out.trailingNewlines).toBe(2);
        expect(out.prompt).toContain('COMPLETION_REPORT');
        expect(out.prompt).toContain("program='codex'");
    });
    it('gemini adapter is a Pi pane on gemini-4-argon, so Agent Mail goes through the am CLI', () => {
        const out = adaptPromptFor('gemini', ctx);
        expect(out.provider).toBe('gemini');
        expect(out.trailingNewlines).toBe(1);
        expect(out.prompt).toContain("0a. am macros start-session --project 'agent-flywheel-plugin' --program pi --model gemini-4-argon --agent-name 'CoralDune'");
        expect(out.prompt).not.toContain('macro_start_session(');
        expect(out.prompt).not.toContain('gemini-cli');
    });
    it('pi adapter routes Agent Mail through the am CLI because Pi panes load no project MCP servers', () => {
        const out = adaptPromptFor('pi', { ...ctx, title: "Fix Bob's parser" });
        expect(out.provider).toBe('pi');
        expect(out.trailingNewlines).toBe(1);
        expect(out.prompt).toContain("0a. am macros start-session --project 'agent-flywheel-plugin' --program pi --model pi --agent-name 'CoralDune' --task 'Implementing bead agent-flywheel-plugin-x6g: Fix Bob'\\''s parser' --json");
        expect(out.prompt).toContain("am file_reservations reserve 'agent-flywheel-plugin' 'CoralDune' <path>... --exclusive");
        expect(out.prompt).toContain("am mail send --project 'agent-flywheel-plugin' --from 'CoralDune' --to 'SilentHarbor' --subject '[impl] agent-flywheel-plugin-x6g done'");
        expect(out.prompt).toContain("- am file_reservations release 'agent-flywheel-plugin' 'CoralDune'");
        expect(out.prompt).not.toContain('macro_start_session(');
        expect(out.prompt).not.toContain('send_message to');
    });
    it('claude adapter keeps the Agent Mail MCP tool calls', () => {
        const out = adaptPromptFor('claude', ctx);
        expect(out.prompt).toContain("0c. send_message to 'SilentHarbor' subject '[impl] agent-flywheel-plugin-x6g started'.");
        expect(out.prompt).toContain('- release_file_reservations.');
        expect(out.prompt).not.toContain('am mail send');
    });
});
// ─── Agent-name pool ───────────────────────────────────────────────────────
describe('agent-names', () => {
    it('exposes pool of at least 30 names', () => {
        expect(AGENT_NAME_ADJECTIVES.length).toBeGreaterThanOrEqual(30);
        expect(AGENT_NAME_NOUNS.length).toBeGreaterThanOrEqual(30);
        expect(AGENT_NAME_POOL_SIZE).toBeGreaterThanOrEqual(900);
    });
    it('pickAgentName is deterministic and returns CamelCase adjective+noun', () => {
        const a = pickAgentName('cc-1-bead-x6g');
        const b = pickAgentName('cc-1-bead-x6g');
        expect(a).toBe(b);
        expect(a).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+$/);
    });
    it('allocateAgentNames returns N distinct names', () => {
        const names = allocateAgentNames(14, 'wave-2026-04-23');
        expect(names).toHaveLength(14);
        expect(new Set(names).size).toBe(14);
        for (const n of names) {
            expect(n).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+$/);
        }
    });
    it('allocateAgentNames refuses requests larger than the pool', () => {
        expect(() => allocateAgentNames(AGENT_NAME_POOL_SIZE + 1, 'overflow')).toThrow(/pool only holds/);
    });
    it('randomAgentName returns a valid-looking name', () => {
        for (let i = 0; i < 5; i++) {
            expect(randomAgentName()).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+$/);
        }
    });
    it('rejects descriptive role-style names by construction (no hyphens, no lowercase prefix)', () => {
        // Spot-check a few: the pool entries themselves should never look like
        // "research-coordinator" — that's the failure mode the agent-mail
        // server complains about.
        for (const adj of AGENT_NAME_ADJECTIVES) {
            expect(adj).not.toMatch(/-/);
            expect(adj[0]).toBe(adj[0].toUpperCase());
        }
        for (const noun of AGENT_NAME_NOUNS) {
            expect(noun).not.toMatch(/-/);
            expect(noun[0]).toBe(noun[0].toUpperCase());
        }
    });
});
//# sourceMappingURL=model-diversity.test.js.map