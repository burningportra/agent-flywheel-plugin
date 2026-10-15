export interface SwarmComposition {
    /** Total agent count. */
    total: number;
    /** Recommended model distribution. */
    models: Array<{
        model: string;
        count: number;
    }>;
    /** Reasoning for the recommendation. */
    rationale: string;
}
/** Recommend agent composition based on open bead count. */
export declare function recommendComposition(openBeadCount: number): SwarmComposition;
//# sourceMappingURL=swarm.d.ts.map