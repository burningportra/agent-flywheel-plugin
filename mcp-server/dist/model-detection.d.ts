/**
 * Model detection and selection for agent-flywheel planning.
 *
 * Agent-facing roles use stable model aliases. Provider model IDs remain here
 * only for capability reporting and CLI compatibility checks.
 */
import type { ExecFn } from './exec.js';
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
export declare const CURRENT_GEMINI_MODEL_ID = "gemini-3.1-flash-preview";
export declare const DEEP_PLAN_MODELS: {
    readonly correctness: "opus";
    readonly ergonomics: "sonnet";
    readonly synthesis: "opus";
};
export declare const REFINEMENT_MODELS: readonly AgentModelAlias[];
export interface PiPlannerDispatch {
    runner: 'pi-pane';
    provider: 'pi';
    piModel: string;
}
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
export interface DeepPlanModelSelection {
    correctness: AgentModelAlias;
    ergonomics: AgentModelAlias;
    synthesis: AgentModelAlias;
    freshPerspective: PiPlannerDispatch | null;
}
export declare function getDeepPlanModels(capabilities?: {
    piAvailable?: boolean;
    piModel?: string;
}): DeepPlanModelSelection;
export declare function getRefinementModel(round: number): AgentModelAlias;
/** Probes `which pi`; the Pi pane reports provider auth and model errors when it starts. */
export declare function isPiPlannerCliAvailable(exec: ExecFn, options: {
    cwd: string;
    signal?: AbortSignal;
    timeout?: number;
}): Promise<boolean>;
export declare const GEMINI_MODEL_ALLOWLIST: readonly string[];
export declare function isGeminiModelAllowed(model: string): boolean;
/**
 * Extract the first `gemini-…` model identifier from a CLI output blob
 * (e.g. `gemini --version` stdout). Returns null when no match is found.
 * The match is case-insensitive but the returned identifier is lowercased
 * so callers can compare it to {@link GEMINI_MODEL_ALLOWLIST} directly.
 */
export declare function parseGeminiModelFromOutput(output: string): string | null;
//# sourceMappingURL=model-detection.d.ts.map