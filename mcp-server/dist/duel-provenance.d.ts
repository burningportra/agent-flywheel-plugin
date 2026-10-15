import type { FlywheelState } from './types.js';
export type DuelAgentScore = number | 'self' | 'n/a' | readonly number[];
export interface DuelDecisionProvenance {
    title: string;
    agentScores?: Record<string, DuelAgentScore>;
    survivingCritique?: string;
    steelman?: string | null;
    contested?: boolean;
}
export interface ParsedDuelReport {
    mode?: string;
    runAt?: string;
    decisions: DuelDecisionProvenance[];
}
type DuelProvenanceState = Pick<FlywheelState, 'planSource' | 'candidateIdeas' | 'selectedGoal'>;
interface DuelReportArtifact {
    path: string;
    content: string;
}
export declare function parseDuelReport(markdown: string): ParsedDuelReport;
export declare function resolveDuelProvenanceInstructions(state: DuelProvenanceState, reportArtifact?: DuelReportArtifact): string | undefined;
export {};
//# sourceMappingURL=duel-provenance.d.ts.map