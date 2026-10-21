import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import type { Document, Finding, Rule, RuleContext } from "../types.js";
import { GEMINI_LANE_MODEL } from "../../pi-models.js";

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
 * finding: Pi lanes go through `swarm-spawn.js`. So is `--gmi=N`, because
 * ntm's gmi lane starts the gemini CLI, and the Gemini lane runs only
 * gemini-4-argon on Pi, which `swarm-spawn.js --gmi=N` spawns.
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

export type Lane = "cc" | "cod" | "gmi" | "pi" | "agy";
const DEFAULT_LADDER_LANES: readonly Lane[] = ["cc", "cod", "gmi", "pi"];
const ALL_LANES: readonly Lane[] = ["cc", "cod", "gmi", "pi", "agy"];

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
 * Canonical PANE001 override markers.
 *
 * Both proximity and whole-file suppression require these project-specific
 * tokens. Loose prose such as "explicit override" appears in normal
 * substitution-ladder documentation and must not silence lane drift findings.
 */
const OVERRIDE_MARKERS: ReadonlyArray<RegExp> = [
  /<!--\s*pane001-override\b/i,
  /\bPANE001-OVERRIDE:/,
];

/** Recognised NTM lane flags. `--gem=` is the deprecated synonym for `--gmi=`. */
const LANE_FLAG_PATTERN = /--(cc|cod|gmi|gem|pi|agy)=(\d+)/g;
const OVERRIDE_PROXIMITY_LINES = 6;
/** Commands that spawn swarm lanes. `swarm-spawn.js` adds Pi panes to an `ntm spawn` session. */
const SPAWN_COMMANDS = ["swarm-spawn.js", "ntm spawn"] as const;

function toLane(token: string): Lane {
  const lower = token.toLowerCase();
  return (lower === "gem" ? "gmi" : lower) as Lane;
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
export function parseCanonicalFromAgentsMd(content: string): CanonicalRule | null {
  // Find the "## NTM pane priority" section body (until the next H2 or EOF).
  // JS regex has no \Z; use a negative-lookahead for end-of-string.
  const sectionRe = /^##\s+NTM pane priority\b[\s\S]*?(?=^##\s|(?![\s\S]))/m;
  const body = sectionRe.exec(content)?.[0];
  if (body === undefined) return null;

  // Tolerate backticks and whitespace between the lane triple and the digit
  // triple — markdown renderings commonly wrap it as `cc:pi:gem`.
  const ratioRe = /\bcc:(cod|gem|gmi|pi|agy):(cod|gem|gmi|pi|agy)[`\s]*(\d+):(\d+):(\d+)/i;
  const ratioMatch = ratioRe.exec(body);
  if (ratioMatch === null) return null;
  const [, second, third, ccRatio, secondRatio, thirdRatio] = ratioMatch;
  const lanes: Lane[] = ["cc", toLane(second!), toLane(third!)];
  const ratio = [Number(ccRatio), Number(secondRatio), Number(thirdRatio)];

  const peers = lanes.slice(1).reverse();
  let ladder: Lane[] = [...peers, ...DEFAULT_LADDER_LANES.filter((lane) => !lanes.includes(lane)), "cc"];
  const inlineLadderRe = /\b(gmi|cod|pi|agy|cc)\s*(?:→|->)\s*(gmi|cod|pi|agy|cc)\s*(?:→|->)\s*(gmi|cod|pi|agy|cc)\s*(?:→|->)\s*(gmi|cod|pi|agy|cc)/i;
  const inlineMatch = inlineLadderRe.exec(body);
  if (inlineMatch !== null) {
    ladder = inlineMatch.slice(1, 5).map((token) => toLane(token));
  }

  // Optional version pin (e.g. "Changed in v3.21.0" or "as of v3.21.0").
  const versionRe = /v(\d+\.\d+(?:\.\d+)?)/;
  const versionMatch = versionRe.exec(body);
  const version = versionMatch ? `v${versionMatch[1]}` : null;

  return { lanes, ratio, ladder, version };
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
export function validateLaneCounts(
  counts: Record<string, number>,
  canonical: CanonicalRule,
): string | null {
  const count = (lane: Lane): number => counts[lane] ?? 0;
  if (ALL_LANES.reduce((sum, lane) => sum + count(lane), 0) === 0) return null;

  const [primary, ...peers] = canonical.lanes;
  const fallbacks = ALL_LANES.filter((lane) => !canonical.lanes.includes(lane));
  const shape = canonical.lanes.join(":");
  const ladder = canonical.ladder.join("→");

  if (peers.every((lane) => count(lane) > 0)) {
    for (const lane of fallbacks) {
      if (count(lane) > 0) {
        return `--${lane}=${count(lane)} present alongside ${peers.map((peer) => `--${peer}=${count(peer)}`).join(" AND ")}; per substitution ladder ${ladder} ${lane} only enters when ${peers.join(" or ")} is downgraded`;
      }
    }
  }
  if (peers.every((lane) => count(lane) === 0)) return null;

  if (count(primary!) === 0) {
    return `--${primary}=0 with ${peers.map((peer) => `--${peer}=${count(peer)}`).join(" or ")} non-zero; canonical baseline requires ${primary}>0 (${shape} ${canonical.ratio.join(":")})`;
  }
  // Each canonical lane present (>0) must scale by the same multiple.
  const multipliers = canonical.lanes.flatMap((lane, index) => {
    const ratio = canonical.ratio[index] ?? 0;
    return count(lane) > 0 && ratio > 0 ? [count(lane) / ratio] : [];
  });
  if (multipliers.length < 2) return null;
  const m0 = multipliers[0]!;
  const observed = canonical.lanes.map((lane) => count(lane)).join(":");
  if (multipliers.some((m) => Math.abs(m - m0) > 0.001)) {
    const example = (n: number) => canonical.lanes.map((lane, i) => `--${lane}=${n * (canonical.ratio[i] ?? 1)}`).join(" ");
    return `lane ratio ${observed} (${shape}) does not match canonical ${canonical.ratio.join(":")} (${shape}). Expected each present lane to scale by the same integer multiple of canonical, e.g. ${example(2)} or ${example(3)}.`;
  }
  if (Math.abs(m0 - Math.round(m0)) > 0.001) {
    return `lane multiplier ${m0.toFixed(2)} is non-integer (${shape} ${observed}); canonical ${canonical.ratio.join(":")} must be scaled by an integer factor`;
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
  // Whole-file fallback uses the same strict marker set. Files that need
  // file-wide suppression (e.g. a code fence too far from explanatory prose to
  // satisfy ±6) must opt in with `<!-- pane001-override -->` or
  // `PANE001-OVERRIDE:`.
  return OVERRIDE_MARKERS.some((re) => re.test(source));
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
  const command = SPAWN_COMMANDS.find((name) => line.includes(name));
  if (command === undefined) return null;
  // Try backtick-delimited form first.
  const backtickRe = new RegExp(`\`([^\`]*?${command.replace(/[.]/g, "\\.")}[^\`]*)\``);
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
  const rawNtm = !spawnSubstring.includes("swarm-spawn.js");
  // ntm has no Pi agent type, so no override marker can make this line run.
  if (rawNtm && (counts["pi"] ?? 0) > 0) {
    return {
      ruleId: "PANE001",
      severity: "error",
      file,
      line: lineIndex + 1,
      column: 1,
      message: `ntm spawn has no pi lane (ntm rejects --pi=${counts["pi"]} with "unknown flag: --pi")`,
      hint: 'Spawn Pi lanes with node "${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/scripts/swarm-spawn.js" <project> --label <label> --pi=N --pi-model=<model>, which runs ntm spawn for the other lanes.',
    };
  }
  // No override either: the Gemini lane never runs the gemini CLI.
  if (rawNtm && (counts["gmi"] ?? 0) > 0) {
    return {
      ruleId: "PANE001",
      severity: "error",
      file,
      line: lineIndex + 1,
      column: 1,
      message: `ntm spawn --gmi=${counts["gmi"]} starts the gemini CLI; the Gemini lane runs only ${GEMINI_LANE_MODEL} on Pi`,
      hint: `Spawn Gemini panes with node "\${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/scripts/swarm-spawn.js" <project> --label <label> --gmi=N, which runs each one as Pi on ${GEMINI_LANE_MODEL}.`,
    };
  }
  const verdict = validateLaneCounts(counts, canonical);
  if (verdict === null) return null;
  if (hasOverrideMarkerNear(source, lineIndex, OVERRIDE_PROXIMITY_LINES)) return null;
  return {
    ruleId: "PANE001",
    severity: "error",
    file,
    line: lineIndex + 1,
    column: 1,
    message: `NTM pane priority drift from AGENTS.md canonical (${canonical.lanes.join(":")} ${canonical.ratio.join(":")}${canonical.version ? `, ${canonical.version}` : ""}): ${verdict}`,
    hint: `Either align the spawn shape with the canonical ratio + substitution ladder (${canonical.ladder.join("→")}), or document the divergence with a PANE001-OVERRIDE: marker within ±6 lines so reviewers see the intent.`,
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
  if (!SPAWN_COMMANDS.some((command) => source.includes(command))) return [];
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
    "NTM pane-priority spawn shapes in skill files must match AGENTS.md canonical (cc:pi:gem 1:1:1) or document an explicit override.",
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
    if (docPath && SPAWN_COMMANDS.some((command) => doc.source.includes(command))) {
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
