/**
 * Model detection and selection for agent-flywheel planning.
 *
 * In the MCP context, we don't have access to a model registry like the pi
 * extension context provides. Instead, we use hardcoded fallback model lists
 * and rely on the caller to pass detected models if available.
 */

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
  refinementModels: string[];
  /** Optional 4th planning perspective using Google/Gemini model; null if unavailable */
  freshPerspectiveModel: string | null;
}

/**
 * Model preferences by provider, ordered by capability.
 * These are the "best" models from each provider for planning tasks.
 */
const PROVIDER_BEST_MODELS: Record<string, string[]> = {
  anthropic: [
    "claude-opus-4-6",
    "claude-opus-4-5",
    "claude-opus-4-1",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
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
    "claude-opus-4-6",
    "claude-sonnet-4-6",
  ],
  openrouter: [
    "anthropic/claude-opus-4-6",
    "anthropic/claude-sonnet-4-6",
  ],
  groq: [], // Groq models are typically smaller/faster, not for planning
};

/**
 * Build a rotation of models from different providers for refinement rounds.
 * Using different providers helps avoid anchoring bias.
 */
function buildRefinementRotation(providerMap: Map<string, Set<string>>): string[] {
  const rotation: string[] = [];

  // Prefer Anthropic for reasoning
  const anthropicBest = selectBestModel(providerMap, ["anthropic"], PROVIDER_BEST_MODELS);
  if (anthropicBest) rotation.push(anthropicBest);

  // Add OpenAI/Codex for different perspective
  const openaiBest = selectBestModel(providerMap, ["openai-codex", "opencode", "openai"], PROVIDER_BEST_MODELS);
  if (openaiBest && openaiBest !== rotation[0]) rotation.push(openaiBest);

  // Add a third Anthropic model for third perspective (replaces Google in MCP context)
  const thirdModel = "anthropic/claude-sonnet-4-6";
  if (!rotation.includes(thirdModel)) rotation.push(thirdModel);

  // Fallback if we don't have enough diversity
  if (rotation.length === 0) {
    rotation.push("anthropic/claude-opus-4-6");
  }
  if (rotation.length === 1) {
    rotation.push("codex");
  }
  if (rotation.length === 2) {
    rotation.push("anthropic/claude-sonnet-4-6");
  }

  return rotation;
}

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
    ?? "anthropic/claude-opus-4-6";

  const robustnessModel = selectBestModel(providerMap, ["anthropic"], PROVIDER_BEST_MODELS)
    ?? "anthropic/claude-opus-4-6";

  // Ergonomics prefers openai-codex (Codex 5.4) for a different architectural lens
  const ergonomicsModel = selectBestModel(providerMap, ["openai-codex", "opencode"], PROVIDER_BEST_MODELS)
    ?? selectBestModel(providerMap, ["anthropic"], PROVIDER_BEST_MODELS)
    ?? "anthropic/claude-sonnet-4-6";

  const synthesisModel = selectBestModel(providerMap, ["openai-codex", "opencode", "openai"], PROVIDER_BEST_MODELS)
    ?? selectBestModel(providerMap, ["anthropic"], PROVIDER_BEST_MODELS)
    ?? "anthropic/claude-opus-4-6";

  // Fresh perspective uses Google/Gemini when available; null otherwise (4th optional planner)
  const googleBestModel = selectBestModel(providerMap, ["google-antigravity", "google"], PROVIDER_BEST_MODELS);
  const freshPerspectiveModel: string | null = googleBestModel
    ? `${providerMap.has("google-antigravity") ? "google-antigravity" : "google"}/${googleBestModel}`
    : null;

  // Build refinement rotation from available providers
  const refinementModels = buildRefinementRotation(providerMap);

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

/**
 * Get deep planning models based on detected availability.
 * Falls back to hardcoded defaults if detection fails.
 */
export function getDeepPlanModels(availableModelIds?: string[]): {
  correctness: string;
  robustness: string;
  ergonomics: string;
  synthesis: string;
  freshPerspective: string | null;
} {
  try {
    const detected = detectAvailableModels(availableModelIds);
    return {
      correctness: detected.correctnessModel,
      robustness: detected.robustnessModel,
      ergonomics: detected.ergonomicsModel,
      synthesis: detected.synthesisModel,
      freshPerspective: detected.freshPerspectiveModel,
    };
  } catch {
    // Fallback to hardcoded defaults
    return {
      correctness: "anthropic/claude-opus-4-6",
      robustness: "anthropic/claude-opus-4-6",
      ergonomics: "anthropic/claude-sonnet-4-6",
      synthesis: "anthropic/claude-opus-4-6",
      freshPerspective: null,
    };
  }
}

/**
 * Get refinement model for a given round, using detected models.
 */
export function getRefinementModel(round: number, availableModelIds?: string[]): string {
  try {
    const detected = detectAvailableModels(availableModelIds);
    const models = detected.refinementModels;
    return models[round % models.length] ?? "anthropic/claude-opus-4-6";
  } catch {
    // Fallback to hardcoded rotation
    const fallbacks = [
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-4-6",
    ];
    return fallbacks[round % fallbacks.length];
  }
}

/**
 * Format detected models for display.
 */
export function formatDetectedModels(detected: DetectedModels): string {
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
