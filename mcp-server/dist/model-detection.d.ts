/**
 * Model detection and selection for agent-flywheel planning.
 *
 * Agent-facing roles use stable model aliases. Provider model IDs remain here
 * only for capability reporting and CLI compatibility checks.
 */
export declare const AGENT_MODEL_ALIASES: {
    readonly opus: "opus";
    readonly sonnet: "sonnet";
    readonly haiku: "haiku";
    readonly fable: "fable";
};
export type AgentModelAlias = (typeof AGENT_MODEL_ALIASES)[keyof typeof AGENT_MODEL_ALIASES];
export declare const CURRENT_MODEL_IDS: {
    readonly opus: "anthropic/claude-opus-5-5";
    readonly sonnet: "anthropic/claude-sonnet-5-5";
    readonly haiku: "anthropic/claude-haiku-5-5";
    readonly fable: "anthropic/claude-fable-5-1";
};
/** The only Gemini model the flywheel runs, through Pi on the Vercel AI Gateway. */
export declare const CURRENT_GEMINI_MODEL_ID = "gemini-4-argon";
export declare const PI_GATEWAY_PROVIDER = "vercel-ai-gateway";
/** The swarm's Gemini lane is Pi running this model on the gateway; no other Gemini model runs anywhere. */
export declare const GEMINI_GATEWAY_ID = "google/gemini-4-argon";
export declare const GEMINI_LANE_MODEL = "vercel-ai-gateway/google/gemini-4-argon";
export declare const DEEP_PLAN_MODELS: {
    readonly correctness: "opus";
    readonly ergonomics: "sonnet";
    readonly synthesis: "opus";
};
export declare const REFINEMENT_MODELS: readonly AgentModelAlias[];
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
export declare const SWARM_MODELS: {
    readonly opus: "anthropic/claude-opus-5-5";
    readonly codex: "codex";
    readonly haiku: "anthropic/claude-haiku-5-5";
};
/** Models used by cost-aware model routing tiers. */
export declare const MODEL_ROUTING_TIERS: {
    readonly simple: {
        readonly implementation: "anthropic/claude-haiku-5-5";
        readonly review: "anthropic/claude-sonnet-5-5";
    };
    readonly medium: {
        readonly implementation: "anthropic/claude-opus-5-5";
        readonly review: "anthropic/claude-sonnet-5-5";
    };
    readonly complex: {
        readonly implementation: "anthropic/claude-opus-5-5";
        readonly review: "anthropic/claude-opus-5-5";
    };
};
/**
 * Detect available model providers from a list of model IDs.
 * In MCP context, the caller can pass available model IDs from the runtime.
 */
export declare function detectAvailableModels(availableModelIds?: string[]): DetectedModels;
export declare function getRefinementModel(round: number): AgentModelAlias;
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
export declare function computeDispatchRatio(ratio: string, agyRoute: {
    agyReady: boolean;
    ntmAgy: boolean;
}): DispatchRatio;
//# sourceMappingURL=model-detection.d.ts.map