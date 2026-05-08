export interface ComplianceScoreRecord {
    beadId: string;
    score: number;
    threshold: number;
    passed: boolean;
    rubric: Record<string, string>;
    passUtc: string;
    sessionId: string | null;
    gitHead: string;
}
export declare function storeComplianceScore(cwd: string, record: ComplianceScoreRecord): void;
//# sourceMappingURL=cass-helpers.d.ts.map