import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import type { Document, Finding, Rule, RuleContext } from "../types.js";

/**
 * PANE001 — NTM pane-priority drift between AGENTS.md canonical rule and
 * skill bodies (`skills/start/SKILL.md`, `skills/start/_*.md`).
 *
 * AGENTS.md's "## NTM pane priority" section names the canonical pane ratio
 * (cc:cod:gem 1:1:1 as of v3.17.0) and substitution ladder
 * (gmi→cod→pi→cc). When a skill file embeds an `ntm spawn` invocation with
 * a non-canonical lane mix and no nearby "override" marker, the rule fires
 * an `error`-severity PANE001 finding.
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

export interface CanonicalRule {
  /** Required lanes — order-sensitive when rendering. */
  lanes: Array<"cc" | "cod" | "gmi" | "pi">;
  /** Ratio expressed as integers, indexed by `lanes`. e.g. [1,1,1] for cc:cod:gem 1:1:1. */
  ratio: number[];
  /** Substitution ladder; first entry is the lane that gets reassigned when missing. */
  ladder: Array<"cc" | "cod" | "gmi" | "pi">;
  /** Pinned doc version that introduced the rule (e.g. "v3.17.0"). */
  version: string | null;
}

const OVERRIDE_MARKERS: ReadonlyArray<RegExp> = [
  /explicit override/i,
  /intentional override/i,
  /signature override/i,
  /override of the canonical/i,
  /override of the v3\.\d+/i,
  /signature and an explicit override/i,
];

/**
 * Whole-file fallback markers — STRICTER than `OVERRIDE_MARKERS` on purpose.
 *
 * The proximity check (±6 lines) accepts loose prose like "explicit override"
 * because the override declaration is right next to the spawn it justifies.
 * The whole-file fallback applies file-wide, so the same loose phrasing
 * false-negatives when "override" appears in unrelated discussion elsewhere
 * (e.g. `_implement.md`'s "all three peers unavailable → cc-only floor
 * (explicit override)" comment, which discusses a different override case).
 *
 * Files that need a file-wide override (spawn declaration too far from any
 * prose to satisfy ±6) must opt in explicitly with an unambiguous marker:
 *
 *   - HTML comment:  `<!-- pane001-override -->` (or `<!-- pane001-override:reason -->`)
 *   - Inline token:  `PANE001-OVERRIDE:`
 *
 * Both are deliberately project-specific tokens that won't appear in prose
 * by accident.
 */
const WHOLE_FILE_OVERRIDE_MARKERS: ReadonlyArray<RegExp> = [
  /<!--\s*pane001-override\b/i,
  /\bPANE001-OVERRIDE:/,
];

/** Recognised NTM lane flags. `--gem=` is the deprecated synonym for `--gmi=`. */
const LANE_FLAG_PATTERN = /--(cc|cod|gmi|gem|pi)=(\d+)/g;
const OVERRIDE_PROXIMITY_LINES = 6;

/**
 * Parse AGENTS.md's "## NTM pane priority" section for the canonical rule.
 *
 * Looks for: a 1:1:1-style ratio (e.g. "cc:cod:gem 1:1:1") AND a substitution
 * ladder (e.g. "gmi→cod→pi→cc" or "gmi -> cod -> pi -> cc"). Returns null if
 * either is missing — the rule is then advisory-only (no findings emitted)
 * rather than firing against an unparseable AGENTS.md.
 *
 * Exported for test access only.
 */
export function parseCanonicalFromAgentsMd(content: string): CanonicalRule | null {
  // Find the "## NTM pane priority" section body (until the next H2 or EOF).
  // JS regex has no \Z; use a negative-lookahead for end-of-string.
  const sectionRe = /^##\s+NTM pane priority\b[\s\S]*?(?=^##\s|(?![\s\S]))/m;
  const sectionMatch = sectionRe.exec(content);
  if (sectionMatch === null) return null;
  const body = sectionMatch[0];

  // Ratio: cc:cod:gem 1:1:1 (the documented form; lanes always cc/cod/gem
  // because "gem" is the prose form for the "gmi" flag). Tolerate optional
  // backticks and whitespace between "gem" and the digit triple — markdown
  // renderings commonly wrap the lane name as `cc:cod:gem` for code styling.
  const ratioRe = /cc:cod:gem[`\s]*(\d+):(\d+):(\d+)/i;
  const ratioMatch = ratioRe.exec(body);
  if (ratioMatch === null) return null;
  const ratio = [Number(ratioMatch[1]), Number(ratioMatch[2]), Number(ratioMatch[3])];

  // Substitution ladder. Two accepted forms:
  //   inline arrow form:  "gmi→cod→pi→cc" or "gmi -> cod -> pi -> cc"
  //   list-step form:     "Missing `gmi` → `cod`" + "`cod` also unavailable → `pi`" + …
  // We try the inline form first; fall back to scanning the body for the
  // canonical lane-order pattern (gmi, cod, pi, cc) appearing in order. If
  // neither matches but the ratio is present, we assume the documented
  // default ladder (gmi → cod → pi → cc).
  let ladder: CanonicalRule["ladder"] = ["gmi", "cod", "pi", "cc"];
  const inlineLadderRe = /\b(gmi|cod|pi|cc)\s*(?:→|->)\s*(gmi|cod|pi|cc)\s*(?:→|->)\s*(gmi|cod|pi|cc)\s*(?:→|->)\s*(gmi|cod|pi|cc)/i;
  const inlineMatch = inlineLadderRe.exec(body);
  if (inlineMatch !== null) {
    ladder = [
      inlineMatch[1]!.toLowerCase() as "cc" | "cod" | "gmi" | "pi",
      inlineMatch[2]!.toLowerCase() as "cc" | "cod" | "gmi" | "pi",
      inlineMatch[3]!.toLowerCase() as "cc" | "cod" | "gmi" | "pi",
      inlineMatch[4]!.toLowerCase() as "cc" | "cod" | "gmi" | "pi",
    ];
  }

  // Optional version pin (e.g. "Changed in v3.17.0" or "as of v3.17.0").
  const versionRe = /v(\d+\.\d+(?:\.\d+)?)/;
  const versionMatch = versionRe.exec(body);
  const version = versionMatch ? `v${versionMatch[1]}` : null;

  return {
    lanes: ["cc", "cod", "gmi"],
    ratio,
    ladder,
    version,
  };
}

/**
 * Extract `--cc=N --cod=M --gmi=K --pi=L` style ratios from a single line.
 * Returns a map from lane name to integer count. Empty map if no flags found.
 *
 * Note: `--gem=N` is treated as `--gmi=N` (deprecated synonym).
 */
export function extractLaneCounts(line: string): Record<string, number> {
  const counts: Record<string, number> = {};
  LANE_FLAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LANE_FLAG_PATTERN.exec(line)) !== null) {
    const flag = match[1]!;
    const n = Number(match[2]!);
    const lane = flag === "gem" ? "gmi" : flag;
    counts[lane] = (counts[lane] ?? 0) + n;
  }
  return counts;
}

/**
 * Validate an extracted lane-count map against the canonical ratio.
 *
 * Rules:
 *   - All lane counts non-negative integers.
 *   - The cc:cod:gem proportion (ignoring pi) must match canonical ratio
 *     after scaling, OR every requested lane is 0 (degraded mode).
 *   - `pi` is allowed in addition to canonical lanes ONLY when at least one
 *     of cod/gmi is 0 (per the substitution ladder gmi→cod→pi→cc — pi only
 *     enters when cod or gmi has been dropped). If pi is present with both
 *     cod>0 AND gmi>0, that's a violation.
 *
 * Returns `null` if valid; otherwise an explanation string.
 */
export function validateLaneCounts(
  counts: Record<string, number>,
  canonical: CanonicalRule,
): string | null {
  const cc = counts["cc"] ?? 0;
  const cod = counts["cod"] ?? 0;
  const gmi = counts["gmi"] ?? 0;
  const pi = counts["pi"] ?? 0;
  const total = cc + cod + gmi + pi;
  if (total === 0) return null; // no panes at all — not our concern

  // Pi gate: pi may only appear when at least one of cod/gmi is 0 (lower in
  // the ladder).
  if (pi > 0 && cod > 0 && gmi > 0) {
    return `--pi=${pi} present alongside both --cod=${cod} AND --gmi=${gmi}; per substitution ladder ${canonical.ladder.join("→")} pi only enters when cod or gmi is downgraded`;
  }

  // If no cod and no gmi requested at all, this is an all-cc or all-pi spawn.
  // Treated as a documented exception path (handled by override marker check
  // upstream). Don't fire here.
  if (cod === 0 && gmi === 0) return null;

  // Canonical proportion check on the cc:cod:gem axes. We allow any common
  // multiplier (1:1:1 → 1/1/1, 2/2/2, 3/3/3, …). Skip the check if cc is 0
  // (degraded mode with cc dropped — rare but technically valid via ladder).
  if (cc === 0) {
    return `--cc=0 with --cod=${cod} or --gmi=${gmi} non-zero; canonical baseline requires cc>0 (cc:cod:gem ${canonical.ratio.join(":")})`;
  }
  const [rc, rco, rgm] = canonical.ratio;
  if (rc === 0) return null; // canonical doesn't constrain cc (defensive)
  // Each lane present (>0) must scale by the same multiple of canonical.
  // Lanes equal to 0 are skipped — the substitution ladder permits any lane
  // to drop out (as long as the pi gate above is satisfied).
  const multipliers: number[] = [];
  if (cc > 0) multipliers.push(cc / rc!);
  if (cod > 0 && rco! > 0) multipliers.push(cod / rco!);
  if (gmi > 0 && rgm! > 0) multipliers.push(gmi / rgm!);
  if (multipliers.length < 2) return null; // only one lane has signal — can't compare
  const m0 = multipliers[0]!;
  for (const m of multipliers) {
    if (Math.abs(m - m0) > 0.001) {
      return `lane ratio ${cc}:${cod}:${gmi} (cc:cod:gmi) does not match canonical ${canonical.ratio.join(":")} (cc:cod:gem). Expected each present lane to scale by the same integer multiple of canonical, e.g. --cc=2 --cod=2 --gmi=2 or --cc=3 --cod=3 --gmi=3.`;
    }
  }
  // Multipliers also need to be (near) integer — non-integer indicates an
  // ad-hoc ratio rather than a scaling of canonical.
  if (Math.abs(m0 - Math.round(m0)) > 0.001) {
    return `lane multiplier ${m0.toFixed(2)} is non-integer (cc=${cc} cod=${cod} gmi=${gmi}); canonical ${canonical.ratio.join(":")} must be scaled by an integer factor`;
  }
  return null;
}

/**
 * Walk `<root>/_*.md` and return paths relative to `relBase` (POSIX).
 */
async function walkSkillSubFiles(root: string, relBase: string): Promise<Array<{ abs: string; rel: string }>> {
  const out: Array<{ abs: string; rel: string }> = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith("_")) continue;
    if (!entry.name.endsWith(".md")) continue;
    const abs = path.join(root, entry.name);
    const rel = path.relative(relBase, abs).split(path.sep).join("/");
    out.push({ abs, rel });
  }
  return out;
}

function lineColOfOffset(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const limit = Math.min(offset, source.length);
  for (let i = 0; i < limit; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function hasOverrideMarkerNear(
  source: string,
  zeroBasedLine: number,
  proximityLines: number,
): boolean {
  const lines = source.split("\n");
  const lo = Math.max(0, zeroBasedLine - proximityLines);
  const hi = Math.min(lines.length, zeroBasedLine + proximityLines + 1);
  const window = lines.slice(lo, hi).join("\n");
  if (OVERRIDE_MARKERS.some((re) => re.test(window))) return true;
  // Fallback: whole-file scan, but only for the STRICT marker set. Files that
  // legitimately need file-wide suppression (e.g. _deslop.md — spawn lives in
  // a code fence too far from any prose to satisfy ±6) must opt in with an
  // unambiguous token like `<!-- pane001-override -->` or `PANE001-OVERRIDE:`.
  // The loose `OVERRIDE_MARKERS` set is NOT used here — that would let any
  // file containing the word "override" in unrelated discussion (e.g.
  // _implement.md's "cc-only floor (explicit override)" sidebar) silently
  // suppress real drift elsewhere in the file.
  return WHOLE_FILE_OVERRIDE_MARKERS.some((re) => re.test(source));
}

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
export function extractSpawnSubstring(line: string): string | null {
  if (!line.includes("ntm spawn")) return null;
  // Try backtick-delimited form first.
  const backtickRe = /`([^`]*?ntm spawn[^`]*)`/;
  const m = backtickRe.exec(line);
  if (m !== null) return m[1]!;
  return line;
}

/**
 * Scan a line for canonical-violating spawn shapes. Only flags lines that
 * contain `ntm spawn` (the actual spawn command) AND lane flags — this
 * filters out prose mentions of degraded fallback examples in tables and
 * documentation paragraphs (e.g. `--cc=2 --pi=4` listed as the "gmi+cod
 * missing" substitution example).
 *
 * Returns a Finding or null for a single line of source.
 */
function scanLine(
  source: string,
  lineIndex: number,
  line: string,
  canonical: CanonicalRule,
  file: string,
): Finding | null {
  const spawnSubstring = extractSpawnSubstring(line);
  if (spawnSubstring === null) return null;
  if (!spawnSubstring.includes("--")) return null;
  const counts = extractLaneCounts(spawnSubstring);
  if (Object.keys(counts).length === 0) return null;
  if (Object.values(counts).reduce((a, b) => a + b, 0) === 0) return null;
  const verdict = validateLaneCounts(counts, canonical);
  if (verdict === null) return null;
  if (hasOverrideMarkerNear(source, lineIndex, OVERRIDE_PROXIMITY_LINES)) return null;
  return {
    ruleId: "PANE001",
    severity: "error",
    file,
    line: lineIndex + 1,
    column: 1,
    message: `NTM pane priority drift from AGENTS.md canonical (cc:cod:gem ${canonical.ratio.join(":")}${canonical.version ? `, ${canonical.version}` : ""}): ${verdict}`,
    hint: `Either align the spawn shape with the canonical ratio + substitution ladder (${canonical.ladder.join("→")}), or document the divergence with an "explicit override" marker within ±6 lines so reviewers see the intent.`,
  };
}

async function scanFile(
  rel: string,
  abs: string,
  canonical: CanonicalRule,
): Promise<Finding[]> {
  let source: string;
  try {
    source = await readFile(abs, "utf8");
  } catch {
    return [];
  }
  if (!source.includes("ntm spawn")) return [];
  const findings: Finding[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const f = scanLine(source, i, lines[i]!, canonical, rel);
    if (f !== null) findings.push(f);
  }
  return findings;
}

export const pane001: Rule = {
  id: "PANE001",
  description:
    "NTM pane-priority spawn shapes in skill files must match AGENTS.md canonical (cc:cod:gem 1:1:1) or document an explicit override.",
  severity: "error",
  async check(doc: Document, ctx: RuleContext): Promise<Finding[]> {
    const rc = ctx as Pane001Context;
    const repoRoot = rc.repoRoot;
    if (!repoRoot && !rc.canonical && !rc.agentsMdPath) {
      // No scan root or override — rule is a no-op outside the CLI.
      return [];
    }

    // Load canonical rule (test override → explicit path → repoRoot/AGENTS.md).
    let canonical: CanonicalRule | null = rc.canonical ?? null;
    if (canonical === null) {
      const agentsPath = rc.agentsMdPath ?? path.join(repoRoot!, "AGENTS.md");
      let agentsContent: string;
      try {
        agentsContent = await readFile(agentsPath, "utf8");
      } catch {
        return []; // AGENTS.md unreadable — silently no-op
      }
      canonical = parseCanonicalFromAgentsMd(agentsContent);
      if (canonical === null) return []; // AGENTS.md doesn't contain a parseable canonical
    }

    const findings: Finding[] = [];

    // First check the Document itself (typically SKILL.md).
    const docPath = doc.filePath ?? rc.filePath;
    if (docPath && doc.source.includes("ntm spawn")) {
      const lines = doc.source.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const f = scanLine(doc.source, i, lines[i]!, canonical, docPath);
        if (f !== null) findings.push(f);
      }
    }

    // Then walk the cross-file skill sub-files.
    if (repoRoot || rc.skillsRoot) {
      const skillsRoot = rc.skillsRoot ?? path.join(repoRoot!, "skills", "start");
      const relBase = rc.skillsRoot ? skillsRoot : repoRoot!;
      const subFiles = await walkSkillSubFiles(skillsRoot, relBase);
      for (const file of subFiles) {
        const fileFindings = await scanFile(file.rel, file.abs, canonical);
        findings.push(...fileFindings);
      }
    }
    return findings;
  },
};

export default pane001;
