import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { GEMINI_LANE_MODEL } from "../../pi-models.js";
const DEFAULT_LADDER_LANES = ["cc", "cod", "gmi", "pi"];
const ALL_LANES = ["cc", "cod", "gmi", "pi", "agy"];
/**
 * Canonical PANE001 override markers.
 *
 * Both proximity and whole-file suppression require these project-specific
 * tokens. Loose prose such as "explicit override" appears in normal
 * substitution-ladder documentation and must not silence lane drift findings.
 */
const OVERRIDE_MARKERS = [
    /<!--\s*pane001-override\b/i,
    /\bPANE001-OVERRIDE:/,
];
/** Recognised NTM lane flags. `--gem=` is the deprecated synonym for `--gmi=`. */
const LANE_FLAG_PATTERN = /--(cc|cod|gmi|gem|pi|agy)=(\d+)/g;
const OVERRIDE_PROXIMITY_LINES = 6;
/** Commands that spawn swarm lanes. `swarm-spawn.js` adds Pi panes to an `ntm spawn` session. */
const SPAWN_COMMANDS = ["swarm-spawn.js", "ntm spawn"];
function toLane(token) {
    const lower = token.toLowerCase();
    return (lower === "gem" ? "gmi" : lower);
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
export function parseCanonicalFromAgentsMd(content) {
    // Find the "## NTM pane priority" section body (until the next H2 or EOF).
    // JS regex has no \Z; use a negative-lookahead for end-of-string.
    const sectionRe = /^##\s+NTM pane priority\b[\s\S]*?(?=^##\s|(?![\s\S]))/m;
    const body = sectionRe.exec(content)?.[0];
    if (body === undefined)
        return null;
    // Tolerate backticks and whitespace between the lane triple and the digit
    // triple — markdown renderings commonly wrap it as `cc:pi:gem`.
    const ratioRe = /\bcc:(cod|gem|gmi|pi|agy):(cod|gem|gmi|pi|agy)[`\s]*(\d+):(\d+):(\d+)/i;
    const ratioMatch = ratioRe.exec(body);
    if (ratioMatch === null)
        return null;
    const [, second, third, ccRatio, secondRatio, thirdRatio] = ratioMatch;
    const lanes = ["cc", toLane(second), toLane(third)];
    const ratio = [Number(ccRatio), Number(secondRatio), Number(thirdRatio)];
    const peers = lanes.slice(1).reverse();
    let ladder = [...peers, ...DEFAULT_LADDER_LANES.filter((lane) => !lanes.includes(lane)), "cc"];
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
export function extractLaneCounts(line) {
    const counts = {};
    LANE_FLAG_PATTERN.lastIndex = 0;
    let match;
    while ((match = LANE_FLAG_PATTERN.exec(line)) !== null) {
        const flag = match[1];
        const n = Number(match[2]);
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
export function validateLaneCounts(counts, canonical) {
    const count = (lane) => counts[lane] ?? 0;
    if (ALL_LANES.reduce((sum, lane) => sum + count(lane), 0) === 0)
        return null;
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
    if (peers.every((lane) => count(lane) === 0))
        return null;
    if (count(primary) === 0) {
        return `--${primary}=0 with ${peers.map((peer) => `--${peer}=${count(peer)}`).join(" or ")} non-zero; canonical baseline requires ${primary}>0 (${shape} ${canonical.ratio.join(":")})`;
    }
    // Each canonical lane present (>0) must scale by the same multiple.
    const multipliers = canonical.lanes.flatMap((lane, index) => {
        const ratio = canonical.ratio[index] ?? 0;
        return count(lane) > 0 && ratio > 0 ? [count(lane) / ratio] : [];
    });
    if (multipliers.length < 2)
        return null;
    const m0 = multipliers[0];
    const observed = canonical.lanes.map((lane) => count(lane)).join(":");
    if (multipliers.some((m) => Math.abs(m - m0) > 0.001)) {
        const example = (n) => canonical.lanes.map((lane, i) => `--${lane}=${n * (canonical.ratio[i] ?? 1)}`).join(" ");
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
async function walkSkillSubFiles(root, relBase) {
    const out = [];
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const entry of entries) {
        if (!entry.isFile())
            continue;
        if (!entry.name.startsWith("_"))
            continue;
        if (!entry.name.endsWith(".md"))
            continue;
        const abs = path.join(root, entry.name);
        const rel = path.relative(relBase, abs).split(path.sep).join("/");
        out.push({ abs, rel });
    }
    return out;
}
function lineColOfOffset(source, offset) {
    let line = 1;
    let column = 1;
    const limit = Math.min(offset, source.length);
    for (let i = 0; i < limit; i++) {
        if (source.charCodeAt(i) === 10) {
            line++;
            column = 1;
        }
        else {
            column++;
        }
    }
    return { line, column };
}
function hasOverrideMarkerNear(source, zeroBasedLine, proximityLines) {
    const lines = source.split("\n");
    const lo = Math.max(0, zeroBasedLine - proximityLines);
    const hi = Math.min(lines.length, zeroBasedLine + proximityLines + 1);
    const window = lines.slice(lo, hi).join("\n");
    if (OVERRIDE_MARKERS.some((re) => re.test(window)))
        return true;
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
export function extractSpawnSubstring(line) {
    const command = SPAWN_COMMANDS.find((name) => line.includes(name));
    if (command === undefined)
        return null;
    // Try backtick-delimited form first.
    const backtickRe = new RegExp(`\`([^\`]*?${command.replace(/[.]/g, "\\.")}[^\`]*)\``);
    const m = backtickRe.exec(line);
    if (m !== null)
        return m[1];
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
function scanLine(source, lineIndex, line, canonical, file) {
    const spawnSubstring = extractSpawnSubstring(line);
    if (spawnSubstring === null)
        return null;
    if (!spawnSubstring.includes("--"))
        return null;
    const counts = extractLaneCounts(spawnSubstring);
    if (Object.keys(counts).length === 0)
        return null;
    if (Object.values(counts).reduce((a, b) => a + b, 0) === 0)
        return null;
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
    if (verdict === null)
        return null;
    if (hasOverrideMarkerNear(source, lineIndex, OVERRIDE_PROXIMITY_LINES))
        return null;
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
async function scanFile(rel, abs, canonical) {
    let source;
    try {
        source = await readFile(abs, "utf8");
    }
    catch {
        return [];
    }
    if (!SPAWN_COMMANDS.some((command) => source.includes(command)))
        return [];
    const findings = [];
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const f = scanLine(source, i, lines[i], canonical, rel);
        if (f !== null)
            findings.push(f);
    }
    return findings;
}
export const pane001 = {
    id: "PANE001",
    description: "NTM pane-priority spawn shapes in skill files must match AGENTS.md canonical (cc:pi:gem 1:1:1) or document an explicit override.",
    severity: "error",
    async check(doc, ctx) {
        const rc = ctx;
        const repoRoot = rc.repoRoot;
        if (!repoRoot && !rc.canonical && !rc.agentsMdPath) {
            // No scan root or override — rule is a no-op outside the CLI.
            return [];
        }
        // Load canonical rule (test override → explicit path → repoRoot/AGENTS.md).
        let canonical = rc.canonical ?? null;
        if (canonical === null) {
            const agentsPath = rc.agentsMdPath ?? path.join(repoRoot, "AGENTS.md");
            let agentsContent;
            try {
                agentsContent = await readFile(agentsPath, "utf8");
            }
            catch {
                return []; // AGENTS.md unreadable — silently no-op
            }
            canonical = parseCanonicalFromAgentsMd(agentsContent);
            if (canonical === null)
                return []; // AGENTS.md doesn't contain a parseable canonical
        }
        const findings = [];
        // First check the Document itself (typically SKILL.md).
        const docPath = doc.filePath ?? rc.filePath;
        if (docPath && SPAWN_COMMANDS.some((command) => doc.source.includes(command))) {
            const lines = doc.source.split("\n");
            for (let i = 0; i < lines.length; i++) {
                const f = scanLine(doc.source, i, lines[i], canonical, docPath);
                if (f !== null)
                    findings.push(f);
            }
        }
        // Then walk the cross-file skill sub-files.
        if (repoRoot || rc.skillsRoot) {
            const skillsRoot = rc.skillsRoot ?? path.join(repoRoot, "skills", "start");
            const relBase = rc.skillsRoot ? skillsRoot : repoRoot;
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
//# sourceMappingURL=pane001.js.map