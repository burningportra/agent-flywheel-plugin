export function createInitialState() {
    return {
        phase: "idle",
        constraints: [],
        retryCount: 0,
        maxRetries: 3,
        maxReviewPasses: 2,
        iterationRound: 0,
        currentGateIndex: 0,
        polishRound: 0,
        polishChanges: [],
        polishConverged: false,
    };
}
//# sourceMappingURL=types.js.map