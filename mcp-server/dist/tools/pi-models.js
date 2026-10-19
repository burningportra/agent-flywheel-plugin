import { z } from 'zod';
import { DEFAULT_HINTS, DEFAULT_RETRYABLE, DEFAULT_TRY_THIS, errMsg } from '../errors.js';
import { GATEWAY_CATALOG_URL, GATEWAY_LEADERBOARD_URL, MAX_IMPLEMENTER_PICKS, PI_GATEWAY_PROVIDER, PI_LANE_ROLES, PI_ROLE_PROFILE, buildPiCandidates, buildPiModelQuestions, checkPiProviderAuth, discoverPiRoutes, loadGatewaySnapshot, providerOf, rankPiModels, readPiModelPicks, resolvePiModelAnswer, writePiModelPicks, } from '../pi-models.js';
import { resolveSwarmLane } from '../swarm-host.js';
import { makeToolResult } from './shared.js';
const TOOL_NAME = 'flywheel_pi_models';
const RoleSchema = z.enum(PI_LANE_ROLES);
const AnswerSchema = z.string().min(1).max(400);
export const PiModelsInputSchema = z.object({
    cwd: z.string().min(1),
    action: z.enum(['list', 'choose']).default('list'),
    roles: z.array(RoleSchema).min(1).max(3).optional(),
    picks: z.partialRecord(RoleSchema, z.union([AnswerSchema, z.array(AnswerSchema).min(1).max(MAX_IMPLEMENTER_PICKS)])).optional(),
    refresh: z.boolean().optional(),
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
/** A multi-select answer arrives as one comma-separated string. */
function answersFor(role, value) {
    const values = Array.isArray(value) ? value : [value];
    return role === 'implementer'
        ? values.flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean)
        : values;
}
/** One line per login and reason, since a lapsed plan rejects every model the same way. */
function failureLines(failed) {
    const groups = new Map();
    for (const { piModel, detail } of failed) {
        const key = `${providerOf(piModel)}\n${detail.slice(0, 120)}`;
        groups.set(key, [...(groups.get(key) ?? []), piModel.slice(piModel.indexOf('/') + 1)]);
    }
    return [...groups].map(([key, models]) => {
        const [provider, detail] = key.split('\n');
        return `- ${provider}: ${models.join(', ')}: ${detail}`;
    });
}
function candidateLine(candidate, index) {
    const route = candidate.route === 'direct' ? `your ${candidate.provider} login` : 'gateway, metered';
    return `${index + 1}. ${candidate.name} (${candidate.piModel}, ${route})`;
}
/**
 * `flywheel_pi_models` finds the models a Pi lane can run on the user's own
 * logins and on the Vercel AI Gateway, ranks them per role (frontier for the
 * deep-plan planners, balanced for implementers), and returns AskUserQuestion
 * payloads (`action: "list"`). `action: "choose"` validates and remembers the
 * answers.
 */
export async function runPiModels(ctx, input) {
    const parsed = PiModelsInputSchema.safeParse({ ...input, cwd: ctx.cwd });
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return fail(ctx, 'invalid_input', `${TOOL_NAME}: ${issue?.message ?? 'invalid input'}`, {
            hint: 'Pass action="list" with roles, or action="choose" with picks keyed by role (robustness, ergonomics, implementer).',
            details: { field: issue?.path.join('.') },
        });
    }
    const args = parsed.data;
    const now = new Date();
    let loaded;
    try {
        loaded = await loadGatewaySnapshot(ctx.exec, {
            cwd: ctx.cwd,
            signal: ctx.signal,
            now,
            refresh: args.refresh,
        });
    }
    catch (err) {
        return fail(ctx, 'missing_prerequisite', errMsg(err), {
            retryable: true,
            hint: `Check that ${GATEWAY_CATALOG_URL} is reachable, then retry with refresh: true. Until it loads, treat the Pi lanes as unavailable.`,
        });
    }
    const { snapshot } = loaded;
    // Implementers run where the swarm runs, so their models must work on that Mac's logins.
    const askedRoles = args.action === 'list' ? (args.roles ?? ['implementer']) : Object.keys(args.picks ?? {});
    const lane = askedRoles.length > 0 && askedRoles.every((role) => role === 'implementer')
        ? await resolveSwarmLane(ctx.cwd, ctx.exec)
        : { exec: ctx.exec, probeScope: undefined };
    const routes = await discoverPiRoutes(lane.exec, snapshot, {
        cwd: ctx.cwd,
        signal: ctx.signal,
        now,
        refresh: args.refresh,
        probeScope: lane.probeScope,
    });
    const candidates = buildPiCandidates(snapshot, { now, directRoutes: routes.directRoutes, gatewayReady: routes.gatewayReady });
    if (candidates.length === 0) {
        return fail(ctx, 'missing_prerequisite', `${TOOL_NAME}: no Pi route is ready (${routes.providers.map((auth) => `${auth.provider} ${auth.detail}`).join('; ')})`, {
            hint: 'Log in to a provider in Pi, or set up Vercel AI Gateway credentials, then retry with refresh: true. Until then, treat the Pi lanes as unavailable.',
        });
    }
    const source = {
        catalog: GATEWAY_CATALOG_URL,
        leaderboard: GATEWAY_LEADERBOARD_URL,
        fetchedAt: snapshot.fetchedAt,
        stale: loaded.stale,
        ...(loaded.fetchError ? { fetchError: loaded.fetchError } : {}),
    };
    const routeSummary = {
        logins: routes.providers
            .filter((auth) => auth.provider !== PI_GATEWAY_PROVIDER)
            .map(({ provider, ready, authType }) => ({ provider, ready, authType })),
        gatewayReady: routes.gatewayReady,
        working: routes.directRoutes.map((route) => route.piModel),
        failed: routes.failed,
    };
    const rankFor = (roles) => Object.fromEntries([...new Set(roles.map((role) => PI_ROLE_PROFILE[role]))]
        .map((profile) => [profile, rankPiModels(candidates, { profile })]));
    if (args.action === 'list') {
        const roles = args.roles ?? ['implementer'];
        const ranked = rankFor(roles);
        const profiles = Object.keys(ranked);
        const questions = buildPiModelQuestions(roles, ranked, await readPiModelPicks(ctx.cwd), candidates);
        const lines = [
            `Pi lane models (${loaded.stale ? 'cached gateway data, network fetch failed' : `gateway data fetched ${snapshot.fetchedAt}`}):`,
            ...profiles.flatMap((profile) => [
                `${profile === 'frontier' ? 'Frontier, for planners' : 'Balanced, for implementers'}:`,
                ...(ranked[profile] ?? []).map(candidateLine),
            ]),
            ...(routes.failed.length > 0
                ? ['Not runnable on your logins (rechecked daily, or now with refresh: true):', ...failureLines(routes.failed)]
                : []),
            'Pass data.questions to AskUserQuestion, then call flywheel_pi_models with action="choose" and the answers keyed by role.',
        ];
        return respond(ctx, lines.join('\n'), {
            kind: 'pi_models_listed',
            source,
            routes: routeSummary,
            candidates: ranked,
            questions,
        });
    }
    const requested = Object.entries(args.picks ?? {});
    if (requested.length === 0) {
        return fail(ctx, 'invalid_input', `${TOOL_NAME}: action="choose" needs picks keyed by role`, {
            hint: 'Pass picks like {"implementer": ["Grok 4.7 Fast", "GLM 5.3"]} using option labels or `pi --model` values.',
        });
    }
    const resolved = {};
    const ranked = rankFor(requested.map(([role]) => role));
    for (const [role, value] of requested) {
        const answers = answersFor(role, value);
        const limit = role === 'implementer' ? MAX_IMPLEMENTER_PICKS : 1;
        if (answers.length === 0 || answers.length > limit) {
            return fail(ctx, 'invalid_input', `${TOOL_NAME}: ${role} takes ${limit === 1 ? 'one model' : `1 to ${limit} models`}, got ${answers.length}`, {
                details: { role, answers },
            });
        }
        const piModels = [];
        for (const answer of answers) {
            const match = resolvePiModelAnswer(answer, {
                candidates: [...(ranked[PI_ROLE_PROFILE[role]] ?? []), ...candidates],
                directModels: routes.directModels,
                catalog: snapshot.catalog,
                now,
            });
            if (!match.ok) {
                return fail(ctx, 'invalid_input', `${TOOL_NAME}: "${answer}" is not a model your logins or the gateway list`, {
                    hint: match.suggestions.length > 0
                        ? `Did you mean one of: ${match.suggestions.join(', ')}?`
                        : `Use a \`pi --model\` value such as xai/grok-4.7 or vercel-ai-gateway/deepseek/deepseek-v4.1-flash-1017 (see pi --list-models).`,
                    details: { role, answer, suggestions: match.suggestions },
                });
            }
            if (!piModels.includes(match.piModel))
                piModels.push(match.piModel);
        }
        resolved[role] = piModels;
    }
    const chosenProviders = [...new Set(Object.values(resolved).flatMap((models) => models?.map(providerOf) ?? []))];
    const auths = await Promise.all(chosenProviders.map((provider) => checkPiProviderAuth(lane.exec, provider, { cwd: ctx.cwd, signal: ctx.signal })));
    const notReady = auths.filter((auth) => !auth.ready);
    try {
        await writePiModelPicks(ctx.cwd, resolved, now);
    }
    catch (err) {
        return fail(ctx, 'internal_error', `${TOOL_NAME}: could not save the picks: ${errMsg(err)}`, {
            hint: 'Check that .pi-flywheel/ is writable, then retry.',
        });
    }
    const piModels = Object.fromEntries(Object.entries(resolved).map(([role, models]) => [role, (models ?? []).join(',')]));
    const summary = Object.entries(piModels).map(([role, models]) => `${role}: ${models}`).join(', ');
    const authDetail = notReady.length === 0
        ? 'ready'
        : notReady.map((auth) => `${auth.provider} ${auth.detail}`).join('; ');
    return respond(ctx, `Pi lane models: ${summary}. pi auth check: ${notReady.length === 0 ? 'ready' : `not ready (${authDetail})`}.`, {
        kind: 'pi_models_chosen',
        piModels,
        picks: resolved,
        piReady: notReady.length === 0,
        authDetail,
        source,
    });
}
//# sourceMappingURL=pi-models.js.map