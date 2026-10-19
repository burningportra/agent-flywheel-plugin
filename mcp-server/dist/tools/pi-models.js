import { z } from 'zod';
import { DEFAULT_HINTS, DEFAULT_RETRYABLE, DEFAULT_TRY_THIS, errMsg } from '../errors.js';
import { GATEWAY_CATALOG_URL, GATEWAY_LEADERBOARD_URL, PI_GATEWAY_PROVIDER, PI_LANE_ROLES, buildPiModelQuestions, checkPiGatewayAuth, loadGatewaySnapshot, rankPiModels, readPiModelPicks, resolvePiModelAnswer, writePiModelPicks, } from '../pi-models.js';
import { makeToolResult } from './shared.js';
const TOOL_NAME = 'flywheel_pi_models';
const RoleSchema = z.enum(PI_LANE_ROLES);
export const PiModelsInputSchema = z.object({
    cwd: z.string().min(1),
    action: z.enum(['list', 'choose']).default('list'),
    roles: z.array(RoleSchema).min(1).max(3).optional(),
    picks: z.partialRecord(RoleSchema, z.string().min(1).max(200)).optional(),
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
/**
 * `flywheel_pi_models` ranks the Vercel AI Gateway models a Pi lane can run
 * and returns AskUserQuestion payloads (`action: "list"`), then validates and
 * remembers the user's answers (`action: "choose"`).
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
    const source = {
        catalog: GATEWAY_CATALOG_URL,
        leaderboard: GATEWAY_LEADERBOARD_URL,
        fetchedAt: snapshot.fetchedAt,
        stale: loaded.stale,
        ...(loaded.fetchError ? { fetchError: loaded.fetchError } : {}),
    };
    if (args.action === 'list') {
        const roles = args.roles ?? ['implementer'];
        const picks = await readPiModelPicks(ctx.cwd);
        const candidates = rankPiModels(snapshot, { now });
        const questions = buildPiModelQuestions(roles, candidates, snapshot, picks);
        const lines = [
            `Top Pi lane models on ${PI_GATEWAY_PROVIDER} (${loaded.stale ? 'cached copy, network fetch failed' : `fetched ${snapshot.fetchedAt}`}):`,
            ...candidates.map((candidate, i) => `${i + 1}. ${candidate.name} (${candidate.piModel})${candidate.tokenSharePercent !== null ? `, ${candidate.tokenSharePercent}% of tokens` : candidate.isNew ? ', new' : ''}`),
            'Pass data.questions to AskUserQuestion, then call flywheel_pi_models with action="choose" and the answers keyed by role.',
        ];
        return respond(ctx, lines.join('\n'), {
            kind: 'pi_models_listed',
            provider: PI_GATEWAY_PROVIDER,
            source,
            candidates,
            questions,
        });
    }
    const requested = Object.entries(args.picks ?? {});
    if (requested.length === 0) {
        return fail(ctx, 'invalid_input', `${TOOL_NAME}: action="choose" needs picks keyed by role`, {
            hint: 'Pass picks like {"implementer": "DeepSeek V4.1 Flash 1017"} using the option label or a gateway model id.',
        });
    }
    const resolved = {};
    const piModels = {};
    for (const [role, answer] of requested) {
        const match = resolvePiModelAnswer(answer, snapshot.catalog);
        if (!match.ok) {
            return fail(ctx, 'invalid_input', `${TOOL_NAME}: "${answer}" is not a model the gateway lists`, {
                hint: match.suggestions.length > 0
                    ? `Did you mean one of: ${match.suggestions.join(', ')}?`
                    : `Use a gateway model id such as deepseek/deepseek-v4.1-flash-1017 (see ${GATEWAY_CATALOG_URL}).`,
                details: { role, answer, suggestions: match.suggestions },
            });
        }
        resolved[role] = match.id;
        piModels[role] = match.piModel;
    }
    const auth = await checkPiGatewayAuth(ctx.exec, { cwd: ctx.cwd, signal: ctx.signal });
    try {
        await writePiModelPicks(ctx.cwd, resolved, now);
    }
    catch (err) {
        return fail(ctx, 'internal_error', `${TOOL_NAME}: could not save the picks: ${errMsg(err)}`, {
            hint: 'Check that .pi-flywheel/ is writable, then retry.',
        });
    }
    const summary = Object.entries(piModels).map(([role, model]) => `${role}: ${model}`).join(', ');
    return respond(ctx, `Pi lane models: ${summary}. pi auth check for ${PI_GATEWAY_PROVIDER}: ${auth.ready ? 'ready' : `not ready (${auth.detail})`}.`, {
        kind: 'pi_models_chosen',
        provider: PI_GATEWAY_PROVIDER,
        piModels,
        piReady: auth.ready,
        authDetail: auth.detail,
        source,
    });
}
//# sourceMappingURL=pi-models.js.map