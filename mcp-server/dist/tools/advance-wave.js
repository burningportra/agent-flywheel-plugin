import { runVerifyBeads } from './verify-beads.js';
import { readyBeads } from '../beads.js';
import { recommendComposition } from '../swarm.js';
import { classifyBeadComplexity } from '../model-routing.js';
import { allocateAgentNames } from '../adapters/agent-names.js';
import { adaptPromptForClaude } from '../adapters/claude-prompt.js';
import { adaptPromptForCodex } from '../adapters/codex-prompt.js';
import { adaptPromptForGemini } from '../adapters/gemini-prompt.js';
import { makeOkToolResult, makeToolError } from './shared.js';
import { classifyExecError } from '../errors.js';
import { createLogger } from '../logger.js';
import * as path from 'node:path';
const log = createLogger('advance-wave');
const LANES = ['cc', 'cod', 'gem'];
const LANE_ADAPTERS = {
    cc: adaptPromptForClaude,
    cod: adaptPromptForCodex,
    gem: adaptPromptForGemini,
};
function okResult(phase, text, data) {
    return makeOkToolResult('flywheel_advance_wave', phase, text, data);
}
function beadToDispatchContext(bead, complexity, agentName, coordinatorName, projectKey) {
    const descLines = bead.description.split('\n');
    const acceptance = descLines
        .filter((l) => /^\s*[-*]\s/.test(l))
        .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
        .filter(Boolean);
    return {
        beadId: bead.id,
        title: bead.title,
        description: bead.description,
        acceptance: acceptance.length > 0 ? acceptance : ['Complete the bead as described.'],
        complexity,
        relevantFiles: [],
        priorArtBeads: [],
        agentName,
        coordinatorName,
        projectKey,
    };
}
export async function runAdvanceWave(ctx, args) {
    const { exec, cwd, state, signal } = ctx;
    if (!Array.isArray(args.closedBeadIds) || args.closedBeadIds.length === 0) {
        return makeToolError('flywheel_advance_wave', state.phase, 'invalid_input', 'Error: closedBeadIds must be a non-empty array of bead IDs from the completed wave.', { hint: 'Pass closedBeadIds as a non-empty string array — the wave of beads to verify before advancing.' });
    }
    // Step 1: verify the completed wave
    const verifyResult = await runVerifyBeads(ctx, { cwd, beadIds: args.closedBeadIds });
    const verification = verifyResult.structuredContent?.data;
    if (!verification || verifyResult.isError) {
        return verifyResult;
    }
    if (verification.unclosedNoCommit.length > 0) {
        const stragglerIds = verification.unclosedNoCommit.map((s) => s.id);
        const outcome = {
            verification,
            nextWave: null,
            waveComplete: false,
        };
        const lines = [
            `Wave incomplete: ${verification.unclosedNoCommit.length} bead(s) still open without commits.`,
            ...stragglerIds.map((id) => `  - ${id}`),
            'Resolve these before advancing to the next wave.',
        ];
        return okResult(state.phase, lines.join('\n'), outcome);
    }
    // Step 2: get ready beads for the next wave
    let ready;
    try {
        ready = await readyBeads(exec, cwd);
    }
    catch (err) {
        const classified = classifyExecError(err);
        log.error('readyBeads threw', { err: String(err), code: classified.code });
        return makeToolError('flywheel_advance_wave', state.phase, classified.code, `Error reading next frontier: ${classified.cause}`, {
            retryable: classified.retryable,
            hint: 'Check that br CLI is installed and operational, then retry.',
        });
    }
    if (ready.length === 0) {
        const outcome = {
            verification,
            nextWave: null,
            waveComplete: true,
        };
        return okResult(state.phase, 'Wave verified. Queue drained — no more beads to dispatch.', outcome);
    }
    // Step 3: determine wave size from composition tier
    const composition = recommendComposition(ready.length);
    const maxWave = args.maxNextWave ?? composition.total;
    const waveCandidates = ready.slice(0, maxWave);
    // Step 4: classify complexity + allocate names
    const complexityMap = {};
    for (const bead of waveCandidates) {
        complexityMap[bead.id] = classifyBeadComplexity(bead).complexity;
    }
    const projectKey = path.basename(cwd);
    const coordinatorName = 'Coordinator';
    const agentNames = allocateAgentNames(waveCandidates.length, projectKey);
    // Step 5: render per-lane prompts round-robin
    const prompts = [];
    for (let i = 0; i < waveCandidates.length; i++) {
        const bead = waveCandidates[i];
        const lane = LANES[i % LANES.length];
        const dispatchCtx = beadToDispatchContext(bead, complexityMap[bead.id], agentNames[i], coordinatorName, projectKey);
        const adapted = LANE_ADAPTERS[lane](dispatchCtx);
        prompts.push({ beadId: bead.id, lane, prompt: adapted.prompt });
    }
    const outcome = {
        verification,
        nextWave: {
            beadIds: waveCandidates.map((b) => b.id),
            prompts,
            complexity: complexityMap,
        },
        waveComplete: true,
    };
    const lines = [
        `Wave verified (${verification.verified.length}/${args.closedBeadIds.length} closed).`,
        `Next wave: ${waveCandidates.length} bead(s) dispatched across ${LANES.length} lanes.`,
        ...waveCandidates.map((b, i) => `  - ${b.id} → ${LANES[i % LANES.length]} (${complexityMap[b.id]})`),
    ];
    return okResult(state.phase, lines.join('\n'), outcome);
}
//# sourceMappingURL=advance-wave.js.map