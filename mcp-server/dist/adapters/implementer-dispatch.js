import { allocateAgentNames } from './agent-names.js';
import { adaptPromptFor, detectCliCapabilities, splitBeadsByProvider, } from './model-diversity.js';
import { classifyBeadComplexity } from '../model-routing.js';
const NTM_LANE = {
    claude: 'cc',
    codex: 'cod',
    gemini: 'gmi',
    pi: 'pi',
};
function beadToDispatchContext(bead, complexity, agentName, coordinatorName, projectKey, potetoMode) {
    const acceptance = bead.description
        .split('\n')
        .filter((line) => /^\s*[-*]\s/u.test(line))
        .map((line) => line.replace(/^\s*[-*]\s*/u, '').trim())
        .filter(Boolean);
    return {
        beadId: bead.id,
        title: bead.title,
        description: bead.description,
        acceptance: acceptance.length > 0
            ? acceptance
            : ['Complete the bead as described.'],
        complexity,
        relevantFiles: [],
        priorArtBeads: [],
        agentName,
        coordinatorName,
        projectKey,
        ...(potetoMode !== undefined ? { potetoMode } : {}),
    };
}
export async function buildImplementerDispatch(args) {
    if (args.beads.length === 0) {
        return {
            lanes: [],
            prompts: [],
            complexity: {},
            warnings: [],
            degraded: false,
        };
    }
    const capabilities = args.capabilities ?? await detectCliCapabilities(args.exec, {
        cwd: args.cwd,
        signal: args.signal,
        probeScope: args.probeScope,
        verifyClaudeLogin: args.verifyClaudeLogin,
    });
    const plan = splitBeadsByProvider(args.beads.map((bead) => bead.id), capabilities);
    if (plan.lanes.length === 0) {
        return {
            lanes: [],
            prompts: [],
            complexity: {},
            warnings: plan.warnings,
            degraded: plan.degraded,
        };
    }
    const assignmentByBead = new Map();
    for (const lane of plan.lanes) {
        for (const beadId of lane.beadIds)
            assignmentByBead.set(beadId, lane.provider);
    }
    const projectKey = args.projectKey ?? args.cwd;
    const agentNames = allocateAgentNames(args.beads.length, projectKey);
    const complexity = {};
    const prompts = args.beads.map((bead, index) => {
        const provider = assignmentByBead.get(bead.id);
        if (!provider)
            throw new Error(`no implementation provider assigned to bead ${bead.id}`);
        const beadComplexity = classifyBeadComplexity(bead).complexity;
        complexity[bead.id] = beadComplexity;
        const agentName = agentNames[index];
        if (!agentName)
            throw new Error(`no implementation agent name allocated for bead ${bead.id}`);
        const context = beadToDispatchContext(bead, beadComplexity, agentName, args.coordinatorName, projectKey, args.potetoMode);
        const adapted = adaptPromptFor(provider, context);
        return {
            beadId: bead.id,
            lane: NTM_LANE[provider],
            agentName,
            prompt: `${adapted.prompt}${'\n'.repeat(adapted.trailingNewlines)}`,
        };
    });
    return {
        lanes: plan.lanes.map((lane) => ({
            lane: NTM_LANE[lane.provider],
            beadIds: lane.beadIds,
        })),
        prompts,
        complexity,
        warnings: plan.warnings,
        degraded: plan.degraded,
    };
}
//# sourceMappingURL=implementer-dispatch.js.map