import { formatRepoProfile, makeNextToolStep, makeToolResult } from './shared.js';
import { profileRepo, loadCachedProfile, saveCachedProfile } from '../profiler.js';
import { parseBrList } from '../parsers.js';
import { createLogger } from '../logger.js';
import { runOpeningCeremony } from '../opening-ceremony.js';
import { VERSION } from '../version.js';
import { errMsg, makeFlywheelErrorResult } from '../errors.js';
const log = createLogger('profile');
/**
 * flywheel_profile — Scan the current repo and build a profile.
 *
 * Runs git log, finds key files, detects language/framework/CI/test tooling.
 * Detects the br CLI (beads) for coordination backend.
 * Returns a structured profile and discovery instructions.
 *
 * Uses a git-HEAD-keyed cache to skip redundant scans. Pass force=true to bypass.
 */
export async function runProfile(ctx, args) {
    const { exec, cwd, state, saveState, signal } = ctx;
    state.phase = 'profiling';
    // ── Opening ceremony (shows version banner) ──────────────────
    const ceremonyWriter = { write: async (text) => { log.info(text); } };
    const ceremonyResult = await runOpeningCeremony(ceremonyWriter, { interactive: false });
    const ceremonyBanner = `░▒▓ CLAUDE // AGENT-FLYWHEEL v${VERSION} ▓▒░`;
    // ── Try cache first (unless forced) ──────────────────────────
    let profile;
    let fromCache = false;
    if (!args.force) {
        let cached;
        try {
            cached = await loadCachedProfile(exec, cwd);
        }
        catch (err) {
            return makeFlywheelErrorResult('flywheel_profile', state.phase, {
                code: 'parse_failure',
                message: 'Failed to load cached profile.',
                retryable: true,
                hint: 'Pass force:true to bypass cache',
                cause: errMsg(err),
            });
        }
        if (cached) {
            profile = cached;
            fromCache = true;
        }
        else {
            try {
                profile = await profileRepo(exec, cwd);
            }
            catch (err) {
                return makeFlywheelErrorResult('flywheel_profile', state.phase, {
                    code: 'cli_failure',
                    message: 'Failed to profile repository.',
                    hint: 'Verify required CLIs (`git`, `find`, `grep`, `head`) are available, then retry.',
                    cause: errMsg(err),
                });
            }
            // Fire-and-forget: don't block return on cache write
            saveCachedProfile(exec, cwd, profile).catch(() => { });
        }
    }
    else {
        try {
            profile = await profileRepo(exec, cwd);
        }
        catch (err) {
            return makeFlywheelErrorResult('flywheel_profile', state.phase, {
                code: 'cli_failure',
                message: 'Failed to profile repository.',
                hint: 'Verify required CLIs (`git`, `find`, `grep`, `head`) are available, then retry.',
                cause: errMsg(err),
            });
        }
        saveCachedProfile(exec, cwd, profile).catch(() => { });
    }
    // ── Detect coordination backends ──────────────────────────────
    const brResult = await exec('br', ['--version'], { cwd, timeout: 5000, signal });
    const hasBeads = brResult.code === 0;
    const coordinationBackend = {
        beads: hasBeads,
        agentMail: false, // agent-mail detection out of scope for MCP
        sophia: false,
    };
    const coordinationStrategy = hasBeads ? 'beads' : 'bare';
    state.repoProfile = profile;
    state.coordinationBackend = coordinationBackend;
    state.coordinationStrategy = coordinationStrategy;
    state.coordinationMode ??= 'worktree';
    if (args.goal)
        state.selectedGoal = args.goal;
    state.phase = 'discovering';
    saveState(state);
    // ── Foundation gaps ───────────────────────────────────────────
    const foundationGaps = [];
    const hasAgentsMd = profile.keyFiles && Object.keys(profile.keyFiles).some(f => f.toLowerCase().includes('agents.md'));
    if (!hasAgentsMd)
        foundationGaps.push('- No AGENTS.md found. Consider creating one for agent guidance.');
    if (!profile.hasTests)
        foundationGaps.push('- No test framework detected.');
    if (!profile.hasCI)
        foundationGaps.push('- No CI tooling detected.');
    if (profile.recentCommits.length === 0)
        foundationGaps.push('- No git history detected.');
    const foundationWarning = foundationGaps.length > 0
        ? `\n\n### Foundation Gaps\n${foundationGaps.join('\n')}`
        : '';
    // ── Beads status ──────────────────────────────────────────────
    let beadStatus = '';
    let openBeadCount = 0;
    let deferredBeadCount = 0;
    if (hasBeads) {
        const brListResult = await exec('br', ['list', '--json'], { cwd, timeout: 10000, signal });
        if (brListResult.code === 0) {
            const parsed = parseBrList(brListResult.stdout);
            if (parsed.ok) {
                const open = parsed.data.filter(b => b.status === 'open' || b.status === 'in_progress');
                const deferred = parsed.data.filter(b => b.status === 'deferred');
                openBeadCount = open.length;
                deferredBeadCount = deferred.length;
                if (open.length > 0 || deferred.length > 0) {
                    beadStatus = `\n\n### Existing Beads\n- ${open.length} open/in-progress\n- ${deferred.length} deferred`;
                    if (open.length > 0) {
                        beadStatus += `\n\nTo work on existing beads, call \`flywheel_approve_beads\` with action="start".`;
                    }
                }
            }
            else {
                log.warn('Failed to parse br list output', { error: parsed.error });
            }
        }
    }
    const coordLine = hasBeads
        ? `Coordination: beads (br CLI detected)`
        : `Coordination: bare (no beads CLI detected — run \`br init\` to enable task tracking)`;
    const roadmap = `**Workflow:** profile → discover → select → plan → approve_beads → implement → review`;
    const goalSection = args.goal
        ? `\n\n### Goal\n${args.goal}\n\nSince a goal was provided, you can skip discovery and call \`flywheel_select\` directly with this goal, or call \`flywheel_discover\` to generate alternatives.`
        : `\n\n### Next Step\nCall \`flywheel_discover\` with 5-15 project ideas based on this profile.`;
    const formatted = formatRepoProfile(profile);
    const cacheNote = fromCache
        ? `\n\n> Profile loaded from cache (git HEAD unchanged). Pass \`force: true\` to re-scan.`
        : '';
    const text = `${ceremonyBanner}\n\n${roadmap}\n\n${coordLine}${cacheNote}${foundationWarning}${beadStatus}${goalSection}\n\n---\n\n${formatted}`;
    const nextStep = args.goal
        ? makeNextToolStep('present_choices', 'A goal was provided. Either proceed directly to flywheel_select or run flywheel_discover to generate alternatives.', {
            options: [
                {
                    id: 'select-provided-goal',
                    label: 'Use the provided goal',
                    description: 'Skip discovery and continue with flywheel_select using the supplied goal.',
                    tool: 'flywheel_select',
                    args: { goal: args.goal },
                },
                {
                    id: 'discover-alternatives',
                    label: 'Discover alternatives',
                    description: 'Generate alternative goals with flywheel_discover before selecting one.',
                    tool: 'flywheel_discover',
                    args: { ideas: 'CandidateIdea[]' },
                },
            ],
        })
        : makeNextToolStep('call_tool', 'Call flywheel_discover with candidate ideas based on the repo profile.', {
            tool: 'flywheel_discover',
            argsSchemaHint: { ideas: 'CandidateIdea[]' },
        });
    return makeToolResult(text, {
        tool: 'flywheel_profile',
        version: 1,
        status: 'ok',
        phase: state.phase,
        nextStep,
        data: {
            kind: 'profile_ready',
            fromCache,
            selectedGoal: state.selectedGoal,
            coordination: {
                backend: coordinationStrategy,
                beadsAvailable: hasBeads,
            },
            foundationGaps,
            existingBeads: {
                openCount: openBeadCount,
                deferredCount: deferredBeadCount,
            },
            profileSummary: {
                name: profile.name,
                languages: profile.languages,
                frameworks: profile.frameworks,
                hasTests: profile.hasTests,
                hasDocs: profile.hasDocs,
                hasCI: profile.hasCI,
                testFramework: profile.testFramework,
                ciPlatform: profile.ciPlatform,
                entrypoints: profile.entrypoints,
            },
        },
    });
}
//# sourceMappingURL=profile.js.map