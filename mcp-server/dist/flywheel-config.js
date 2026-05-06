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
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
export const DEFAULT_CONFIG = {
    convergence: {
        gate_advance_wave: true,
    },
};
const CONFIG_FILENAME = 'flywheel.config.yaml';
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
export function loadFlywheelConfig(cwd) {
    const configPath = path.join(cwd, CONFIG_FILENAME);
    let raw;
    try {
        raw = readFileSync(configPath, 'utf8');
    }
    catch {
        return DEFAULT_CONFIG;
    }
    let parsed;
    try {
        parsed = parseTinyYaml(raw);
    }
    catch {
        return DEFAULT_CONFIG;
    }
    const convNode = parsed.convergence;
    if (typeof convNode !== 'object' || convNode === null) {
        return DEFAULT_CONFIG;
    }
    const conv = convNode;
    const gate = typeof conv.gate_advance_wave === 'boolean'
        ? conv.gate_advance_wave
        : DEFAULT_CONFIG.convergence.gate_advance_wave;
    return {
        convergence: {
            gate_advance_wave: gate,
        },
    };
}
//# sourceMappingURL=flywheel-config.js.map