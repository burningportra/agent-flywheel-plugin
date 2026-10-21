import { allocateAgentNames } from './agent-names.js';
import {
  adaptPromptFor,
  detectCliCapabilities,
  splitBeadsByProvider,
  type CapabilitiesMap,
  type ModelProvider,
} from './model-diversity.js';
import { classifyBeadComplexity, type BeadComplexity } from '../model-routing.js';
import type { ExecFn } from '../exec.js';
import type { Bead } from '../types.js';
import type { BeadDispatchContext } from './codex-prompt.js';

export type NtmImplementationLane = 'cc' | 'cod' | 'gmi' | 'pi';

export interface ImplementerLane {
  readonly lane: NtmImplementationLane;
  readonly beadIds: readonly string[];
}

export interface ImplementerPrompt {
  readonly beadId: string;
  readonly lane: NtmImplementationLane;
  readonly agentName: string;
  readonly prompt: string;
}

export interface ImplementerDispatch {
  readonly lanes: readonly ImplementerLane[];
  readonly prompts: readonly ImplementerPrompt[];
  readonly complexity: Readonly<Record<string, BeadComplexity>>;
  readonly warnings: readonly string[];
  readonly degraded: boolean;
}

export interface BuildImplementerDispatchArgs {
  readonly exec: ExecFn;
  readonly cwd: string;
  readonly beads: readonly Bead[];
  readonly coordinatorName: string;
  readonly signal?: AbortSignal;
  readonly capabilities?: CapabilitiesMap;
  /** Agent Mail project key; a swarm host's clone when the panes run there. Defaults to `cwd`. */
  readonly projectKey?: string;
  readonly probeScope?: string;
  readonly verifyClaudeLogin?: boolean;
  readonly potetoMode?: boolean;
}

const NTM_LANE = {
  claude: 'cc',
  codex: 'cod',
  gemini: 'gmi',
  pi: 'pi',
} as const satisfies Record<ModelProvider, NtmImplementationLane>;

function beadToDispatchContext(
  bead: Bead,
  complexity: BeadComplexity,
  agentName: string,
  coordinatorName: string,
  projectKey: string,
  potetoMode?: boolean,
): BeadDispatchContext {
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

export async function buildImplementerDispatch(
  args: BuildImplementerDispatchArgs,
): Promise<ImplementerDispatch> {
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
  const plan = splitBeadsByProvider(
    args.beads.map((bead) => bead.id),
    capabilities,
  );
  if (plan.lanes.length === 0) {
    return {
      lanes: [],
      prompts: [],
      complexity: {},
      warnings: plan.warnings,
      degraded: plan.degraded,
    };
  }

  const assignmentByBead = new Map<string, ModelProvider>();
  for (const lane of plan.lanes) {
    for (const beadId of lane.beadIds) assignmentByBead.set(beadId, lane.provider);
  }

  const projectKey = args.projectKey ?? args.cwd;
  const agentNames = allocateAgentNames(args.beads.length, projectKey);
  const complexity: Record<string, BeadComplexity> = {};
  const prompts: ImplementerPrompt[] = args.beads.map((bead, index) => {
    const provider = assignmentByBead.get(bead.id);
    if (!provider) throw new Error(`no implementation provider assigned to bead ${bead.id}`);

    const beadComplexity = classifyBeadComplexity(bead).complexity;
    complexity[bead.id] = beadComplexity;
    const agentName = agentNames[index];
    if (!agentName) throw new Error(`no implementation agent name allocated for bead ${bead.id}`);

    const context = beadToDispatchContext(
      bead,
      beadComplexity,
      agentName,
      args.coordinatorName,
      projectKey,
      args.potetoMode,
    );
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
