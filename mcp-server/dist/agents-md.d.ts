export interface AgentsMdHealth {
    /** Overall health score 0-100. */
    score: number;
    /** Whether the 8 core rules are present. */
    hasCoreRules: boolean;
    /** Number of core rules detected (0-8). */
    coreRuleCount: number;
    /** Whether Agent Mail / coordination docs are present. */
    hasCoordination: boolean;
    /** Whether CASS memory section is present. */
    hasMemory: boolean;
    /** Whether Beads CLI (br) docs are present. */
    hasBr: boolean;
    /** Whether Beads Viewer (bv) docs are present. */
    hasBv: boolean;
    /** Missing sections that should be added. */
    missing: string[];
}
/** Clear the scoreAgentsMd cache (call after modifying AGENTS.md). */
export declare function resetAgentsMdScoreCache(): void;
/**
 * Score an AGENTS.md file on completeness.
 * Returns a health assessment with 0-100 score and list of missing sections.
 * Results are memoized per cwd for the session.
 */
export declare function scoreAgentsMd(cwd: string): AgentsMdHealth;
/**
 * Ensure the Core Rules section is present in AGENTS.md.
 * If AGENTS.md doesn't exist, creates it with header + core rules.
 * If it exists but lacks core rules, appends them.
 * Idempotent — safe to call multiple times.
 */
export declare function ensureCoreRules(cwd: string): Promise<void>;
export declare function ensureAgentMailSection(cwd: string): Promise<void>;
//# sourceMappingURL=agents-md.d.ts.map