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
 * Detect available model providers from a list of model IDs.
 * In MCP context, the caller can pass available model IDs from the runtime.
 */
export declare function detectAvailableModels(availableModelIds?: string[]): DetectedModels;
/**
 * Get deep planning models based on detected availability.
 * Falls back to hardcoded defaults if detection fails.
 */
export declare function getDeepPlanModels(availableModelIds?: string[]): {
    correctness: string;
    robustness: string;
    ergonomics: string;
    synthesis: string;
    freshPerspective: string | null;
};
/**
 * Get refinement model for a given round, using detected models.
 */
export declare function getRefinementModel(round: number, availableModelIds?: string[]): string;
/**
 * Format detected models for display.
 */
export declare function formatDetectedModels(detected: DetectedModels): string;
//# sourceMappingURL=model-detection.d.ts.map