import type { Rule, RuleContext } from "../types.js";
/**
 * PANE001 — NTM pane-priority drift between AGENTS.md canonical rule and
 * skill bodies (`skills/start/SKILL.md`, `skills/start/_*.md`).
 *
 * AGENTS.md's "## NTM pane priority" section names the canonical pane ratio
 * (cc:pi:gem 1:1:1 as of v3.21.0) and substitution ladder
 * (gmi→pi→cod→cc). When a skill file embeds an `ntm spawn` or
 * `swarm-spawn.js` invocation with a non-canonical lane mix and no nearby
 * override marker, the rule fires an `error`-severity PANE001 finding. ntm
 * has no Pi agent type, so `--pi=N` on a plain `ntm spawn` line is always a
 * finding: Pi lanes go through `swarm-spawn.js`.
 *
 * Override markers (recognised within ±6 lines of the offending line) let
 * a skill intentionally diverge — e.g. `_deslop.md`'s "5-Cod swarm —
 * codex-heavy mode is the deslop signature and an explicit override of the
 * v3.17.0 canonical cc:cod:gem 1:1:1" pattern. Markers:
 *
 *   - `explicit override`
 *   - `intentional override`
 *   - `signature override`
 *   - `override of the canonical`
 *   - `override of the v3.17`
 *   - `signature and an explicit override`
 *
 * Cross-file rule: the `Document` argument is the parsed SKILL.md; the rule
 * walks `<repoRoot>/skills/start/_*.md` itself to cover the sub-skills. The
 * canonical rule is parsed from `<repoRoot>/AGENTS.md`.
 *
 * Severity: `error` after the v3.17 soft-warn rollout window.
 *
 * Bead: claude-orchestrator-34ok.
 */
export interface Pane001Context extends RuleContext {
    repoRoot?: string;
    /** Override AGENTS.md path (tests inject a fixture). */
    agentsMdPath?: string;
    /** Override skills/start/ scan root (tests inject a fixture). */
    skillsRoot?: string;
    /** Override the parsed canonical (tests inject for fixture-based behaviour). */
    canonical?: CanonicalRule;
}
export type Lane = "cc" | "cod" | "gmi" | "pi";
export interface CanonicalRule {
    /** Required lanes, cc first — order-sensitive when rendering. */
    lanes: Lane[];
    /** Ratio expressed as integers, indexed by `lanes`. e.g. [1,1,1] for cc:pi:gem 1:1:1. */
    ratio: number[];
    /** Substitution ladder; first entry is the lane that gets reassigned when missing. */
    ladder: Lane[];
    /** Pinned doc version that introduced the rule (e.g. "v3.21.0"). */
    version: string | null;
}
/**
 * Parse AGENTS.md's "## NTM pane priority" section for the canonical rule.
 *
 * Looks for a three-lane ratio whose first lane is cc (e.g. "cc:pi:gem
 * 1:1:1"; "gem" is the prose form of the "gmi" flag) and a substitution
 * ladder (e.g. "gmi→pi→cod→cc" or "gmi -> pi -> cod -> cc"). Returns null
 * when the ratio is missing — the rule is then advisory-only (no findings
 * emitted) rather than firing against an unparseable AGENTS.md. A missing
 * ladder falls back to canonical peers first, then the remaining lanes,
 * then cc.
 *
 * Exported for test access only.
 */
export declare function parseCanonicalFromAgentsMd(content: string): CanonicalRule | null;
/**
 * Extract `--cc=N --cod=M --gmi=K --pi=L` style ratios from a single line.
 * Returns a map from lane name to integer count. Empty map if no flags found.
 *
 * Note: `--gem=N` is treated as `--gmi=N` (deprecated synonym).
 */
export declare function extractLaneCounts(line: string): Record<string, number>;
/**
 * Validate an extracted lane-count map against the canonical ratio.
 *
 * Rules:
 *   - The canonical lanes' proportion must match the canonical ratio after
 *     integer scaling. A canonical peer lane at 0 is a dropped lane, which
 *     the substitution ladder permits.
 *   - A lane outside the canonical set (cod under cc:pi:gem) is a fallback.
 *     It may appear only when at least one canonical peer is 0, because the
 *     ladder brings it in only to cover a dropped lane.
 *   - When every canonical peer is 0 the spawn is a cc-only or fallback-only
 *     degraded shape, which the rule leaves to the override markers.
 *
 * Returns `null` if valid; otherwise an explanation string.
 */
export declare function validateLaneCounts(counts: Record<string, number>, canonical: CanonicalRule): string | null;
/**
 * Pull the spawn-command substring from a line. For markdown lines that
 * embed the command in inline-code (backticks), return only what's inside
 * the first backtick-delimited region containing `ntm spawn`. For plain
 * code-fence lines (no backticks), return the whole line. Returns `null`
 * when no `ntm spawn` is present.
 *
 * This isolates the actual spawn flags from documentation examples that
 * sometimes follow on the same line (e.g. a substitution-ladder row that
 * shows `--cc=2 --cod=4` as the gmi-missing fallback alongside the primary
 * `--cc=2 --cod=2 --gmi=2` command).
 *
 * Exported for test access.
 */
export declare function extractSpawnSubstring(line: string): string | null;
export declare const pane001: Rule;
export default pane001;
//# sourceMappingURL=pane001.d.ts.map