import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { detectCliCapabilities, swarmMixFor } from '../adapters/model-diversity.js';
import { DEFAULT_HINTS, DEFAULT_RETRYABLE, DEFAULT_TRY_THIS, errMsg } from '../errors.js';
import { readGeminiLaneListing } from '../pi-models.js';
import { buildSwarmHostQuestion, collectWave, findHostCandidates, hostBlockers, hostSlug, makeSshExec, matchHostPick, prepareSwarmHost, probeHost, probeThisMac, pushToSwarmHost, readSwarmHost, releaseSwarmHost, THIS_MAC_LABEL, } from '../swarm-host.js';
import { makeToolResult } from './shared.js';
const TOOL_NAME = 'flywheel_swarm_host';
export const SwarmHostInputSchema = z.object({
    cwd: z.string().min(1),
    action: z.enum(['list', 'choose', 'sync', 'release']).default('list'),
    /** A `list` question's answer, or a hostname. */
    pick: z.string().min(1).max(200).optional(),
    coordinatorName: z.string().min(1).max(100).optional(),
});
function respond(ctx, text, data) {
    return makeToolResult(text, {
        tool: TOOL_NAME,
        version: 1,
        status: 'ok',
        phase: ctx.state.phase,
        data,
    });
}
function fail(ctx, code, message, options = {}) {
    const result = makeToolResult(`Error: ${message}`, {
        tool: TOOL_NAME,
        version: 1,
        status: 'error',
        phase: ctx.state.phase,
        data: {
            kind: 'error',
            error: {
                code,
                message,
                retryable: options.retryable ?? DEFAULT_RETRYABLE[code],
                hint: options.hint ?? DEFAULT_HINTS[code],
                try_this: DEFAULT_TRY_THIS[code],
                ...(options.details ? { details: options.details } : {}),
                timestamp: new Date().toISOString(),
            },
        },
    });
    return { ...result, isError: true };
}
const failSync = (ctx, failure) => fail(ctx, failure.code, failure.message, {
    hint: failure.hint,
    retryable: failure.reason === 'host_unreachable' || failure.code === 'cli_failure',
    details: { reason: failure.reason, ...failure.details },
});
/** The command the coordinator prefixes to run something in the host's clone (or here, with no host). */
export function runCommandFor(cwd) {
    const script = fileURLToPath(new URL('../scripts/swarm-host.js', import.meta.url));
    return `node "${script}" run --checkout "${cwd}" --`;
}
function summarizeProbe(probe) {
    return probe.ok
        ? {
            name: probe.candidate.name,
            host: probe.candidate.host,
            reachable: true,
            cores: probe.cores,
            memGB: probe.memGB,
            load: probe.load,
            onBattery: probe.onBattery,
            batteryPercent: probe.batteryPercent,
            diskFreeGB: probe.diskFreeGB,
            agentMail: probe.agentMail,
            blockers: hostBlockers(probe),
        }
        : { name: probe.candidate.name, host: probe.candidate.host, reachable: false, blockers: hostBlockers(probe) };
}
function describeHost(host) {
    return { name: host.name, host: host.host, repoPath: host.repoPath, ntmProject: host.ntmProject, localBranch: host.localBranch };
}
/** The lanes a six-pane swarm gets on the host, with the Gemini catalog check the doctor applies. */
async function hostSwarmMix(ctx, host) {
    const exec = makeSshExec(ctx.exec, host, host.repoPath);
    let caps = await detectCliCapabilities(exec, {
        cwd: ctx.cwd,
        signal: ctx.signal,
        probeScope: hostSlug(host.host),
        verifyClaudeLogin: true,
    });
    const listing = await readGeminiLaneListing(ctx.cwd, new Date());
    if (caps.gemini.available && listing && !listing.listed) {
        caps = { ...caps, gemini: { ...caps.gemini, available: false, reason: 'gemini-4-argon is no longer in the cached gateway catalog' } };
    }
    const warnings = caps.claude.path && !caps.claude.available
        ? [`Claude Code isn't logged in for SSH sessions on ${host.name} (its login lives in the Keychain, which they can't read), so the swarm there runs without cc panes. To add them, run \`claude setup-token\` on that Mac and export CLAUDE_CODE_OAUTH_TOKEN in its ~/.zshenv.`]
        : [];
    return { mix: swarmMixFor(caps) ?? null, warnings };
}
async function discover(ctx) {
    const candidates = await findHostCandidates(ctx.exec, ctx.signal);
    return Promise.all(candidates.map((candidate) => probeHost(ctx.exec, candidate, ctx.signal)));
}
/**
 * `flywheel_swarm_host` picks the Mac a swarm runs on. `list` finds Macs on
 * the local network that answer SSH and returns the AskUserQuestion payload;
 * `choose` prepares the picked Mac (a clone under its ntm projects_base, this
 * checkout's commits and beads, a keep-awake) or switches back to this Mac;
 * `sync` pulls the swarm's work back and pushes this checkout's; `release`
 * pulls one last time and forgets the host.
 */
export async function runSwarmHost(ctx, input) {
    const parsed = SwarmHostInputSchema.safeParse({ ...input, cwd: ctx.cwd });
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return fail(ctx, 'invalid_input', `${TOOL_NAME}: ${issue?.message ?? 'invalid input'}`, {
            hint: 'Pass action="list", then action="choose" with the answer as pick; action="sync" or "release" take no other input.',
            details: { field: issue?.path.join('.') },
        });
    }
    const args = parsed.data;
    const sync = { cwd: ctx.cwd, exec: ctx.exec, signal: ctx.signal };
    const current = await readSwarmHost(ctx.cwd);
    const run = runCommandFor(ctx.cwd);
    try {
        if (args.action === 'list') {
            const [local, probes] = await Promise.all([probeThisMac(ctx.exec, ctx.signal), discover(ctx)]);
            const question = buildSwarmHostQuestion(local, probes);
            const hosts = probes.map(summarizeProbe);
            const blocked = hosts.filter((host) => host.blockers.length > 0);
            const lines = question
                ? [
                    `Swarm can run here or on ${hosts.filter((host) => host.blockers.length === 0).map((host) => host.name).join(', ')}.`,
                    'Ask data.question with AskUserQuestion, then call flywheel_swarm_host with action="choose" and the answer as pick.',
                ]
                : [`No other Mac can take the swarm, so it runs here.${hosts.length === 0 ? ' None answered on the local network.' : ''}`];
            lines.push(...blocked.map((host) => `- ${host.name}: ${host.blockers.join('; ')}`));
            if (current)
                lines.push(`This checkout's swarm currently runs on ${current.name}.`);
            return respond(ctx, lines.join('\n'), {
                kind: 'swarm_hosts_listed',
                thisMac: local,
                hosts,
                question,
                current: current ? describeHost(current) : null,
            });
        }
        if (args.action === 'sync' || args.action === 'release') {
            if (!current) {
                return args.action === 'release'
                    ? respond(ctx, 'No swarm host to release; the swarm runs on this Mac.', { kind: 'swarm_host_released', released: null, pull: null })
                    : fail(ctx, 'missing_prerequisite', 'No swarm host is set for this checkout.', {
                        hint: 'Call flywheel_swarm_host({ action: "list" }) and choose one first.',
                        details: { reason: 'no_swarm_host' },
                    });
            }
            if (args.action === 'release') {
                const released = await releaseSwarmHost(sync, current, { sync: true });
                if (!released.ok)
                    return failSync(ctx, released);
                return respond(ctx, `Released ${current.name}. Its last work is merged here, and the swarm runs on this Mac from now on. The clone at ${current.repoPath} stays for next time.`, {
                    kind: 'swarm_host_released',
                    released: describeHost(current),
                    pull: released.pull,
                });
            }
            const pulled = await collectWave(sync, current);
            if (!pulled.ok)
                return failSync(ctx, pulled);
            const pushed = await pushToSwarmHost(sync, current);
            if (!pushed.ok)
                return failSync(ctx, pushed);
            return respond(ctx, `Synced with ${current.name}: commits ${pulled.commits}, beads ${pulled.beads} here and ${pushed.beads} there, head ${pushed.head.slice(0, 12)}.`, {
                kind: 'swarm_host_synced',
                host: describeHost(current),
                pull: pulled,
                push: pushed,
                run,
            });
        }
        if (!args.pick) {
            return fail(ctx, 'invalid_input', `${TOOL_NAME}: action="choose" needs pick`, {
                hint: `Pass the answer to data.question from action="list", such as "${THIS_MAC_LABEL}" or a Mac's name.`,
            });
        }
        const probes = await discover(ctx);
        const match = matchHostPick(args.pick, probes);
        if (match === null) {
            return fail(ctx, 'invalid_input', `${TOOL_NAME}: "${args.pick}" isn't a Mac that answered`, {
                hint: 'Call flywheel_swarm_host({ action: "list" }) again and pass one of its option labels.',
                details: { reason: 'unknown_host', hosts: probes.map((probe) => probe.candidate.name) },
            });
        }
        if (match === 'this_mac' || (current && current.host.toLowerCase() !== match.candidate.host.toLowerCase())) {
            if (current) {
                const released = await releaseSwarmHost(sync, current, { sync: true });
                if (!released.ok)
                    return failSync(ctx, released);
            }
            if (match === 'this_mac') {
                return respond(ctx, current ? `The swarm runs on this Mac again; ${current.name}'s work is merged here.` : 'The swarm runs on this Mac.', {
                    kind: 'swarm_host_chosen',
                    host: null,
                    run,
                });
            }
        }
        if (!match.ok) {
            return fail(ctx, 'missing_prerequisite', `${match.candidate.name} can't take a swarm: ${hostBlockers(match).join(' ')}`, {
                hint: 'Fix that, then call flywheel_swarm_host({ action: "list" }) again, or answer "This Mac".',
                details: { reason: match.reason },
            });
        }
        const prepared = await prepareSwarmHost({ ...sync, coordinatorName: args.coordinatorName }, match);
        if (!prepared.ok)
            return failSync(ctx, prepared);
        const { mix: swarm, warnings: laneWarnings } = await hostSwarmMix(ctx, prepared.host);
        const warnings = [...prepared.warnings, ...laneWarnings];
        const lines = [
            `The swarm runs on ${prepared.host.name}, in ${prepared.host.repoPath} (ntm project ${prepared.host.ntmProject}).`,
            swarm ? `Lanes there: ${swarm.label} (${swarm.spawnFlags}).` : `No implementation lane is ready on ${prepared.host.name}.`,
            `Run commands there with: ${run} <command>`,
            ...warnings.map((warning) => `Warning: ${warning}`),
        ];
        return respond(ctx, lines.join('\n'), {
            kind: 'swarm_host_chosen',
            host: describeHost(prepared.host),
            run,
            swarm,
            pull: prepared.pull,
            push: prepared.push,
            warnings,
        });
    }
    catch (err) {
        return fail(ctx, 'cli_failure', `${TOOL_NAME}: ${errMsg(err)}`, {
            retryable: true,
            hint: 'Check that the other Mac is awake and on this network, then retry.',
            details: { reason: 'exec_failed' },
        });
    }
}
//# sourceMappingURL=swarm-host.js.map