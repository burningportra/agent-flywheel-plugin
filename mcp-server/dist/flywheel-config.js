/**
 * Minimal loader for `flywheel.config.yaml` at the repo root.
 *
 * Only the fields B-AC2 introduces are read here. We intentionally do NOT add a
 * YAML dependency — the file is expected to be hand-edited and small, and a
 * deliberately tiny parser keeps the install footprint flat (Phase 12 §12.5
 * "no optional deps" trap-avoidance bullet).
 *
 * Schema (v1):
 *
 *   convergence:
 *     gate_advance_wave: true   # default true
 *
 * R-008 (agent-ergonomics audit pass 4) — strict-key validation with
 * Levenshtein-1 typo suggestions. Currently warn-only (collect warnings
 * on the result; callers decide how to surface them). The deprecation
 * path is: v3.x warns, v4.0 fails. This is the warn-only stage.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
/**
 * R-008 — known keys per nesting level. Adding a new field elsewhere
 * MUST update this map AND DEFAULT_CONFIG. Keep them lockstep.
 */
const KNOWN_KEYS = {
    '': ['convergence'],
    convergence: ['gate_advance_wave'],
};
export const DEFAULT_CONFIG = {
    convergence: {
        gate_advance_wave: true,
    },
};
const CONFIG_FILENAME = 'flywheel.config.yaml';
/**
 * Levenshtein distance between two short strings. Returns Infinity if
 * either input is suspiciously long (we only ever compare config keys,
 * which are < 40 chars). Used by R-008 typo detection.
 */
function levenshtein(a, b) {
    if (a === b)
        return 0;
    if (a.length > 40 || b.length > 40)
        return Infinity;
    const m = a.length;
    const n = b.length;
    if (m === 0)
        return n;
    if (n === 0)
        return m;
    const prev = new Array(n + 1);
    const curr = new Array(n + 1);
    for (let j = 0; j <= n; j++)
        prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, // deletion
            curr[j - 1] + 1, // insertion
            prev[j - 1] + cost);
        }
        for (let j = 0; j <= n; j++)
            prev[j] = curr[j];
    }
    return prev[n];
}
/**
 * R-008 — return the closest known key within Levenshtein distance 1, or
 * undefined if nothing is close enough. Used to suggest "did you mean".
 */
export function suggestKey(unknown, known) {
    let bestKey;
    let bestDist = 2; // strictly < 2 means accept
    for (const k of known) {
        const d = levenshtein(unknown, k);
        if (d < bestDist) {
            bestDist = d;
            bestKey = k;
        }
    }
    return bestKey;
}
/**
 * Parse the limited YAML subset we care about for B-AC2:
 *   key: value
 *   nested-key:
 *     subkey: value
 *
 * No lists, no quoted-string escapes, no anchors. Anything more complex is
 * treated as "use defaults" — explicit fallbacks beat silent misparse.
 */
function parseTinyYaml(src) {
    const lines = src.split(/\r?\n/);
    const root = {};
    let currentKey = null;
    let currentObj = null;
    for (const rawLine of lines) {
        const line = rawLine.replace(/#.*$/, '').trimEnd();
        if (line.trim() === '')
            continue;
        const indent = line.length - line.replace(/^\s+/, '').length;
        const trimmed = line.trim();
        const colon = trimmed.indexOf(':');
        if (colon === -1)
            continue;
        const key = trimmed.slice(0, colon).trim();
        const value = trimmed.slice(colon + 1).trim();
        if (indent === 0) {
            if (value === '') {
                currentKey = key;
                currentObj = {};
                root[key] = currentObj;
            }
            else {
                root[key] = coerce(value);
                currentKey = null;
                currentObj = null;
            }
        }
        else if (currentObj && currentKey !== null) {
            currentObj[key] = coerce(value);
        }
    }
    return root;
}
function coerce(v) {
    const lc = v.toLowerCase();
    if (lc === 'true')
        return true;
    if (lc === 'false')
        return false;
    if (/^-?\d+(\.\d+)?$/.test(v))
        return Number(v);
    // strip surrounding quotes if present
    if ((v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))) {
        return v.slice(1, -1);
    }
    return v;
}
/**
 * R-008 — collect structural warnings about the parsed YAML without
 * blocking the load. Only walks one level of nesting (matching the
 * schema). Adding a new top-level node should also add a KNOWN_KEYS
 * entry for that node's children.
 */
function collectConfigWarnings(parsed) {
    const warnings = [];
    const topKnown = KNOWN_KEYS[''];
    for (const key of Object.keys(parsed)) {
        if (topKnown.includes(key))
            continue;
        const suggestion = suggestKey(key, topKnown);
        warnings.push({
            kind: 'unknown_key',
            path: key,
            message: suggestion
                ? `Unknown top-level key "${key}" — did you mean "${suggestion}"?`
                : `Unknown top-level key "${key}".`,
            ...(suggestion ? { suggestion } : {}),
        });
    }
    for (const [topKey, value] of Object.entries(parsed)) {
        if (!topKnown.includes(topKey))
            continue; // already warned
        const known = KNOWN_KEYS[topKey];
        if (!known)
            continue;
        if (typeof value !== 'object' || value === null)
            continue;
        for (const subKey of Object.keys(value)) {
            if (known.includes(subKey))
                continue;
            const suggestion = suggestKey(subKey, known);
            warnings.push({
                kind: 'unknown_key',
                path: `${topKey}.${subKey}`,
                message: suggestion
                    ? `Unknown key "${topKey}.${subKey}" — did you mean "${topKey}.${suggestion}"?`
                    : `Unknown key "${topKey}.${subKey}".`,
                ...(suggestion ? { suggestion: `${topKey}.${suggestion}` } : {}),
            });
        }
    }
    // Type check on the recognized fields.
    const conv = parsed.convergence;
    if (conv && typeof conv === 'object') {
        const gate = conv.gate_advance_wave;
        if (gate !== undefined && typeof gate !== 'boolean') {
            warnings.push({
                kind: 'wrong_type',
                path: 'convergence.gate_advance_wave',
                message: `convergence.gate_advance_wave must be a boolean (true|false); got ${JSON.stringify(gate)}. Using default.`,
            });
        }
    }
    return warnings;
}
/**
 * R-008 — full loader returning config + warnings + source. The
 * `loadFlywheelConfig` thin wrapper preserves the existing single-value
 * return type for callers that don't care about warnings.
 */
export function loadFlywheelConfigWithWarnings(cwd) {
    const configPath = path.join(cwd, CONFIG_FILENAME);
    let raw;
    try {
        raw = readFileSync(configPath, 'utf8');
    }
    catch {
        return { config: DEFAULT_CONFIG, warnings: [], source: configPath };
    }
    let parsed;
    try {
        parsed = parseTinyYaml(raw);
    }
    catch (err) {
        return {
            config: DEFAULT_CONFIG,
            warnings: [
                {
                    kind: 'unparseable_yaml',
                    path: '',
                    message: `Could not parse ${configPath}: ${err instanceof Error ? err.message : String(err)}. Using defaults.`,
                },
            ],
            source: configPath,
        };
    }
    const warnings = collectConfigWarnings(parsed);
    const convNode = parsed.convergence;
    if (typeof convNode !== 'object' || convNode === null) {
        return { config: DEFAULT_CONFIG, warnings, source: configPath };
    }
    const conv = convNode;
    const gate = typeof conv.gate_advance_wave === 'boolean'
        ? conv.gate_advance_wave
        : DEFAULT_CONFIG.convergence.gate_advance_wave;
    return {
        config: { convergence: { gate_advance_wave: gate } },
        warnings,
        source: configPath,
    };
}
export function loadFlywheelConfig(cwd) {
    return loadFlywheelConfigWithWarnings(cwd).config;
}
//# sourceMappingURL=flywheel-config.js.map