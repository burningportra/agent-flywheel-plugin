import type { Rule, RuleContext } from "../types.js";
/**
 * TONE001 — per-file count of all-caps directive tokens and quota phrases in
 * flywheel skill prose. The rule is a ratchet: a count equal to or lower than
 * the committed baseline passes; a count that rises above the baseline fails.
 * The point is to shrink the shouty surface over time without rewriting every
 * file in one sweep. See docs/skill-style.md for the written rationale.
 *
 * Scope:
 * - Prose only. Everything inside fenced code blocks is ignored, and so is any
 *   section whose header is "Universal Rule 1" (lint and tests depend on the
 *   verbatim phrasing of that rule).
 * - The baseline file (default `mcp-server/.lintskill-tone-baseline.json`) is
 *   keyed by repo-relative POSIX path. A missing entry means baseline=0 — new
 *   skill files start with no shouting budget.
 */
export interface Tone001Context extends RuleContext {
    repoRoot?: string;
    /** Override the baseline path (tests inject a fixture). */
    toneBaselinePath?: string;
    /** Override the loaded baseline directly (tests inject a map). */
    toneBaseline?: Record<string, number>;
}
export interface ToneBaselineFile {
    schemaVersion: 1;
    generated: string;
    /** Per-file maximum count; keyed by repo-relative POSIX path. */
    counts: Record<string, number>;
}
export declare function countToneTokens(prose: string): number;
export declare const tone001: Rule;
//# sourceMappingURL=tone001.d.ts.map