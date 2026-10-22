/**
 * Model selection for Pi lanes. Pi runs a model either on one of the user's
 * own provider logins (a "direct" route, such as `xai/grok-4.7` on a SuperGrok
 * plan) or on the metered Vercel AI Gateway. Which models a login can run
 * changes with the plan, and the gateway's top models change weekly, so the
 * flywheel discovers the working routes, ranks them per role, and asks the
 * user instead of pinning ids.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { writeAtomic } from './atomic-write.js';
import type { ExecFn } from './exec.js';
import { CURRENT_GEMINI_MODEL_ID, GEMINI_GATEWAY_ID, GEMINI_LANE_MODEL, PI_GATEWAY_PROVIDER } from './model-detection.js';

export const GATEWAY_CATALOG_URL = 'https://ai-gateway.vercel.sh/v1/models';
export const GATEWAY_LEADERBOARD_URL =
  'https://vercel.com/api/ai/leaderboard-export?dataset=models&modality=text&format=json';
export { GEMINI_GATEWAY_ID, GEMINI_LANE_MODEL, PI_GATEWAY_PROVIDER };

export const PI_LANE_ROLES = ['robustness', 'ergonomics', 'implementer'] as const;
export type PiLaneRole = (typeof PI_LANE_ROLES)[number];

/**
 * Planners get each lab's most capable model; implementers get the model
 * people actually run day to day, which trades some depth for speed and cost.
 */
export type PiModelProfile = 'frontier' | 'balanced';
export const PI_ROLE_PROFILE: Record<PiLaneRole, PiModelProfile> = {
  robustness: 'frontier',
  ergonomics: 'frontier',
  implementer: 'balanced',
};

/**
 * Gateway ids reach shell commands, and Pi reads a `:<level>` suffix on
 * `--model` as a thinking level, so only plain id characters pass.
 */
export const GATEWAY_MODEL_ID_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PI_ID_PART = /^[A-Za-z0-9._-]+$/;

const CACHE_RELATIVE_PATH = join('.pi-flywheel', 'cache', 'gateway-models.json');
const PROBE_CACHE_RELATIVE_PATH = join('.pi-flywheel', 'cache', 'pi-route-probes.json');
/** Probes record one machine's logins, so a swarm host's go in their own file. */
const probeCachePath = (scope?: string): string =>
  scope ? join('.pi-flywheel', 'cache', `pi-route-probes.${scope}.json`) : PROBE_CACHE_RELATIVE_PATH;
const PICKS_RELATIVE_PATH = join('.pi-flywheel', 'pi-models.json');
const CACHE_FRESH_MS = 60 * 60 * 1000;
const PROBE_FRESH_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const LIST_MODELS_TIMEOUT_MS = 30_000;
/** A ChatGPT-login reply takes about 25 seconds even for a one-word answer. */
const PROBE_TIMEOUT_MS = 60_000;
/** Probes still running when this budget ends count as unknown and run again next time. */
const PROBE_BUDGET_MS = 90_000;
/** Concurrent probes per login, so a burst doesn't trip the provider's rate limit. */
const PROBES_IN_FLIGHT_PER_PROVIDER = 4;
const SHARE_WINDOW_DAYS = 7;
const NEW_MODEL_DAYS = 14;
const DIRECT_MODEL_MAX_AGE_DAYS = 365;
const PROBES_PER_PROVIDER = 10;
const MAX_OPTIONS = 4;
export const MAX_IMPLEMENTER_PICKS = 3;
const DEFAULT_CANDIDATE_LIMIT = 8;

/** Labs whose models already have their own lane, plus anonymous trial models. */
const EXCLUDED_LABS = new Set(['anthropic', 'stealth']);
/** Providers that resell many labs' models per token. Every other provider is a direct login. */
const AGGREGATOR_PROVIDERS = new Set([PI_GATEWAY_PROVIDER, 'openrouter', 'opencode']);
const EXCLUDED_PROVIDERS = new Set(['anthropic']);
const SPEED_VARIANT_SUFFIX = /-(fast|highspeed)$/;
/** Labs name their small tiers this way; none of them belongs on a planner. */
const SMALL_TIER_NAME = /\b(flash|flashx|mini|nano|lite|small|lightning)\b/i;
/**
 * Minimum list price, as a fraction of the lab's reference price, for each
 * profile. The reference is the price of the lab's most-paid-for model, so a
 * pro tier above it doesn't push the lab's flagship out.
 */
const TIER_FLOOR: Record<'frontier' | 'balanced', number> = { frontier: 0.5, balanced: 0.15 };

const GatewayModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().optional(),
  owned_by: z.string().optional(),
  released: z.number().optional(),
  tags: z.array(z.string()).optional(),
  context_window: z.number().optional(),
  deprecated_at: z.union([z.number(), z.string()]).nullable().optional(),
  pricing: z.object({
    input: z.string().optional(),
    output: z.string().optional(),
  }).partial().optional(),
});
export type GatewayModel = z.infer<typeof GatewayModelSchema>;

const CatalogResponseSchema = z.object({ data: z.array(z.unknown()) });

const LeaderboardRowSchema = z.object({
  date: z.string(),
  name: z.string(),
  metric: z.string(),
  share_percent: z.number(),
});
type LeaderboardRow = z.infer<typeof LeaderboardRowSchema>;

const LeaderboardResponseSchema = z.object({ rows: z.array(z.unknown()) });

const GatewaySnapshotSchema = z.object({
  version: z.literal(2),
  fetchedAt: z.string(),
  catalog: z.array(GatewayModelSchema),
  /** Mean daily share of gateway text tokens over the last week, keyed by model name. */
  tokenShare: z.record(z.string(), z.number()),
  /** Mean daily share of gateway spend over the last week, keyed by model name. */
  spendShare: z.record(z.string(), z.number()),
});
export type GatewaySnapshot = z.infer<typeof GatewaySnapshotSchema>;
type RankingInput = Pick<GatewaySnapshot, 'catalog' | 'tokenShare' | 'spendShare'>;

const ProbeSchema = z.object({ ok: z.boolean(), detail: z.string(), checkedAt: z.string() });
export type PiRouteProbe = z.infer<typeof ProbeSchema>;
const ProbeCacheSchema = z.object({ version: z.literal(1), probes: z.record(z.string(), ProbeSchema) });

const PicksFileSchema = z.object({
  version: z.literal(2),
  picks: z.record(z.string(), z.object({ piModels: z.array(z.string()).min(1), chosenAt: z.string() })),
});
export type PiModelPicks = Partial<Record<PiLaneRole, { piModels: string[]; chosenAt: string }>>;

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

export function toPiModel(gatewayId: string): string {
  return `${PI_GATEWAY_PROVIDER}/${gatewayId}`;
}

export function providerOf(piModel: string): string {
  return piModel.slice(0, piModel.indexOf('/'));
}

function slugOf(id: string): string {
  return id.slice(id.indexOf('/') + 1);
}

function labOf(model: GatewayModel): string {
  return model.owned_by ?? model.id.split('/')[0] ?? '';
}

function perMillion(price: string | undefined): number | null {
  if (price === undefined) return null;
  const perToken = Number(price);
  return Number.isFinite(perToken) ? Number((perToken * 1_000_000).toPrecision(12)) : null;
}

function isDeprecated(model: GatewayModel, now: Date): boolean {
  if (model.deprecated_at === undefined || model.deprecated_at === null) return false;
  const at = typeof model.deprecated_at === 'number'
    ? model.deprecated_at * 1000
    : Date.parse(model.deprecated_at);
  return Number.isFinite(at) && at <= now.getTime();
}

/** Gemini runs only as {@link CURRENT_GEMINI_MODEL_ID}, its dated snapshots and speed variants included. */
function isOtherGemini(id: string): boolean {
  const slug = slugOf(id).toLowerCase();
  return slug.startsWith('gemini-')
    && familyKey(slug.replace(SPEED_VARIANT_SUFFIX, '')) !== CURRENT_GEMINI_MODEL_ID;
}

/** Agent lanes need tool calls; batch, free, and excluded-lab models don't fit a live pane. */
export function isLaneEligible(model: GatewayModel, now: Date): boolean {
  const tags = model.tags ?? [];
  return model.type === 'language'
    && tags.includes('tool-use')
    && !tags.includes('free')
    && !/-(batch|free)$/.test(model.id)
    && !EXCLUDED_LABS.has(labOf(model))
    && !isOtherGemini(model.id)
    && !isDeprecated(model, now)
    && GATEWAY_MODEL_ID_PATTERN.test(model.id);
}

/** Mean share per model name over the latest `SHARE_WINDOW_DAYS` dates of one metric. */
export function summarizeShare(rows: readonly LeaderboardRow[], metric: 'tokens' | 'spend'): Record<string, number> {
  const metricRows = rows.filter((row) => row.metric === metric && row.name !== 'Other');
  const window = [...new Set(metricRows.map((row) => row.date))].sort().slice(-SHARE_WINDOW_DAYS);
  if (window.length === 0) return {};
  const inWindow = new Set(window);
  const sums: Record<string, number> = {};
  for (const row of metricRows) {
    if (!inWindow.has(row.date)) continue;
    sums[row.name] = (sums[row.name] ?? 0) + row.share_percent;
  }
  return Object.fromEntries(
    Object.entries(sums).map(([name, sum]) => [name, Math.round((sum / window.length) * 100) / 100]),
  );
}

/** Parse `pi --list-models`: a header row, then `provider model context max-out thinking images`. */
export function parsePiModelList(stdout: string): Array<{ provider: string; model: string }> {
  return stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([provider, model]) => provider && model && provider !== 'provider'
      && PI_ID_PART.test(provider) && PI_ID_PART.test(model))
    .map(([provider, model]) => ({ provider: provider!, model: model! }));
}

/**
 * The gateway entry for a model a login lists. Most share the slug after the
 * lab prefix (`xai/grok-4.7` ↔ `spacexai/grok-4.7`); a few drop a brand
 * prefix (`kimi-coding/k3` ↔ `moonshotai/kimi-k3`), matched only when unique.
 */
export function matchGatewayModel(model: string, catalog: readonly GatewayModel[]): GatewayModel | undefined {
  const exact = catalog.find((entry) => slugOf(entry.id) === model);
  if (exact) return exact;
  const suffixed = catalog.filter((entry) => slugOf(entry.id).endsWith(`-${model}`));
  return suffixed.length === 1 ? suffixed[0] : undefined;
}

function familyKey(id: string): string {
  return id.replace(/-\d{4}$/, '');
}

interface FamilyShares {
  token: Map<string, number>;
  spend: Map<string, number>;
}

/** A dated snapshot (`x-1017`) and its undated base (`x`) share usage as one family. */
function familyShares(snapshot: RankingInput): FamilyShares {
  const token = new Map<string, number>();
  const spend = new Map<string, number>();
  for (const model of snapshot.catalog) {
    const key = familyKey(model.id);
    token.set(key, (token.get(key) ?? 0) + (snapshot.tokenShare[model.name] ?? 0));
    spend.set(key, (spend.get(key) ?? 0) + (snapshot.spendShare[model.name] ?? 0));
  }
  return { token, spend };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Each lab's reference output price: its most-paid-for recent model, or its
 * priciest recent model when the leaderboard lists none of the lab's models.
 */
function labReferencePrices(snapshot: RankingInput, now: Date): Map<string, number> {
  const since = now.getTime() / 1000 - DIRECT_MODEL_MAX_AGE_DAYS * 86_400;
  const best = new Map<string, { spend: number; price: number }>();
  for (const model of snapshot.catalog) {
    const price = perMillion(model.pricing?.output);
    if (price === null || price <= 0 || !isLaneEligible(model, now) || SPEED_VARIANT_SUFFIX.test(model.id)) continue;
    if ((model.released ?? 0) < since) continue;
    const spend = snapshot.spendShare[model.name] ?? 0;
    const lab = labOf(model);
    const current = best.get(lab);
    if (!current || spend > current.spend || (spend === current.spend && price > current.price)) {
      best.set(lab, { spend, price });
    }
  }
  return new Map([...best].map(([lab, entry]) => [lab, entry.price]));
}

function toCandidate(
  model: GatewayModel,
  route: { route: 'direct' | 'gateway'; provider: string; piModel: string; fastPiModel: string | null; authType: string | null },
  shares: FamilyShares,
  references: Map<string, number>,
  now: Date,
): PiModelCandidate {
  const key = familyKey(model.id);
  const released = model.released ?? 0;
  const output = perMillion(model.pricing?.output);
  const reference = references.get(labOf(model));
  return {
    ...route,
    gatewayId: model.id,
    name: model.name,
    lab: labOf(model),
    tokenSharePercent: shares.token.get(key) ? round2(shares.token.get(key)!) : null,
    spendSharePercent: shares.spend.get(key) ? round2(shares.spend.get(key)!) : null,
    released: model.released ? new Date(released * 1000).toISOString().slice(0, 10) : null,
    contextWindow: model.context_window ?? null,
    inputPerMTok: perMillion(model.pricing?.input),
    outputPerMTok: output,
    isNew: released >= now.getTime() / 1000 - NEW_MODEL_DAYS * 86_400,
    tierRatio: output !== null && reference ? round2(output / reference) : null,
    fastPiModel: route.fastPiModel,
    authType: route.authType,
  };
}

/**
 * Every model a Pi lane could run: each working direct route, plus one
 * gateway candidate per usage family (the newest dated snapshot stands for its
 * family) when gateway credentials are ready.
 */
export function buildPiCandidates(
  snapshot: RankingInput,
  opts: { now: Date; directRoutes: readonly PiDirectRoute[]; gatewayReady: boolean },
): PiModelCandidate[] {
  const { now } = opts;
  const byId = new Map(snapshot.catalog.map((model) => [model.id, model]));
  const shares = familyShares(snapshot);
  const references = labReferencePrices(snapshot, now);
  const candidates: PiModelCandidate[] = [];

  for (const route of opts.directRoutes) {
    const model = byId.get(route.gatewayId);
    if (!model || !isLaneEligible(model, now)) continue;
    candidates.push(toCandidate(model, {
      route: 'direct',
      provider: route.provider,
      piModel: route.piModel,
      fastPiModel: route.fastPiModel,
      authType: route.authType,
    }, shares, references, now));
  }

  if (opts.gatewayReady) {
    const representatives = new Map<string, GatewayModel>();
    for (const model of snapshot.catalog) {
      if (!isLaneEligible(model, now) || SPEED_VARIANT_SUFFIX.test(model.id)) continue;
      const key = familyKey(model.id);
      const current = representatives.get(key);
      if (!current || ((model.released ?? 0) >= (current.released ?? 0) && model.id !== key)) {
        representatives.set(key, model);
      }
    }
    for (const model of representatives.values()) {
      const fast = byId.get(`${model.id}-fast`);
      candidates.push(toCandidate(model, {
        route: 'gateway',
        provider: PI_GATEWAY_PROVIDER,
        piModel: toPiModel(model.id),
        fastPiModel: fast && isLaneEligible(fast, now) ? toPiModel(fast.id) : null,
        authType: 'api_key',
      }, shares, references, now));
    }
  }
  return candidates;
}

function byNewest(a: PiModelCandidate, b: PiModelCandidate): number {
  return (b.released ?? '').localeCompare(a.released ?? '');
}

function byPrice(a: PiModelCandidate, b: PiModelCandidate): number {
  return (b.outputPerMTok ?? 0) - (a.outputPerMTok ?? 0);
}

/** Across labs, the priciest flagship leads: list price is the best tier signal the catalog carries. */
function frontierOrder(a: PiModelCandidate, b: PiModelCandidate): number {
  return byPrice(a, b) || (b.spendSharePercent ?? 0) - (a.spendSharePercent ?? 0) || byNewest(a, b);
}

/**
 * Within a lab, the flagship is the model people pay for most, else the
 * newest. Taking the priciest instead would pick pro tiers that bill several
 * times the flagship's price.
 */
function frontierPick(lab: readonly PiModelCandidate[]): PiModelCandidate {
  return [...lab].sort((a, b) =>
    (b.spendSharePercent ?? 0) - (a.spendSharePercent ?? 0) || byNewest(a, b) || byPrice(a, b))[0]!;
}

function meetsTier(candidate: PiModelCandidate, profile: PiModelProfile): boolean {
  if (profile === 'frontier' && SMALL_TIER_NAME.test(`${candidate.name} ${candidate.gatewayId}`)) return false;
  return candidate.tierRatio === null || candidate.tierRatio >= TIER_FLOOR[profile];
}

/**
 * A lab's balanced pick: most used, else its flagship's speed variant on a
 * login (a gateway `-fast` model is priority serving at a higher price), else
 * its newest model at half the flagship's price or less.
 */
function balancedPick(lab: readonly PiModelCandidate[]): PiModelCandidate {
  const used = lab.filter((candidate) => (candidate.tokenSharePercent ?? 0) > 0)
    .sort((a, b) => (b.tokenSharePercent ?? 0) - (a.tokenSharePercent ?? 0) || byNewest(a, b));
  if (used[0]) return used[0];
  const flagship = frontierPick(lab);
  if (flagship.fastPiModel && flagship.route === 'direct') {
    return { ...flagship, piModel: flagship.fastPiModel, name: `${flagship.name} Fast`, fastPiModel: null };
  }
  const ceiling = (flagship.outputPerMTok ?? 0) / 2;
  const mid = lab.filter((candidate) => candidate.outputPerMTok !== null && candidate.outputPerMTok <= ceiling)
    .sort((a, b) => byNewest(a, b) || (b.outputPerMTok ?? 0) - (a.outputPerMTok ?? 0));
  return mid[0] ?? flagship;
}

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
export function rankPiModels(
  candidates: readonly PiModelCandidate[],
  opts: { profile: PiModelProfile; limit?: number },
): PiModelCandidate[] {
  const { profile } = opts;
  const limit = opts.limit ?? DEFAULT_CANDIDATE_LIMIT;
  const pickFor = profile === 'frontier' ? frontierPick : balancedPick;
  const order = profile === 'frontier'
    ? frontierOrder
    : (a: PiModelCandidate, b: PiModelCandidate) =>
      (b.tokenSharePercent ?? 0) - (a.tokenSharePercent ?? 0) || byNewest(a, b);
  const paidLabs = new Set(candidates.filter((candidate) => candidate.spendSharePercent).map((candidate) => candidate.lab));

  const perLab = (route: 'direct' | 'gateway'): PiModelCandidate[] => {
    const labs = new Map<string, PiModelCandidate[]>();
    for (const candidate of candidates) {
      if (candidate.route !== route || !meetsTier(candidate, profile)) continue;
      if (route === 'gateway' && profile === 'frontier' && !paidLabs.has(candidate.lab)) continue;
      if (route === 'gateway' && profile === 'balanced' && !candidate.tokenSharePercent && !candidate.isNew) continue;
      labs.set(candidate.lab, [...(labs.get(candidate.lab) ?? []), candidate]);
    }
    return [...labs.values()]
      .map((lab) => (lab.some((entry) => entry.authType === 'oauth') ? lab.filter((entry) => entry.authType === 'oauth') : lab))
      .map(pickFor)
      .sort(order);
  };

  const direct = perLab('direct');
  const covered = new Set(direct.map((candidate) => candidate.lab));
  const gateway = perLab('gateway').filter((candidate) => !covered.has(candidate.lab));
  return [...direct, ...gateway].slice(0, limit);
}

function formatPrice(value: number | null): string {
  if (value === null) return '?';
  return `$${value.toFixed(value >= 0.01 || value === 0 ? 2 : 4)}`;
}

function describeCandidate(candidate: PiModelCandidate, profile: PiModelProfile): string {
  const parts = [
    candidate.piModel,
    candidate.route === 'direct' ? `your ${candidate.provider} login` : 'Vercel AI Gateway, metered',
  ];
  const share = profile === 'frontier' ? candidate.spendSharePercent : candidate.tokenSharePercent;
  if (share !== null) parts.push(`${share}% of gateway ${profile === 'frontier' ? 'spend' : 'tokens'} this week`);
  else if (candidate.isNew) parts.push('new this fortnight');
  parts.push(`${formatPrice(candidate.inputPerMTok)} in / ${formatPrice(candidate.outputPerMTok)} out per M tokens list price`);
  if (candidate.contextWindow) parts.push(`${Math.round(candidate.contextWindow / 1000)}K context`);
  if (profile === 'balanced' && candidate.fastPiModel) parts.push(`speed variant: ${candidate.fastPiModel}`);
  return parts.join(' · ');
}

const ROLE_QUESTION: Record<PiLaneRole, { question: string; header: string; multiSelect: boolean }> = {
  robustness: {
    question: 'Which frontier model should the Pi robustness planner run?',
    header: 'Robustness',
    multiSelect: false,
  },
  ergonomics: {
    question: 'Which frontier model should the Pi ergonomics planner run?',
    header: 'Ergonomics',
    multiSelect: false,
  },
  implementer: {
    question: 'Which models should the Pi implementer panes run? Pick two to alternate them across the Pi panes, or one for all of them.',
    header: 'Pi models',
    multiSelect: true,
  },
};

/**
 * One AskUserQuestion payload per role, from the ranking for that role's
 * profile. The role's last picks lead while a route still runs them, even
 * when the ranking leaves them out. Otherwise a single-select role defaults
 * to a lab no earlier question in the same call defaults to, so the two
 * deep-plan Pi planners start on different labs. The implementer question
 * recommends its top two.
 */
export function buildPiModelQuestions(
  roles: readonly PiLaneRole[],
  ranked: Readonly<Partial<Record<PiModelProfile, readonly PiModelCandidate[]>>>,
  picks: PiModelPicks,
  all: readonly PiModelCandidate[] = [],
): PiModelQuestion[] {
  const defaultLabs = new Set<string>();
  return roles.map((role) => {
    const profile = PI_ROLE_PROFILE[role];
    const { multiSelect, ...text } = ROLE_QUESTION[role];
    const pool = ranked[profile] ?? [];
    const remembered = new Set(picks[role]?.piModels ?? []);
    const leading = [...remembered].flatMap((piModel) => {
      const found = pool.find((candidate) => candidate.piModel === piModel)
        ?? all.find((candidate) => candidate.piModel === piModel);
      return found ? [found] : [];
    });
    const fresh = pool.find((candidate) => !defaultLabs.has(candidate.lab)) ?? pool[0];
    const ordered = [...new Set([...leading, ...(fresh ? [fresh] : []), ...pool])].slice(0, MAX_OPTIONS);
    const recommended = multiSelect ? 2 : 1;
    if (ordered[0]) defaultLabs.add(ordered[0].lab);

    const options = ordered.map((candidate, index) => {
      const note = remembered.has(candidate.piModel) ? 'Last used for this role. ' : '';
      return {
        label: index < recommended ? `${candidate.name} (Recommended)` : candidate.name,
        description: `${note}${describeCandidate(candidate, profile)}`,
        piModel: candidate.piModel,
      };
    });
    return { role, ...text, multiSelect, options };
  });
}

export type ResolvedPick =
  | { ok: true; piModel: string; name: string }
  | { ok: false; suggestions: string[] };

/** Names compare without case, and `GPT-6 Astra` matches `gpt 6 astra`. */
function sameName(a: string, b: string): boolean {
  const normalize = (value: string): string => value.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  return normalize(a) === normalize(b);
}

/**
 * Accept an option label, a model name, a `pi --model` value, or a gateway id.
 * Candidates win, in the order given, so passing the ranked lists first
 * resolves the exact labels the questions showed. Then any model a working
 * login lists, then the gateway.
 */
export function resolvePiModelAnswer(
  answer: string,
  sources: {
    candidates: readonly PiModelCandidate[];
    directModels: readonly { provider: string; model: string }[];
    catalog: readonly GatewayModel[];
    now: Date;
  },
): ResolvedPick {
  const text = answer.trim().replace(/\s*\(Recommended\)$/, '');
  const candidate = sources.candidates.find((entry) => entry.piModel === text || entry.fastPiModel === text)
    ?? sources.candidates.find((entry) => sameName(entry.name, text));
  if (candidate) {
    const piModel = candidate.fastPiModel === text ? text : candidate.piModel;
    return { ok: true, piModel, name: candidate.name };
  }
  const direct = sources.directModels.find((entry) => `${entry.provider}/${entry.model}` === text);
  if (direct && !isOtherGemini(direct.model)) return { ok: true, piModel: text, name: direct.model };

  const bare = text.startsWith(`${PI_GATEWAY_PROVIDER}/`) ? text.slice(PI_GATEWAY_PROVIDER.length + 1) : text;
  const eligible = sources.catalog.filter((model) => isLaneEligible(model, sources.now));
  const match = eligible.find((model) => model.id === bare) ?? eligible.find((model) => sameName(model.name, bare));
  if (match) return { ok: true, piModel: toPiModel(match.id), name: match.name };

  const tokens = text.toLowerCase().split(/[\s/:-]+/).filter((token) => token.length > 1);
  const pool = [
    ...sources.candidates.map((entry) => ({ value: entry.piModel, text: `${entry.piModel} ${entry.name}` })),
    ...eligible.map((model) => ({ value: toPiModel(model.id), text: `${model.id} ${model.name}` })),
  ];
  const suggestions = [...new Set(pool
    .filter((entry) => tokens.length > 0 && tokens.every((token) => entry.text.toLowerCase().includes(token)))
    .map((entry) => entry.value))].slice(0, 5);
  return { ok: false, suggestions };
}

async function fetchJson(
  exec: ExecFn,
  url: string,
  opts: { cwd: string; signal?: AbortSignal },
): Promise<unknown> {
  const result = await exec('curl', ['-sS', '--fail', '--max-time', String(FETCH_TIMEOUT_MS / 1000 - 5), url], {
    timeout: FETCH_TIMEOUT_MS,
    cwd: opts.cwd,
    signal: opts.signal,
  });
  if (result.code !== 0) {
    throw new Error(`curl ${url} exited ${result.code}: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as unknown;
}

async function fetchGatewaySnapshot(
  exec: ExecFn,
  opts: { cwd: string; signal?: AbortSignal; now: Date },
): Promise<GatewaySnapshot> {
  const [catalogBody, leaderboardBody] = await Promise.all([
    fetchJson(exec, GATEWAY_CATALOG_URL, opts),
    fetchJson(exec, GATEWAY_LEADERBOARD_URL, opts),
  ]);
  const catalog = CatalogResponseSchema.parse(catalogBody).data.flatMap((entry) => {
    const parsed = GatewayModelSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  const rows = LeaderboardResponseSchema.parse(leaderboardBody).rows.flatMap((entry) => {
    const parsed = LeaderboardRowSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  if (catalog.length === 0) throw new Error('the gateway catalog listed no models');
  return {
    version: 2,
    fetchedAt: opts.now.toISOString(),
    catalog: catalog.filter((model) => model.type === 'language'),
    tokenShare: summarizeShare(rows, 'tokens'),
    spendShare: summarizeShare(rows, 'spend'),
  };
}

async function readJson<T>(cwd: string, relativePath: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const parsed = schema.safeParse(JSON.parse(await readFile(join(cwd, relativePath), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

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
export async function loadGatewaySnapshot(
  exec: ExecFn,
  opts: { cwd: string; signal?: AbortSignal; now: Date; refresh?: boolean },
): Promise<LoadedSnapshot> {
  const cached = await readJson(opts.cwd, CACHE_RELATIVE_PATH, GatewaySnapshotSchema);
  if (cached && !opts.refresh && opts.now.getTime() - Date.parse(cached.fetchedAt) < CACHE_FRESH_MS) {
    return { snapshot: cached, stale: false };
  }
  let snapshot: GatewaySnapshot;
  try {
    snapshot = await fetchGatewaySnapshot(exec, opts);
  } catch (err) {
    const fetchError = err instanceof Error ? err.message : String(err);
    if (cached) return { snapshot: cached, stale: true, fetchError };
    throw new Error(`could not load the Vercel AI Gateway model list: ${fetchError}`);
  }
  try {
    await writeAtomic(join(opts.cwd, CACHE_RELATIVE_PATH), `${JSON.stringify(snapshot)}\n`);
  } catch {
    // An unwritable cache only costs a refetch next time.
  }
  return { snapshot, stale: false };
}

/**
 * Whether the catalog the last `flywheel_pi_models` call cached still offers
 * the Gemini lane's model to agent panes. Null when nothing is cached.
 */
export async function readGeminiLaneListing(
  cwd: string,
  now: Date,
): Promise<{ listed: boolean; fetchedAt: string } | null> {
  const cached = await readJson(cwd, CACHE_RELATIVE_PATH, GatewaySnapshotSchema);
  if (!cached) return null;
  const model = cached.catalog.find((entry) => entry.id === GEMINI_GATEWAY_ID);
  return { listed: model !== undefined && isLaneEligible(model, now), fetchedAt: cached.fetchedAt };
}

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
export async function checkPiProviderAuth(
  exec: ExecFn,
  provider: string,
  opts: { cwd?: string; signal?: AbortSignal; timeout?: number },
): Promise<ProviderAuth> {
  try {
    const result = await exec(
      'pi',
      ['auth', 'check', '--provider', provider, '--json'],
      { timeout: opts.timeout ?? 15_000, cwd: opts.cwd, signal: opts.signal },
    );
    let status: string | undefined;
    let reason: string | undefined;
    let authType: string | null = null;
    try {
      const parsed = JSON.parse(result.stdout) as { status?: unknown; reason?: unknown; authType?: unknown };
      status = typeof parsed.status === 'string' ? parsed.status : undefined;
      reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
      authType = typeof parsed.authType === 'string' ? parsed.authType : null;
    } catch {
      status = undefined;
    }
    const detail = status
      ? `${status}${reason ? ` (${reason})` : ''}`
      : `${result.stdout}${result.stderr}`.trim() || `pi auth check exited ${result.code}`;
    return { provider, ready: result.code === 0 && (status === undefined || status === 'ready'), authType, detail };
  } catch (err) {
    return { provider, ready: false, authType: null, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Provider errors can quote a masked key; keep no part of it. */
function redactProbeDetail(detail: string): string {
  return detail
    .replace(/\S*\*{3,}\S*/g, '[redacted]')
    .replace(/\b(?:sk|vck|xai|gsk|pk|rk)[-_][A-Za-z0-9_-]{8,}/g, '[redacted]')
    .slice(0, 200);
}

/**
 * One tool-free reply proves the login can run the model; a listing alone
 * doesn't. Returns null when the probe timed out or the budget stopped it,
 * since a slow reply says nothing about whether the plan covers the model.
 */
async function probePiModel(
  exec: ExecFn,
  piModel: string,
  opts: { cwd: string; signal: AbortSignal; now: Date },
): Promise<PiRouteProbe | null> {
  try {
    const result = await exec(
      'pi',
      ['-p', '--no-session', '--no-approve', '--no-context-files', '--no-tools', '--thinking', 'minimal',
        '--model', piModel, 'Reply with exactly: ok'],
      { timeout: PROBE_TIMEOUT_MS, cwd: opts.cwd, signal: opts.signal },
    );
    if (opts.signal.aborted) return null;
    const lines = `${result.stdout}\n${result.stderr}`.trim().split('\n').filter(Boolean);
    const detail = redactProbeDetail(lines.at(-1) ?? `pi exited ${result.code}`);
    return { ok: result.code === 0 && result.stdout.trim().length > 0, detail, checkedAt: opts.now.toISOString() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.signal.aborted || message.startsWith('Timed out after')) return null;
    return { ok: false, detail: redactProbeDetail(message), checkedAt: opts.now.toISOString() };
  }
}

function isProbeFresh(probe: PiRouteProbe | undefined, now: Date): probe is PiRouteProbe {
  return probe !== undefined && now.getTime() - Date.parse(probe.checkedAt) < PROBE_FRESH_MS;
}

/**
 * The models worth probing on one login: its last year of models, priciest
 * first, so the tiers the rankings use get checked before the time budget ends.
 */
function probeTargets(models: readonly { model: string; gateway: GatewayModel }[], now: Date): string[] {
  const since = now.getTime() / 1000 - DIRECT_MODEL_MAX_AGE_DAYS * 86_400;
  const price = (entry: { gateway: GatewayModel }): number => perMillion(entry.gateway.pricing?.output) ?? 0;
  return models
    .filter((entry) => (entry.gateway.released ?? 0) >= since)
    .sort((a, b) => price(b) - price(a) || (b.gateway.released ?? 0) - (a.gateway.released ?? 0))
    .slice(0, PROBES_PER_PROVIDER)
    .map((entry) => entry.model);
}

export interface DiscoveredRoutes {
  directRoutes: PiDirectRoute[];
  /** Every model the working logins list, for answers typed in by hand. */
  directModels: Array<{ provider: string; model: string }>;
  providers: ProviderAuth[];
  gatewayReady: boolean;
  /** Direct routes the latest probe rejected, with Pi's reason. */
  failed: Array<{ piModel: string; detail: string }>;
}

/**
 * Find the direct routes that work: list Pi's models, keep the logins whose
 * credentials pass `pi auth check`, and probe each login's recent models once
 * a day, or now with `refresh`. Logins probe in parallel, four models at a
 * time each, within one shared time budget.
 */
export async function discoverPiRoutes(
  exec: ExecFn,
  snapshot: RankingInput,
  opts: { cwd: string; signal?: AbortSignal; now: Date; refresh?: boolean; probeScope?: string },
): Promise<DiscoveredRoutes> {
  let listed: Array<{ provider: string; model: string }> = [];
  try {
    const result = await exec('pi', ['--list-models'], { timeout: LIST_MODELS_TIMEOUT_MS, cwd: opts.cwd, signal: opts.signal });
    if (result.code === 0) listed = parsePiModelList(result.stdout);
  } catch {
    listed = [];
  }
  const directListed = listed.filter((entry) =>
    !AGGREGATOR_PROVIDERS.has(entry.provider) && !EXCLUDED_PROVIDERS.has(entry.provider));
  const providerNames = [...new Set([PI_GATEWAY_PROVIDER, ...directListed.map((entry) => entry.provider)])];
  const providers = await Promise.all(providerNames.map((provider) => checkPiProviderAuth(exec, provider, opts)));
  const ready = new Set(providers.filter((entry) => entry.ready).map((entry) => entry.provider));
  const directModels = directListed.filter((entry) => ready.has(entry.provider));

  const matched = directModels.flatMap((entry) => {
    if (SPEED_VARIANT_SUFFIX.test(entry.model)) return [];
    const gateway = matchGatewayModel(entry.model, snapshot.catalog);
    return gateway && isLaneEligible(gateway, opts.now) ? [{ ...entry, gateway }] : [];
  });
  const targets = [...new Set(matched.map((entry) => entry.provider))].flatMap((provider) => {
    const own = matched.filter((entry) => entry.provider === provider);
    const chosen = probeTargets(own, opts.now);
    const speed = chosen.flatMap((model) => directModels
      .filter((entry) => entry.provider === provider && SPEED_VARIANT_SUFFIX.test(entry.model)
        && entry.model.replace(SPEED_VARIANT_SUFFIX, '') === model)
      .map((entry) => entry.model));
    return [...chosen, ...speed].map((model) => `${provider}/${model}`);
  });

  const cache = await readJson(opts.cwd, probeCachePath(opts.probeScope), ProbeCacheSchema);
  const probes: Record<string, PiRouteProbe> = { ...(cache?.probes ?? {}) };
  const stale = targets.filter((piModel) => opts.refresh || !isProbeFresh(probes[piModel], opts.now));
  const budget = AbortSignal.any([
    AbortSignal.timeout(PROBE_BUDGET_MS),
    ...(opts.signal ? [opts.signal] : []),
  ]);
  const byProvider = [...new Set(stale.map(providerOf))].map((provider) => stale.filter((piModel) => providerOf(piModel) === provider));
  await Promise.all(byProvider.map((group) => mapLimit(group, PROBES_IN_FLIGHT_PER_PROVIDER, async (piModel) => {
    const probe = await probePiModel(exec, piModel, { cwd: opts.cwd, signal: budget, now: opts.now });
    if (probe) probes[piModel] = probe;
  })));
  if (stale.length > 0) {
    try {
      await writeAtomic(join(opts.cwd, probeCachePath(opts.probeScope)), `${JSON.stringify({ version: 1, probes }, null, 2)}\n`);
    } catch {
      // An unwritable cache only costs a re-probe next time.
    }
  }

  const works = (piModel: string): boolean => targets.includes(piModel) && probes[piModel]?.ok === true;
  const directRoutes = matched.flatMap((entry) => {
    const piModel = `${entry.provider}/${entry.model}`;
    if (!works(piModel)) return [];
    const speed = directModels.find((other) => other.provider === entry.provider
      && SPEED_VARIANT_SUFFIX.test(other.model) && other.model.replace(SPEED_VARIANT_SUFFIX, '') === entry.model);
    const fastPiModel = speed && works(`${speed.provider}/${speed.model}`) ? `${speed.provider}/${speed.model}` : null;
    const authType = providers.find((auth) => auth.provider === entry.provider)?.authType ?? null;
    return [{ provider: entry.provider, model: entry.model, piModel, gatewayId: entry.gateway.id, fastPiModel, authType }];
  });
  const failed = targets
    .filter((piModel) => probes[piModel] && !probes[piModel]!.ok)
    .map((piModel) => ({ piModel, detail: probes[piModel]!.detail }));
  return { directRoutes, directModels, providers, gatewayReady: ready.has(PI_GATEWAY_PROVIDER), failed };
}

export async function readPiModelPicks(cwd: string): Promise<PiModelPicks> {
  const parsed = await readJson(cwd, PICKS_RELATIVE_PATH, PicksFileSchema);
  if (!parsed) return {};
  return Object.fromEntries(
    Object.entries(parsed.picks).filter(([role]) => (PI_LANE_ROLES as readonly string[]).includes(role)),
  ) as PiModelPicks;
}

export async function writePiModelPicks(
  cwd: string,
  updates: Partial<Record<PiLaneRole, string[]>>,
  now: Date,
): Promise<PiModelPicks> {
  const picks: PiModelPicks = { ...(await readPiModelPicks(cwd)) };
  for (const [role, piModels] of Object.entries(updates) as Array<[PiLaneRole, string[]]>) {
    picks[role] = { piModels, chosenAt: now.toISOString() };
  }
  await writeAtomic(
    join(cwd, PICKS_RELATIVE_PATH),
    `${JSON.stringify({ version: 2, picks }, null, 2)}\n`,
  );
  return picks;
}

/**
 * Pi counts as a ready lane when any route it would use has credentials: the
 * gateway, or a login behind the user's last picks or a passing probe.
 */
export async function checkPiLaneReady(
  exec: ExecFn,
  opts: { cwd?: string; signal?: AbortSignal; timeout?: number; probeScope?: string },
): Promise<{ ready: boolean; detail: string }> {
  const fromPicks = opts.cwd
    ? Object.values(await readPiModelPicks(opts.cwd)).flatMap((pick) => pick?.piModels.map(providerOf) ?? [])
    : [];
  const probeCache = opts.cwd ? await readJson(opts.cwd, probeCachePath(opts.probeScope), ProbeCacheSchema) : null;
  const fromProbes = Object.entries(probeCache?.probes ?? {})
    .filter(([, probe]) => probe.ok)
    .map(([piModel]) => providerOf(piModel));
  const providers = [...new Set([PI_GATEWAY_PROVIDER, ...fromPicks, ...fromProbes])];
  const results = await Promise.all(providers.map((provider) => checkPiProviderAuth(exec, provider, opts)));
  const readyOne = results.find((result) => result.ready);
  return readyOne
    ? { ready: true, detail: `${readyOne.provider} ready` }
    : { ready: false, detail: results.map((result) => `${result.provider} ${result.detail}`).join('; ') };
}
