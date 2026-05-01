/**
 * Swarm-agent model diversity — Claude : Codex : Gemini at 1:1:1 via NTM.
 *
 * Responsibilities:
 *   1. Detect CLI availability (`which claude codex gemini`).
 *   2. Split N ready beads across available providers as floor(N/3) each
 *      with a priority-ordered remainder.
 *   3. Fall back gracefully when a CLI is missing and emit a warning so
 *      the coordinator can report degraded-mode to the user.
 *   4. Provide per-bead prompt adaptation via the three adapters.
 *
 * The public surface is the primary consumer contract for downstream
 * bead `1qn` (codex-rescue handoff). Treat it as stable.
 */
import { errMsg } from '../errors.js';
import { adaptPromptForClaude } from './claude-prompt.js';
import { adaptPromptForCodex } from './codex-prompt.js';
import { adaptPromptForGemini } from './gemini-prompt.js';
// ─── CLI detection ────────────────────────────────────────────────────────
const PROVIDER_BINARIES = {
    claude: 'claude',
    codex: 'codex',
    gemini: 'gemini',
};
/**
 * Probe `which <bin>` for each provider. A zero exit code and a non-empty
 * stdout line means the CLI is on $PATH. We deliberately do NOT call
 * `<bin> --version` here — some CLIs print a splash/upgrade prompt that
 * delays startup and inflates the caller's doctor budget. `which` is fast
 * and sufficient for routing decisions.
 */
export async function detectCliCapabilities(exec, opts = {}) {
    const timeout = opts.timeout ?? 1500;
    const probe = async (provider) => {
        const bin = PROVIDER_BINARIES[provider];
        try {
            const res = await exec('which', [bin], {
                timeout,
                cwd: opts.cwd,
                signal: opts.signal,
            });
            const path = res.stdout.trim().split('\n')[0] ?? '';
            if (res.code === 0 && path.length > 0) {
                return { provider, available: true, path };
            }
            return {
                provider,
                available: false,
                reason: res.code !== 0
                    ? `which ${bin} exited ${res.code}`
                    : `which ${bin} returned no path`,
            };
        }
        catch (err) {
            return {
                provider,
                available: false,
                reason: errMsg(err),
            };
        }
    };
    const [claude, codex, gemini] = await Promise.all([
        probe('claude'),
        probe('codex'),
        probe('gemini'),
    ]);
    return { claude, codex, gemini };
}
// ─── Ratio math + split ───────────────────────────────────────────────────
/**
 * Priority order for remainder assignment when N % 3 != 0.
 *
 * Rationale:
 *   - Claude gets the first extra (it's the most reliable across bead
 *     shapes, so we'd rather bias toward it when we can't split evenly).
 *   - Codex gets the second extra (the user explicitly asked for codex
 *     parity and it handles TypeScript-heavy beads well).
 *   - Gemini gets the third (providing the second-perspective lane even
 *     when remainder = 0).
 *
 * The same order also drives fallback: when a provider is missing we
 * re-route its beads to the next-preferred provider in this list.
 */
const REMAINDER_PRIORITY = Object.freeze([
    'claude',
    'codex',
    'gemini',
]);
/**
 * Split N beads across available providers with the floor(N/3) + priority
 * remainder rule. Missing CLIs are dropped from the lane set and their
 * would-be share is redistributed by priority.
 *
 * Contract:
 *   - sum(lane.beadIds.length) == beadIds.length
 *   - lanes contain only providers with `available === true`
 *   - lane order is claude, codex, gemini (stable; skipped entries omit)
 *   - beads are handed out in the order supplied (assumed priority-sorted
 *     by caller: highest-priority → first lane slot)
 */
export function splitBeadsByProvider(beadIds, caps) {
    const warnings = [];
    const availableProviders = REMAINDER_PRIORITY.filter((p) => caps[p].available);
    if (availableProviders.length === 0) {
        return {
            lanes: [],
            warnings: [
                'no implementation CLI available (claude, codex, gemini all missing)',
            ],
            degraded: true,
            ratio: '0:0:0',
        };
    }
    const missing = REMAINDER_PRIORITY.filter((p) => !caps[p].available);
    const degraded = missing.length > 0;
    for (const p of missing) {
        warnings.push(`${p} CLI not available${caps[p].reason ? ` (${caps[p].reason})` : ''}; falling back to [${availableProviders.join(', ')}]`);
    }
    const n = beadIds.length;
    const k = availableProviders.length;
    // Start with a floor(n/k) baseline per available provider; if k < 3 this
    // naturally redistributes the missing share.
    const counts = new Map();
    const baseline = Math.floor(n / k);
    for (const p of availableProviders)
        counts.set(p, baseline);
    // Hand out the remainder by priority order over available providers.
    let remainder = n - baseline * k;
    for (const p of REMAINDER_PRIORITY) {
        if (remainder === 0)
            break;
        if (!caps[p].available)
            continue;
        counts.set(p, (counts.get(p) ?? 0) + 1);
        remainder--;
    }
    // Slice the bead list in order; claude first, then codex, then gemini.
    const lanes = [];
    let cursor = 0;
    for (const p of REMAINDER_PRIORITY) {
        if (!caps[p].available)
            continue;
        const take = counts.get(p) ?? 0;
        if (take === 0)
            continue;
        lanes.push({
            provider: p,
            beadIds: beadIds.slice(cursor, cursor + take),
        });
        cursor += take;
    }
    const ratio = REMAINDER_PRIORITY.map((p) => caps[p].available ? String(counts.get(p) ?? 0) : '0').join(':');
    return { lanes, warnings, degraded, ratio };
}
// ─── Prompt adaptation facade ─────────────────────────────────────────────
/**
 * Pick the right adapter for a provider. Centralised so the dispatch
 * loop can `adaptPromptFor(lane.provider, ctx)` without importing all
 * three modules.
 */
export function adaptPromptFor(provider, ctx) {
    switch (provider) {
        case 'claude':
            return adaptPromptForClaude(ctx);
        case 'codex':
            return adaptPromptForCodex(ctx);
        case 'gemini':
            return adaptPromptForGemini(ctx);
    }
}
/**
 * Describe the capabilities map in a doctor-ready one-liner.
 *   All-available → "claude:gemini:codex available; ratio 1:1:1 achievable"
 *   Missing codex → "claude+gemini available; codex missing; ratio 1:0:1 achievable"
 */
export function describeCapabilities(caps) {
    const avail = REMAINDER_PRIORITY.filter((p) => caps[p].available);
    const miss = REMAINDER_PRIORITY.filter((p) => !caps[p].available);
    const ratio = REMAINDER_PRIORITY.map((p) => caps[p].available ? '1' : '0').join(':');
    const parts = [];
    parts.push(avail.length > 0 ? `${avail.join('+')} available` : 'no CLIs available');
    if (miss.length > 0)
        parts.push(`${miss.join('+')} missing`);
    parts.push(`ratio ${ratio} achievable`);
    return parts.join('; ');
}
//# sourceMappingURL=model-diversity.js.map