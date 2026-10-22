/**
 * Model selection for Pi lanes. Pi runs a model either on one of the user's
 * own provider logins (a "direct" route, such as `xai/grok-4.7` on a SuperGrok
 * plan) or on the metered Vercel AI Gateway. Which models a login can run
 * changes with the plan, and the gateway's top models change weekly, so the
 * flywheel discovers the working routes, ranks them per role, and asks the
 * user instead of pinning ids.
 */
import { z } from 'zod';
import type { ExecFn } from './exec.js';
import { GEMINI_GATEWAY_ID, GEMINI_LANE_MODEL, PI_GATEWAY_PROVIDER } from './model-detection.js';
export declare const GATEWAY_CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";
export declare const GATEWAY_LEADERBOARD_URL = "https://vercel.com/api/ai/leaderboard-export?dataset=models&modality=text&format=json";
export { GEMINI_GATEWAY_ID, GEMINI_LANE_MODEL, PI_GATEWAY_PROVIDER };
export declare const PI_LANE_ROLES: readonly ["robustness", "ergonomics", "implementer"];
export type PiLaneRole = (typeof PI_LANE_ROLES)[number];
/**
 * Planners get each lab's most capable model; implementers get the model
 * people actually run day to day, which trades some depth for speed and cost.
 */
export type PiModelProfile = 'frontier' | 'balanced';
export declare const PI_ROLE_PROFILE: Record<PiLaneRole, PiModelProfile>;
/**
 * Gateway ids reach shell commands, and Pi reads a `:<level>` suffix on
 * `--model` as a thinking level, so only plain id characters pass.
 */
export declare const GATEWAY_MODEL_ID_PATTERN: RegExp;
export declare const MAX_IMPLEMENTER_PICKS = 3;
declare const GatewayModelSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    type: z.ZodOptional<z.ZodString>;
    owned_by: z.ZodOptional<z.ZodString>;
    released: z.ZodOptional<z.ZodNumber>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    context_window: z.ZodOptional<z.ZodNumber>;
    deprecated_at: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>>;
    pricing: z.ZodOptional<z.ZodObject<{
        input: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        output: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type GatewayModel = z.infer<typeof GatewayModelSchema>;
declare const LeaderboardRowSchema: z.ZodObject<{
    date: z.ZodString;
    name: z.ZodString;
    metric: z.ZodString;
    share_percent: z.ZodNumber;
}, z.core.$strip>;
type LeaderboardRow = z.infer<typeof LeaderboardRowSchema>;
declare const GatewaySnapshotSchema: z.ZodObject<{
    version: z.ZodLiteral<2>;
    fetchedAt: z.ZodString;
    catalog: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        type: z.ZodOptional<z.ZodString>;
        owned_by: z.ZodOptional<z.ZodString>;
        released: z.ZodOptional<z.ZodNumber>;
        tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
        context_window: z.ZodOptional<z.ZodNumber>;
        deprecated_at: z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>>;
        pricing: z.ZodOptional<z.ZodObject<{
            input: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            output: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    tokenShare: z.ZodRecord<z.ZodString, z.ZodNumber>;
    spendShare: z.ZodRecord<z.ZodString, z.ZodNumber>;
}, z.core.$strip>;
export type GatewaySnapshot = z.infer<typeof GatewaySnapshotSchema>;
type RankingInput = Pick<GatewaySnapshot, 'catalog' | 'tokenShare' | 'spendShare'>;
declare const ProbeSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    detail: z.ZodString;
    checkedAt: z.ZodString;
}, z.core.$strip>;
export type PiRouteProbe = z.infer<typeof ProbeSchema>;
export type PiModelPicks = Partial<Record<PiLaneRole, {
    piModels: string[];
    chosenAt: string;
}>>;
/** A model Pi can run on one of the user's own provider logins. */
export interface PiDirectRoute {
    provider: string;
    model: string;
    /** The value for `pi --model`. */
    piModel: string;
    /** The gateway catalog entry that carries this model's price, release, and usage. */
    gatewayId: string;
    /** `pi --model` for the `-fast`/`-highspeed` variant on the same login, when it runs. */
    fastPiModel: string | null;
    /** `oauth` for an account login, `api_key` for a key; null when Pi doesn't say. */
    authType: string | null;
}
export interface PiModelCandidate {
    /** The value for `pi --model`. */
    piModel: string;
    route: 'direct' | 'gateway';
    /** The Pi provider: a login such as `xai`, or `vercel-ai-gateway`. */
    provider: string;
    gatewayId: string;
    name: string;
    lab: string;
    tokenSharePercent: number | null;
    spendSharePercent: number | null;
    released: string | null;
    contextWindow: number | null;
    inputPerMTok: number | null;
    outputPerMTok: number | null;
    isNew: boolean;
    /** Output price over the lab's reference price, or null when either is unknown. */
    tierRatio: number | null;
    /** `pi --model` for the speed variant on the same route, or null. */
    fastPiModel: string | null;
    authType: string | null;
}
export interface PiModelOption {
    label: string;
    description: string;
    piModel: string;
}
export interface PiModelQuestion {
    role: PiLaneRole;
    question: string;
    header: string;
    multiSelect: boolean;
    options: PiModelOption[];
}
export declare function toPiModel(gatewayId: string): string;
export declare function providerOf(piModel: string): string;
/** Agent lanes need tool calls; batch, free, and excluded-lab models don't fit a live pane. */
export declare function isLaneEligible(model: GatewayModel, now: Date): boolean;
/** Mean share per model name over the latest `SHARE_WINDOW_DAYS` dates of one metric. */
export declare function summarizeShare(rows: readonly LeaderboardRow[], metric: 'tokens' | 'spend'): Record<string, number>;
/** Parse `pi --list-models`: a header row, then `provider model context max-out thinking images`. */
export declare function parsePiModelList(stdout: string): Array<{
    provider: string;
    model: string;
}>;
/**
 * The gateway entry for a model a login lists. Most share the slug after the
 * lab prefix (`xai/grok-4.7` ↔ `spacexai/grok-4.7`); a few drop a brand
 * prefix (`kimi-coding/k3` ↔ `moonshotai/kimi-k3`), matched only when unique.
 */
export declare function matchGatewayModel(model: string, catalog: readonly GatewayModel[]): GatewayModel | undefined;
/**
 * Every model a Pi lane could run: each working direct route, plus one
 * gateway candidate per usage family (the newest dated snapshot stands for its
 * family) when gateway credentials are ready.
 */
export declare function buildPiCandidates(snapshot: RankingInput, opts: {
    now: Date;
    directRoutes: readonly PiDirectRoute[];
    gatewayReady: boolean;
}): PiModelCandidate[];
/**
 * One candidate per lab, ordered for the profile. Direct routes come first,
 * since the user already pays for those logins; gateway models follow for
 * labs no login covers. Within a lab, an account login (`oauth`) beats an API
 * key, which usually bills per token, and models below the profile's tier
 * floor drop out. Frontier orders labs by their flagship's list price, and
 * its gateway list keeps only labs people pay for. Balanced orders by gateway
 * token share, then recency, and its gateway list keeps only models with
 * usage or new ones.
 */
export declare function rankPiModels(candidates: readonly PiModelCandidate[], opts: {
    profile: PiModelProfile;
    limit?: number;
}): PiModelCandidate[];
/**
 * One AskUserQuestion payload per role, from the ranking for that role's
 * profile. The role's last picks lead while a route still runs them, even
 * when the ranking leaves them out. Otherwise a single-select role defaults
 * to a lab no earlier question in the same call defaults to, so the two
 * deep-plan Pi planners start on different labs. The implementer question
 * recommends its top two.
 */
export declare function buildPiModelQuestions(roles: readonly PiLaneRole[], ranked: Readonly<Partial<Record<PiModelProfile, readonly PiModelCandidate[]>>>, picks: PiModelPicks, all?: readonly PiModelCandidate[]): PiModelQuestion[];
export type ResolvedPick = {
    ok: true;
    piModel: string;
    name: string;
} | {
    ok: false;
    suggestions: string[];
};
/**
 * Accept an option label, a model name, a `pi --model` value, or a gateway id.
 * Candidates win, in the order given, so passing the ranked lists first
 * resolves the exact labels the questions showed. Then any model a working
 * login lists, then the gateway.
 */
export declare function resolvePiModelAnswer(answer: string, sources: {
    candidates: readonly PiModelCandidate[];
    directModels: readonly {
        provider: string;
        model: string;
    }[];
    catalog: readonly GatewayModel[];
    now: Date;
}): ResolvedPick;
export interface LoadedSnapshot {
    snapshot: GatewaySnapshot;
    /** True when the fetch failed and an older cached copy was used. */
    stale: boolean;
    fetchError?: string;
}
/**
 * Fetch the catalog and leaderboard, reusing a cache under an hour old unless
 * `refresh` is set. When the network fails, fall back to any cached copy and
 * mark it stale; with no cache, throw.
 */
export declare function loadGatewaySnapshot(exec: ExecFn, opts: {
    cwd: string;
    signal?: AbortSignal;
    now: Date;
    refresh?: boolean;
}): Promise<LoadedSnapshot>;
/**
 * Whether the catalog the last `flywheel_pi_models` call cached still offers
 * the Gemini lane's model to agent panes. Null when nothing is cached.
 */
export declare function readGeminiLaneListing(cwd: string, now: Date): Promise<{
    listed: boolean;
    fetchedAt: string;
} | null>;
export interface ProviderAuth {
    provider: string;
    ready: boolean;
    authType: string | null;
    detail: string;
}
/**
 * `pi auth check` costs no model call. It refreshes an expired OAuth token the
 * way a Pi pane would at startup, so a login whose token lapsed overnight
 * still counts as ready.
 */
export declare function checkPiProviderAuth(exec: ExecFn, provider: string, opts: {
    cwd?: string;
    signal?: AbortSignal;
    timeout?: number;
}): Promise<ProviderAuth>;
export interface DiscoveredRoutes {
    directRoutes: PiDirectRoute[];
    /** Every model the working logins list, for answers typed in by hand. */
    directModels: Array<{
        provider: string;
        model: string;
    }>;
    providers: ProviderAuth[];
    gatewayReady: boolean;
    /** Direct routes the latest probe rejected, with Pi's reason. */
    failed: Array<{
        piModel: string;
        detail: string;
    }>;
}
/**
 * Find the direct routes that work: list Pi's models, keep the logins whose
 * credentials pass `pi auth check`, and probe each login's recent models once
 * a day, or now with `refresh`. Logins probe in parallel, four models at a
 * time each, within one shared time budget.
 */
export declare function discoverPiRoutes(exec: ExecFn, snapshot: RankingInput, opts: {
    cwd: string;
    signal?: AbortSignal;
    now: Date;
    refresh?: boolean;
    probeScope?: string;
}): Promise<DiscoveredRoutes>;
export declare function readPiModelPicks(cwd: string): Promise<PiModelPicks>;
export declare function writePiModelPicks(cwd: string, updates: Partial<Record<PiLaneRole, string[]>>, now: Date): Promise<PiModelPicks>;
/**
 * Pi counts as a ready lane when any route it would use has credentials: the
 * gateway, or a login behind the user's last picks or a passing probe.
 */
export declare function checkPiLaneReady(exec: ExecFn, opts: {
    cwd?: string;
    signal?: AbortSignal;
    timeout?: number;
    probeScope?: string;
}): Promise<{
    ready: boolean;
    detail: string;
}>;
//# sourceMappingURL=pi-models.d.ts.map