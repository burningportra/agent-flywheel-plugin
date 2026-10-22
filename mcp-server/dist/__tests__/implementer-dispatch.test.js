import { describe, expect, it, vi } from 'vitest';
import { buildImplementerDispatch } from '../adapters/implementer-dispatch.js';
import { TOOLS } from '../server.js';
import { runAdvanceWave } from '../tools/advance-wave.js';
import { runApprove } from '../tools/approve.js';
import { summarizeTool } from '../tools/capabilities.js';
import { createInitialState } from '../types.js';
const unusedExec = async () => {
    throw new Error('capability probe should not run when capabilities are supplied');
};
function capabilitiesWithAgy(pi = true) {
    return {
        claude: { provider: 'claude', available: true, path: '/bin/claude' },
        codex: { provider: 'codex', available: true, path: '/bin/codex' },
        gemini: { provider: 'gemini', available: true, path: '/bin/pi' },
        pi: pi
            ? { provider: 'pi', available: true, path: '/bin/pi' }
            : { provider: 'pi', available: false, reason: 'pi not installed' },
        agy: { provider: 'agy', available: true, path: '/usr/local/bin/agy' },
    };
}
function makeBeads(count, label = 'goal:test-goal') {
    return Array.from({ length: count }, (_, index) => ({
        id: `bead-${index + 1}`,
        title: `Implement feature ${index + 1}`,
        description: `Implement feature ${index + 1}.\n- Verify behavior ${index + 1}.`,
        status: 'open',
        priority: 2,
        type: 'task',
        labels: [label],
    }));
}
describe('buildImplementerDispatch — includePi opt-in threading', () => {
    it('defaults to cc:agy 3:3 when agy is available and includePi is omitted', async () => {
        const dispatch = await buildImplementerDispatch({
            exec: unusedExec,
            cwd: '/workspace/project',
            beads: makeBeads(6),
            coordinatorName: 'WindyBasin',
            capabilities: capabilitiesWithAgy(),
        });
        expect(dispatch.lanes).toEqual([
            { lane: 'cc', beadIds: ['bead-1', 'bead-2', 'bead-3'] },
            { lane: 'agy', beadIds: ['bead-4', 'bead-5', 'bead-6'] },
        ]);
        expect(dispatch.prompts.map((p) => p.lane)).toEqual([
            'cc', 'cc', 'cc', 'agy', 'agy', 'agy',
        ]);
        expect(dispatch.degraded).toBe(false);
        expect(dispatch.warnings).toEqual([]);
    });
    it('splits 2:2:2 across cc:pi:agy when agy is available and includePi is true', async () => {
        const dispatch = await buildImplementerDispatch({
            exec: unusedExec,
            cwd: '/workspace/project',
            beads: makeBeads(6),
            coordinatorName: 'WindyBasin',
            capabilities: capabilitiesWithAgy(),
            includePi: true,
        });
        expect(dispatch.lanes).toEqual([
            { lane: 'cc', beadIds: ['bead-1', 'bead-2'] },
            { lane: 'pi', beadIds: ['bead-3', 'bead-4'] },
            { lane: 'agy', beadIds: ['bead-5', 'bead-6'] },
        ]);
        expect(dispatch.prompts.map((p) => p.lane)).toEqual([
            'cc', 'cc', 'pi', 'pi', 'agy', 'agy',
        ]);
        expect(dispatch.degraded).toBe(false);
        expect(dispatch.warnings).toEqual([]);
    });
    it('threads includePi through flywheel_approve_beads(action="start") and flywheel_advance_wave', async () => {
        const approveTool = TOOLS.find((t) => t.name === 'flywheel_approve_beads');
        const advanceTool = TOOLS.find((t) => t.name === 'flywheel_advance_wave');
        expect(approveTool ? summarizeTool(approveTool).optional : []).toContain('includePi');
        expect(advanceTool ? summarizeTool(advanceTool).optional : []).toContain('includePi');
        const ready = makeBeads(3);
        const exec = async (cmd, args) => {
            if (cmd === 'br' && args[0] === 'list') {
                return { code: 0, stdout: JSON.stringify(ready), stderr: '' };
            }
            if (cmd === 'br' && args[0] === 'ready') {
                return { code: 0, stdout: JSON.stringify(ready), stderr: '' };
            }
            if (cmd === 'br' && args[0] === 'update') {
                return { code: 0, stdout: '', stderr: '' };
            }
            if (cmd === 'br' && args[0] === 'show') {
                return {
                    code: 0,
                    stdout: JSON.stringify({ id: args[1], title: 'done', description: 'done', status: 'closed', priority: 2 }),
                    stderr: '',
                };
            }
            if (cmd === 'which') {
                const target = args[0] ?? '';
                if (target === 'claude' || target === 'pi' || target === 'agy') {
                    return { code: 0, stdout: `/usr/local/bin/${target}\n`, stderr: '' };
                }
                return { code: 1, stdout: '', stderr: 'not found' };
            }
            if (cmd === 'pi' && args[0] === 'auth') {
                return {
                    code: 0,
                    stdout: '{"status":"ready","provider":"vercel-ai-gateway","authType":"api_key"}\n',
                    stderr: '',
                };
            }
            return { code: 0, stdout: '', stderr: '' };
        };
        const state = createInitialState();
        state.selectedGoal = 'Test Goal';
        state.phase = 'awaiting_bead_approval';
        const ctx = {
            exec,
            cwd: process.cwd(),
            state,
            saveState: vi.fn(),
            clearState: vi.fn(),
        };
        const approveRes = await runApprove(ctx, {
            cwd: process.cwd(),
            action: 'start',
            includePi: true,
        });
        const approveData = approveRes.structuredContent.data;
        expect(approveData.lanes).toEqual([
            { lane: 'cc', beadIds: ['bead-1'] },
            { lane: 'pi', beadIds: ['bead-2'] },
            { lane: 'agy', beadIds: ['bead-3'] },
        ]);
        const advanceRes = await runAdvanceWave(ctx, {
            cwd: process.cwd(),
            closedBeadIds: ['bead-0'],
            includePi: true,
        });
        const advanceData = advanceRes.structuredContent.data;
        expect(advanceData.nextWave.lanes).toEqual([
            { lane: 'cc', beadIds: ['bead-1'] },
            { lane: 'pi', beadIds: ['bead-2'] },
            { lane: 'agy', beadIds: ['bead-3'] },
        ]);
    });
});
//# sourceMappingURL=implementer-dispatch.test.js.map