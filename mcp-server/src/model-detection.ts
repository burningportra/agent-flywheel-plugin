/**
 * Model detection and selection for agent-flywheel planning.
 *
 * Agent-facing roles use stable model aliases. Provider model IDs remain here
 * only for capability reporting and CLI compatibility checks.
 */

export const AGENT_MODEL_ALIASES = {
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
  fable: 'fable',
} as const;

export type AgentModelAlias = (typeof AGENT_MODEL_ALIASES)[keyof typeof AGENT_MODEL_ALIASES];

export const CURRENT_MODEL_IDS = {
  opus: 'anthropic/claude-opus-5-5',
  sonnet: 'anthropic/claude-sonnet-5-5',
  haiku: 'anthropic/claude-haiku-5-5',
  fable: 'anthropic/claude-fable-5-1',
} as const;

/** The only Gemini model the flywheel runs, through Pi on the Vercel AI Gateway. */
export const CURRENT_GEMINI_MODEL_ID = 'gemini-4-argon';

export const DEEP_PLAN_MODELS = {
  correctness: AGENT_MODEL_ALIASES.opus,
  ergonomics: AGENT_MODEL_ALIASES.sonnet,
  synthesis: AGENT_MODEL_ALIASES.opus,
} as const;

export const REFINEMENT_MODELS: readonly AgentModelAlias[] = Object.freeze([
  AGENT_MODEL_ALIASES.opus,
  AGENT_MODEL_ALIASES.sonnet,
  AGENT_MODEL_ALIASES.fable,
  AGENT_MODEL_ALIASES.sonnet,
]);

export interface ModelProvider {
  name: string;
  prefix: string;
  available: boolean;
  models: string[];
}

export interface DetectedModels {
  providers: ModelProvider[];
  hasAnthropic: boolean;
  hasOpenAI: boolean;
  hasGoogle: boolean;
  hasOpenCode: boolean;
  hasOpenRouter: boolean;
  hasGroq: boolean;
  /** Best available model for correctness planning */
  correctnessModel: string;
  /** Best available model for robustness planning */
  robustnessModel: string;
  /** Best available model for ergonomics planning */
  ergonomicsModel: string;
  /** Best available model for synthesis */
  synthesisModel: string;
  /** Models for refinement rotation */
  refinementModels: AgentModelAlias[];
  /** Optional 4th planning perspective using Google/Gemini model; null if unavailable */
  freshPerspectiveModel: string | null;
}

/** Models used by the swarm launcher. */
export const SWARM_MODELS = {
  opus: CURRENT_MODEL_IDS.opus,
  codex: "codex",
  haiku: CURRENT_MODEL_IDS.haiku,
} as const;

/** Models used by cost-aware model routing tiers. */
export const MODEL_ROUTING_TIERS = {
  simple: {
    implementation: CURRENT_MODEL_IDS.haiku,
    review: CURRENT_MODEL_IDS.sonnet,
  },
  medium: {
    implementation: CURRENT_MODEL_IDS.opus,
    review: CURRENT_MODEL_IDS.sonnet,
  },
  complex: {
    implementation: CURRENT_MODEL_IDS.opus,
    review: CURRENT_MODEL_IDS.opus,
  },
} as const;

/**
 * Model preferences by provider, ordered by capability.
 * These are the "best" models from each provider for planning tasks.
 */
const PROVIDER_BEST_MODELS: Record<string, string[]> = {
  anthropic: [
    CURRENT_MODEL_IDS.opus.slice('anthropic/'.length),
    CURRENT_MODEL_IDS.fable.slice('anthropic/'.length),
    CURRENT_MODEL_IDS.sonnet.slice('anthropic/'.length),
    CURRENT_MODEL_IDS.haiku.slice('anthropic/'.length),
  ],
  "openai-codex": [
    "gpt-5.4",
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5.1-codex",
    "gpt-5-codex",
  ],
  openai: [
    "gpt-5.4",
    "gpt-5.1",
    "gpt-4.1",
    "gpt-4o",
  ],
  opencode: [
    "gpt-5.4",
    "gpt-5.3-codex",
    CURRENT_MODEL_IDS.opus.slice('anthropic/'.length),
    CURRENT_MODEL_IDS.sonnet.slice('anthropic/'.length),
  ],
  openrouter: [
    CURRENT_MODEL_IDS.opus,
    CURRENT_MODEL_IDS.sonnet,
  ],
  google: [CURRENT_GEMINI_MODEL_ID],
  "google-antigravity": [CURRENT_GEMINI_MODEL_ID],
  groq: [], // Groq models are typically smaller/faster, not for planning
};

/**
 * Select the best available model from a list of preferred providers.
 */
function selectBestModel(
  providerMap: Map<string, Set<string>>,
  preferredProviders: string[],
  providerBestModels: Record<string, string[]>
): string | null {
  for (const provider of preferredProviders) {
    const models = providerMap.get(provider);
    if (!models) continue;

    const bestForProvider = providerBestModels[provider] ?? [];
    for (const preferred of bestForProvider) {
      if (models.has(preferred)) {
        return `${provider}/${preferred}`;
      }
    }
  }
  return null;
}

/**
 * Detect available model providers from a list of model IDs.
 * In MCP context, the caller can pass available model IDs from the runtime.
 */
export function detectAvailableModels(availableModelIds?: string[]): DetectedModels {
  // Group models by provider
  const providerMap = new Map<string, Set<string>>();

  for (const modelId of (availableModelIds ?? [])) {
    const slashIdx = modelId.indexOf("/");
    if (slashIdx < 0) continue;
    const provider = modelId.slice(0, slashIdx);
    const model = modelId.slice(slashIdx + 1);
    if (!providerMap.has(provider)) {
      providerMap.set(provider, new Set());
    }
    providerMap.get(provider)!.add(model);
  }

  // Detect providers
  const hasAnthropic = providerMap.has("anthropic");
  const hasOpenAI = providerMap.has("openai") || providerMap.has("openai-codex");
  const hasGoogle = providerMap.has("google-antigravity") || providerMap.has("google");
  const hasOpenCode = providerMap.has("opencode");
  const hasOpenRouter = providerMap.has("openrouter");
  const hasGroq = providerMap.has("groq");

  // Build provider list
  const providers: ModelProvider[] = [];
  for (const [name, models] of providerMap) {
    providers.push({
      name,
      prefix: name,
      available: true,
      models: [...models],
    });
  }

  // Select best models for each planning role
  const correctnessModel = selectBestModel(providerMap, ["openai-codex", "opencode", "openai"], PROVIDER_BEST_MODELS)
    ?? selectBestModel(providerMap, ["anthropic"], PROVIDER_BEST_MODELS)
    ?? CURRENT_MODEL_IDS.opus;

  const robustnessModel = selectBestModel(providerMap, ["anthropic"], PROVIDER_BEST_MODELS)
    ?? CURRENT_MODEL_IDS.opus;

  // Ergonomics prefers openai-codex (Codex 5.4) for a different architectural lens
  const ergonomicsModel = selectBestModel(providerMap, ["openai-codex", "opencode"], PROVIDER_BEST_MODELS)
    ?? selectBestModel(providerMap, ["anthropic"], PROVIDER_BEST_MODELS)
    ?? CURRENT_MODEL_IDS.sonnet;

  const synthesisModel = selectBestModel(providerMap, ["openai-codex", "opencode", "openai"], PROVIDER_BEST_MODELS)
    ?? selectBestModel(providerMap, ["anthropic"], PROVIDER_BEST_MODELS)
    ?? CURRENT_MODEL_IDS.opus;

  // Fresh perspective uses Google/Gemini when available; null otherwise (4th optional planner)
  const freshPerspectiveModel = selectBestModel(
    providerMap,
    ["google-antigravity", "google"],
    PROVIDER_BEST_MODELS,
  );

  const refinementModels = [...REFINEMENT_MODELS];

  return {
    providers,
    hasAnthropic,
    hasOpenAI,
    hasGoogle,
    hasOpenCode,
    hasOpenRouter,
    hasGroq,
    correctnessModel,
    robustnessModel,
    ergonomicsModel,
    synthesisModel,
    refinementModels,
    freshPerspectiveModel,
  };
}

export function getRefinementModel(round: number): AgentModelAlias {
  const index = ((round % REFINEMENT_MODELS.length) + REFINEMENT_MODELS.length)
    % REFINEMENT_MODELS.length;
  return REFINEMENT_MODELS[index] ?? AGENT_MODEL_ALIASES.opus;
}

/**
 * Format detected models for display.
 */
function formatDetectedModels(detected: DetectedModels): string {
  const lines: string[] = [];

  lines.push("## Detected Model Providers");
  lines.push("");

  const providerStatus: [string, boolean][] = [
    ["Anthropic", detected.hasAnthropic],
    ["OpenAI", detected.hasOpenAI],
    ["Google", detected.hasGoogle],
    ["OpenCode", detected.hasOpenCode],
    ["OpenRouter", detected.hasOpenRouter],
  ];

  for (const [name, available] of providerStatus) {
    const icon = available ? "[ok]" : "[--]";
    lines.push(`${icon} ${name}`);
  }

  lines.push("");
  lines.push("## Planning Model Selection");
  lines.push("");
  lines.push(`- **Correctness:** ${detected.correctnessModel}`);
  lines.push(`- **Robustness:** ${detected.robustnessModel}`);
  lines.push(`- **Ergonomics:** ${detected.ergonomicsModel}`);
  lines.push(`- **Synthesis:** ${detected.synthesisModel}`);
  if (detected.freshPerspectiveModel) {
    lines.push(`- **Fresh Perspective (Gemini):** ${detected.freshPerspectiveModel}`);
  }
  lines.push("");
  lines.push("**Refinement Rotation:**");
  for (const model of detected.refinementModels) {
    lines.push(`- ${model}`);
  }

  return lines.join("\n");
}

/** Claude:Pi:Gemini bead counts, the shape `DispatchPlan.ratio` encodes as "2:2:2". */
export interface FamilyRatio {
  claude: number;
  pi: number;
  gemini: number;
}

/** Pane counts per spawn lane. The Gemini seat runs on `gmi` (Pi on the gateway) or on `agy`. */
export interface RatioByLane {
  cc: number;
  pi: number;
  gmi: number;
  agy: number;
}

export interface DispatchRatio {
  ratio: FamilyRatio;
  ratioByLane: RatioByLane;
}

/**
 * Splits a `DispatchPlan.ratio` string into family counts and spawn lanes.
 * The Gemini seat moves to `agy` only when the agy CLI works and this ntm
 * accepts `--agy`; otherwise it stays on the `gmi` lane.
 */
export function computeDispatchRatio(
  ratio: string,
  agyRoute: { agyReady: boolean; ntmAgy: boolean },
): DispatchRatio {
  const [claude = 0, pi = 0, gemini = 0] = ratio.split(':').map((part) => {
    const n = Number(part);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  });
  const useAgy = agyRoute.agyReady && agyRoute.ntmAgy;
  return {
    ratio: { claude, pi, gemini },
    ratioByLane: { cc: claude, pi, gmi: useAgy ? 0 : gemini, agy: useAgy ? gemini : 0 },
  };
}
