import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
const OVERRIDE_MARKERS = [
    /explicit override/i,
    /intentional override/i,
    /signature override/i,
    /override of the canonical/i,
    /override of the v3\.\d+/i,
    /signature and an explicit override/i,
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
export function parseCanonicalFromAgentsMd(content) {
    // Find the "## NTM pane priority" section body (until the next H2 or EOF).
    // JS regex has no \Z; use a negative-lookahead for end-of-string.
    const sectionRe = /^##\s+NTM pane priority\b[\s\S]*?(?=^##\s|(?![\s\S]))/m;
    const sectionMatch = sectionRe.exec(content);
    if (sectionMatch === null)
        return null;
    const body = sectionMatch[0];
    // Ratio: cc:cod:gem 1:1:1 (the documented form; lanes always cc/cod/gem
    // because "gem" is the prose form for the "gmi" flag). Tolerate optional
    // backticks and whitespace between "gem" and the digit triple — markdown
    // renderings commonly wrap the lane name as `cc:cod:gem` for code styling.
    const ratioRe = /cc:cod:gem[`\s]*(\d+):(\d+):(\d+)/i;
    const ratioMatch = ratioRe.exec(body);
    if (ratioMatch === null)
        return null;
    const ratio = [Number(ratioMatch[1]), Number(ratioMatch[2]), Number(ratioMatch[3])];
    // Substitution ladder. Two accepted forms:
    //   inline arrow form:  "gmi→cod→pi→cc" or "gmi -> cod -> pi -> cc"
    //   list-step form:     "Missing `gmi` → `cod`" + "`cod` also unavailable → `pi`" + …
    // We try the inline form first; fall back to scanning the body for the
    // canonical lane-order pattern (gmi, cod, pi, cc) appearing in order. If
    // neither matches but the ratio is present, we assume the documented
    // default ladder (gmi → cod → pi → cc).
    let ladder = ["gmi", "cod", "pi", "cc"];
    const inlineLadderRe = /\b(gmi|cod|pi|cc)\s*(?:→|->)\s*(gmi|cod|pi|cc)\s*(?:→|->)\s*(gmi|cod|pi|cc)\s*(?:→|->)\s*(gmi|cod|pi|cc)/i;
    const inlineMatch = inlineLadderRe.exec(body);
    if (inlineMatch !== null) {
        ladder = [
            inlineMatch[1].toLowerCase(),
            inlineMatch[2].toLowerCase(),
            inlineMatch[3].toLowerCase(),
            inlineMatch[4].toLowerCase(),
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
export function validateLaneCounts(counts, canonical) {
    const cc = counts["cc"] ?? 0;
    const cod = counts["cod"] ?? 0;
    const gmi = counts["gmi"] ?? 0;
    const pi = counts["pi"] ?? 0;
    const total = cc + cod + gmi + pi;
    if (total === 0)
        return null; // no panes at all — not our concern
    // Pi gate: pi may only appear when at least one of cod/gmi is 0 (lower in
    // the ladder).
    if (pi > 0 && cod > 0 && gmi > 0) {
        return `--pi=${pi} present alongside both --cod=${cod} AND --gmi=${gmi}; per substitution ladder ${canonical.ladder.join("→")} pi only enters when cod or gmi is downgraded`;
    }
    // If no cod and no gmi requested at all, this is an all-cc or all-pi spawn.
    // Treated as a documented exception path (handled by override marker check
    // upstream). Don't fire here.
    if (cod === 0 && gmi === 0)
        return null;
    // Canonical proportion check on the cc:cod:gem axes. We allow any common
    // multiplier (1:1:1 → 1/1/1, 2/2/2, 3/3/3, …). Skip the check if cc is 0
    // (degraded mode with cc dropped — rare but technically valid via ladder).
    if (cc === 0) {
        return `--cc=0 with --cod=${cod} or --gmi=${gmi} non-zero; canonical baseline requires cc>0 (cc:cod:gem ${canonical.ratio.join(":")})`;
    }
    const [rc, rco, rgm] = canonical.ratio;
    if (rc === 0)
        return null; // canonical doesn't constrain cc (defensive)
    // Each lane present (>0) must scale by the same multiple of canonical.
    // Lanes equal to 0 are skipped — the substitution ladder permits any lane
    // to drop out (as long as the pi gate above is satisfied).
    const multipliers = [];
    if (cc > 0)
        multipliers.push(cc / rc);
    if (cod > 0 && rco > 0)
        multipliers.push(cod / rco);
    if (gmi > 0 && rgm > 0)
        multipliers.push(gmi / rgm);
    if (multipliers.length < 2)
        return null; // only one lane has signal — can't compare
    const m0 = multipliers[0];
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
    // Fallback: whole-file scan. Files that declare "this mode is an explicit
    // override of the canonical" in their intro paragraph (e.g. _deslop.md)
    // mean the file's spawn shape is intentionally non-canonical end-to-end —
    // even though the override marker is many lines away from the spawn line.
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
    if (!line.includes("ntm spawn"))
        return null;
    // Try backtick-delimited form first.
    const backtickRe = /`([^`]*?ntm spawn[^`]*)`/;
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
    const verdict = validateLaneCounts(counts, canonical);
    if (verdict === null)
        return null;
    if (hasOverrideMarkerNear(source, lineIndex, OVERRIDE_PROXIMITY_LINES))
        return null;
    return {
        ruleId: "PANE001",
        severity: "warn",
        file,
        line: lineIndex + 1,
        column: 1,
        message: `NTM pane priority drift from AGENTS.md canonical (cc:cod:gem ${canonical.ratio.join(":")}${canonical.version ? `, ${canonical.version}` : ""}): ${verdict}`,
        hint: `Either align the spawn shape with the canonical ratio + substitution ladder (${canonical.ladder.join("→")}), or document the divergence with an "explicit override" marker within ±6 lines so reviewers see the intent.`,
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
    if (!source.includes("ntm spawn"))
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
    description: "NTM pane-priority spawn shapes in skill files must match AGENTS.md canonical (cc:cod:gem 1:1:1) or document an explicit override.",
    severity: "warn",
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
        if (docPath && doc.source.includes("ntm spawn")) {
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