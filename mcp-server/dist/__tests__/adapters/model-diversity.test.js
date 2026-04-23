import { describe, it, expect } from 'vitest';
import { detectCliCapabilities, splitBeadsByProvider, describeCapabilities, adaptPromptFor, } from '../../adapters/model-diversity.js';
import { pickAgentName, allocateAgentNames, randomAgentName, AGENT_NAME_POOL_SIZE, AGENT_NAME_ADJECTIVES, AGENT_NAME_NOUNS, } from '../../adapters/agent-names.js';
// ─── Helpers ───────────────────────────────────────────────────────────────
function makeWhichExec(present) {
    return async (cmd, args) => {
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
    };
}
// ─── CLI detection ─────────────────────────────────────────────────────────
describe('detectCliCapabilities', () => {
    it('reports all three as available when which finds them', async () => {
        const exec = makeWhichExec({
            claude: '/usr/local/bin/claude',
            codex: '/usr/local/bin/codex',
            gemini: '/usr/local/bin/gemini',
        });
        const result = await detectCliCapabilities(exec);
        expect(result.claude.available).toBe(true);
        expect(result.codex.available).toBe(true);
        expect(result.gemini.available).toBe(true);
        expect(result.claude.path).toBe('/usr/local/bin/claude');
    });
    it('reports missing CLIs as unavailable with a reason', async () => {
        const exec = makeWhichExec({
            claude: '/usr/local/bin/claude',
            codex: false,
            gemini: '/opt/bin/gemini',
        });
        const result = await detectCliCapabilities(exec);
        expect(result.claude.available).toBe(true);
        expect(result.codex.available).toBe(false);
        expect(result.codex.reason).toBeTruthy();
        expect(result.gemini.available).toBe(true);
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
    it('3-bead wave with all CLIs present → 1 Claude + 1 Codex + 1 Gemini', () => {
        const plan = splitBeadsByProvider(['b1', 'b2', 'b3'], caps());
        expect(plan.lanes).toHaveLength(3);
        expect(plan.lanes[0]).toEqual({ provider: 'claude', beadIds: ['b1'] });
        expect(plan.lanes[1]).toEqual({ provider: 'codex', beadIds: ['b2'] });
        expect(plan.lanes[2]).toEqual({ provider: 'gemini', beadIds: ['b3'] });
        expect(plan.degraded).toBe(false);
        expect(plan.warnings).toHaveLength(0);
        expect(plan.ratio).toBe('1:1:1');
    });
    it('missing codex → fallback redistributes share to claude/gemini + warning', () => {
        const plan = splitBeadsByProvider(['b1', 'b2', 'b3'], caps({ codex: false }));
        expect(plan.degraded).toBe(true);
        expect(plan.warnings.some((w) => w.includes('codex'))).toBe(true);
        expect(plan.lanes).toHaveLength(2);
        // 3 beads, 2 lanes: floor(3/2)=1 each, remainder 1 → claude (priority 1).
        const claude = plan.lanes.find((l) => l.provider === 'claude');
        const gemini = plan.lanes.find((l) => l.provider === 'gemini');
        expect(claude.beadIds).toEqual(['b1', 'b2']);
        expect(gemini.beadIds).toEqual(['b3']);
        // No codex lane present.
        expect(plan.lanes.find((l) => l.provider === 'codex')).toBeUndefined();
        expect(plan.ratio).toBe('2:0:1');
    });
    it('N % 3 = 1 → claude gets the extra bead', () => {
        const plan = splitBeadsByProvider(['a', 'b', 'c', 'd'], caps());
        const claude = plan.lanes.find((l) => l.provider === 'claude');
        const codex = plan.lanes.find((l) => l.provider === 'codex');
        const gemini = plan.lanes.find((l) => l.provider === 'gemini');
        expect(claude.beadIds).toHaveLength(2);
        expect(codex.beadIds).toHaveLength(1);
        expect(gemini.beadIds).toHaveLength(1);
        expect(plan.ratio).toBe('2:1:1');
    });
    it('N % 3 = 2 → claude + codex get the extras', () => {
        const plan = splitBeadsByProvider(['a', 'b', 'c', 'd', 'e'], caps());
        const claude = plan.lanes.find((l) => l.provider === 'claude');
        const codex = plan.lanes.find((l) => l.provider === 'codex');
        const gemini = plan.lanes.find((l) => l.provider === 'gemini');
        expect(claude.beadIds).toHaveLength(2);
        expect(codex.beadIds).toHaveLength(2);
        expect(gemini.beadIds).toHaveLength(1);
        expect(plan.ratio).toBe('2:2:1');
    });
    it('all CLIs missing → empty lanes + degraded + actionable warning', () => {
        const plan = splitBeadsByProvider(['b1'], caps({ claude: false, codex: false, gemini: false }));
        expect(plan.lanes).toEqual([]);
        expect(plan.degraded).toBe(true);
        expect(plan.warnings.length).toBeGreaterThan(0);
        expect(plan.ratio).toBe('0:0:0');
    });
    it('preserves bead order within lanes (priority-sorted input)', () => {
        const plan = splitBeadsByProvider(['p0', 'p1', 'p2', 'p3', 'p4', 'p5'], caps());
        expect(plan.lanes[0].beadIds).toEqual(['p0', 'p1']);
        expect(plan.lanes[1].beadIds).toEqual(['p2', 'p3']);
        expect(plan.lanes[2].beadIds).toEqual(['p4', 'p5']);
    });
    it('describeCapabilities formats the doctor one-liner', () => {
        expect(describeCapabilities(caps())).toContain('ratio 1:1:1');
        const partial = describeCapabilities(caps({ codex: false }));
        expect(partial).toContain('codex missing');
        expect(partial).toContain('ratio 1:0:1');
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
    it('gemini adapter emits role framing + STOP guard', () => {
        const out = adaptPromptFor('gemini', ctx);
        expect(out.provider).toBe('gemini');
        expect(out.prompt).toContain('# ROLE');
        expect(out.prompt).toContain('STOP');
        expect(out.prompt).toContain("program='gemini-cli'");
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