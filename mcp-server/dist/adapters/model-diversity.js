/**
 * Swarm-agent model diversity — Claude : Codex : Gemini at 1:1:1 via NTM,
 * with Pi as the first non-primary fallback.
 *
 * Responsibilities:
 *   1. Detect CLI availability (`which claude codex gemini pi`).
 *   2. Split N ready beads across available providers as floor(N/3) each
 *      with a priority-ordered remainder.
 *   3. Fall back gracefully when a CLI is missing and emit a warning so
 *      the coordinator can report degraded-mode to the user.
 *   4. Provide per-bead prompt adaptation for every dispatch provider.
 *
 * The public surface is the primary consumer contract for downstream
 * bead `1qn` (codex-rescue handoff). Treat it as stable.
 */
import { errMsg } from '../errors.js';
import { adaptPromptForClaude, adaptPromptForPi } from './claude-prompt.js';
import { adaptPromptForCodex } from './codex-prompt.js';
import { adaptPromptForGemini } from './gemini-prompt.js';
// ─── CLI detection ────────────────────────────────────────────────────────
const PROVIDER_BINARIES = {
    claude: 'claude',
    codex: 'codex',
    gemini: 'gemini',
    pi: 'pi',
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
    const [claude, codex, gemini, pi] = await Promise.all([
        probe('claude'),
        probe('codex'),
        probe('gemini'),
        probe('pi'),
    ]);
    return { claude, codex, gemini, pi };
}
// ─── Ratio math + split ───────────────────────────────────────────────────
const PRIMARY_PROVIDERS = ['claude', 'codex', 'gemini'];
const ROUTING_PROVIDERS = Object.freeze([
    'claude',
    'codex',
    'gemini',
    'pi',
]);
const FALLBACK_PRIORITY = {
    claude: ['codex', 'gemini', 'pi'],
    codex: ['gemini', 'pi', 'claude'],
    gemini: ['codex', 'pi', 'claude'],
};
/**
 * Split N beads into canonical Claude/Codex/Gemini shares, then transfer a
 * missing provider's complete share through the supported fallback order.
 *
 * Contract:
 *   - sum(lane.beadIds.length) == beadIds.length
 *   - lanes contain only providers with `available === true`
 *   - lane order is claude, codex, gemini, pi (stable; skipped entries omit)
 *   - beads are handed out in the order supplied (assumed priority-sorted
 *     by caller: highest-priority → first lane slot)
 */
export function splitBeadsByProvider(beadIds, caps) {
    const warnings = [];
    const availableProviders = ROUTING_PROVIDERS.filter((p) => caps[p].available);
    if (availableProviders.length === 0) {
        return {
            lanes: [],
            warnings: [
                'no implementation CLI available (claude, codex, gemini, pi all missing)',
            ],
            degraded: true,
            ratio: '0:0:0',
        };
    }
    const missing = PRIMARY_PROVIDERS.filter((p) => !caps[p].available);
    const degraded = missing.length > 0;
    const n = beadIds.length;
    const preferredCounts = new Map();
    const baseline = Math.floor(n / PRIMARY_PROVIDERS.length);
    for (const provider of PRIMARY_PROVIDERS) {
        preferredCounts.set(provider, baseline);
    }
    let remainder = n - baseline * PRIMARY_PROVIDERS.length;
    for (const p of PRIMARY_PROVIDERS) {
        if (remainder === 0)
            break;
        preferredCounts.set(p, (preferredCounts.get(p) ?? 0) + 1);
        remainder--;
    }
    const assigned = new Map(ROUTING_PROVIDERS.map((provider) => [provider, []]));
    let cursor = 0;
    for (const preferred of PRIMARY_PROVIDERS) {
        const count = preferredCounts.get(preferred) ?? 0;
        const ids = beadIds.slice(cursor, cursor + count);
        cursor += count;
        if (ids.length === 0)
            continue;
        const fallback = FALLBACK_PRIORITY[preferred].find((provider) => caps[provider].available);
        const provider = caps[preferred].available ? preferred : fallback;
        if (!provider)
            continue;
        assigned.get(provider)?.push(...ids);
        if (provider !== preferred) {
            warnings.push(`${preferred} CLI not available${caps[preferred].reason ? ` (${caps[preferred].reason})` : ''}; reassigned ${ids.length} bead(s) to ${provider}`);
        }
    }
    const lanes = [];
    for (const provider of ROUTING_PROVIDERS) {
        const ids = assigned.get(provider) ?? [];
        if (ids.length > 0)
            lanes.push({ provider, beadIds: ids });
    }
    const ratio = PRIMARY_PROVIDERS.map((provider) => String(assigned.get(provider)?.length ?? 0)).join(':');
    return { lanes, warnings, degraded, ratio };
}
// ─── Prompt adaptation facade ─────────────────────────────────────────────
/**
 * Pick the right adapter for a provider. Centralised so the dispatch
 * loop can `adaptPromptFor(lane.provider, ctx)` without importing all
 * provider modules.
 */
export function adaptPromptFor(provider, ctx) {
    switch (provider) {
        case 'claude':
            return adaptPromptForClaude(ctx);
        case 'codex':
            return adaptPromptForCodex(ctx);
        case 'gemini':
            return adaptPromptForGemini(ctx);
        case 'pi':
            return adaptPromptForPi(ctx);
    }
}
/**
 * Describe the capabilities map in a doctor-ready one-liner.
 *   All-available → "claude:gemini:codex available; ratio 1:1:1 achievable"
 *   Missing codex → "claude+gemini available; codex missing; ratio 1:0:1 achievable"
 */
export function describeCapabilities(caps) {
    const avail = PRIMARY_PROVIDERS.filter((p) => caps[p].available);
    const miss = PRIMARY_PROVIDERS.filter((p) => !caps[p].available);
    const ratio = PRIMARY_PROVIDERS.map((p) => caps[p].available ? '1' : '0').join(':');
    const parts = [];
    parts.push(avail.length > 0 ? `${avail.join('+')} available` : 'no CLIs available');
    if (miss.length > 0)
        parts.push(`${miss.join('+')} missing`);
    parts.push(`ratio ${ratio} achievable`);
    if (caps.pi.available)
        parts.push('pi fallback available');
    return parts.join('; ');
}
//# sourceMappingURL=model-diversity.js.map