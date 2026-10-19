/**
 * Model selection for Pi lanes. Pi reaches models through the Vercel AI
 * Gateway, whose public catalog and usage leaderboard change weekly, so the
 * flywheel ranks the live lists and asks the user instead of pinning ids.
 */
import { z } from 'zod';
import type { ExecFn } from './exec.js';
export declare const PI_GATEWAY_PROVIDER = "vercel-ai-gateway";
export declare const GATEWAY_CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";
export declare const GATEWAY_LEADERBOARD_URL = "https://vercel.com/api/ai/leaderboard-export?dataset=models&modality=text&format=json";
export declare const PI_LANE_ROLES: readonly ["robustness", "ergonomics", "implementer"];
export type PiLaneRole = (typeof PI_LANE_ROLES)[number];
/**
 * Gateway ids reach shell commands, and Pi reads a `:<level>` suffix on
 * `--model` as a thinking level, so only plain id characters pass.
 */
export declare const GATEWAY_MODEL_ID_PATTERN: RegExp;
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
    version: z.ZodLiteral<1>;
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
}, z.core.$strip>;
export type GatewaySnapshot = z.infer<typeof GatewaySnapshotSchema>;
export type PiModelPicks = Partial<Record<PiLaneRole, {
    id: string;
    chosenAt: string;
}>>;
export interface PiModelCandidate {
    id: string;
    /** The value for `pi --model`. */
    piModel: string;
    name: string;
    lab: string;
    tokenSharePercent: number | null;
    released: string | null;
    contextWindow: number | null;
    inputPerMTok: number | null;
    outputPerMTok: number | null;
    isNew: boolean;
    fastVariantId: string | null;
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
    multiSelect: false;
    options: PiModelOption[];
}
export declare function toPiModel(id: string): string;
/** Agent lanes need tool calls; batch, free, and excluded-lab models don't fit a live pane. */
export declare function isLaneEligible(model: GatewayModel, now: Date): boolean;
/** Mean token share per model name over the latest `SHARE_WINDOW_DAYS` dates. */
export declare function summarizeTokenShare(rows: readonly LeaderboardRow[]): Record<string, number>;
/**
 * Rank lane-eligible models by recent gateway token share. A dated snapshot
 * (`x-1017`) and its undated base (`x`) count as one family, represented by
 * the newest release, so a fresh snapshot inherits its family's usage. Models
 * released in the last two weeks that the leaderboard hasn't caught up with
 * follow the ranked list, marked `isNew`.
 */
export declare function rankPiModels(snapshot: Pick<GatewaySnapshot, 'catalog' | 'tokenShare'>, opts: {
    now: Date;
    limit?: number;
}): PiModelCandidate[];
/**
 * One AskUserQuestion payload per role. The first option is the role's last
 * pick when the catalog still lists it. Otherwise it is the top candidate
 * from a lab no earlier question in the same call defaults to, so the two
 * deep-plan Pi planners start on different labs. The default's fast variant
 * follows it.
 */
export declare function buildPiModelQuestions(roles: readonly PiLaneRole[], candidates: readonly PiModelCandidate[], snapshot: Pick<GatewaySnapshot, 'catalog' | 'tokenShare'>, picks: PiModelPicks): PiModelQuestion[];
export type ResolvedPick = {
    ok: true;
    id: string;
    piModel: string;
    name: string;
} | {
    ok: false;
    suggestions: string[];
};
/** Accept an option label, a catalog name, a gateway id, or a `vercel-ai-gateway/` model. */
export declare function resolvePiModelAnswer(answer: string, catalog: readonly GatewayModel[]): ResolvedPick;
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
export declare function readPiModelPicks(cwd: string): Promise<PiModelPicks>;
export declare function writePiModelPicks(cwd: string, updates: Partial<Record<PiLaneRole, string>>, now: Date): Promise<PiModelPicks>;
/** `pi auth check` only reads credentials, so one call covers every gateway model. */
export declare function checkPiGatewayAuth(exec: ExecFn, opts: {
    cwd?: string;
    signal?: AbortSignal;
    timeout?: number;
}): Promise<{
    ready: boolean;
    detail: string;
}>;
export {};
//# sourceMappingURL=pi-models.d.ts.map