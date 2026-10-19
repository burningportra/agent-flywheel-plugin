/**
 * Model selection for Pi lanes. Pi reaches models through the Vercel AI
 * Gateway, whose public catalog and usage leaderboard change weekly, so the
 * flywheel ranks the live lists and asks the user instead of pinning ids.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { writeAtomic } from './atomic-write.js';
import type { ExecFn } from './exec.js';

export const PI_GATEWAY_PROVIDER = 'vercel-ai-gateway';
export const GATEWAY_CATALOG_URL = 'https://ai-gateway.vercel.sh/v1/models';
export const GATEWAY_LEADERBOARD_URL =
  'https://vercel.com/api/ai/leaderboard-export?dataset=models&modality=text&format=json';

export const PI_LANE_ROLES = ['robustness', 'ergonomics', 'implementer'] as const;
export type PiLaneRole = (typeof PI_LANE_ROLES)[number];

/**
 * Gateway ids reach shell commands, and Pi reads a `:<level>` suffix on
 * `--model` as a thinking level, so only plain id characters pass.
 */
export const GATEWAY_MODEL_ID_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const CACHE_RELATIVE_PATH = join('.pi-flywheel', 'cache', 'gateway-models.json');
const PICKS_RELATIVE_PATH = join('.pi-flywheel', 'pi-models.json');
const CACHE_FRESH_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const SHARE_WINDOW_DAYS = 7;
const NEW_MODEL_DAYS = 14;
const MAX_OPTIONS = 4;
const DEFAULT_CANDIDATE_LIMIT = 8;

/** Labs whose models already have their own lane, plus anonymous trial models. */
const EXCLUDED_LABS = new Set(['anthropic', 'stealth']);

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
  version: z.literal(1),
  fetchedAt: z.string(),
  catalog: z.array(GatewayModelSchema),
  /** Mean daily share of gateway text tokens over the last week, keyed by model name. */
  tokenShare: z.record(z.string(), z.number()),
});
export type GatewaySnapshot = z.infer<typeof GatewaySnapshotSchema>;

const PicksFileSchema = z.object({
  version: z.literal(1),
  picks: z.record(z.string(), z.object({ id: z.string(), chosenAt: z.string() })),
});
export type PiModelPicks = Partial<Record<PiLaneRole, { id: string; chosenAt: string }>>;

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

export function toPiModel(id: string): string {
  return `${PI_GATEWAY_PROVIDER}/${id}`;
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

/** Agent lanes need tool calls; batch, free, and excluded-lab models don't fit a live pane. */
export function isLaneEligible(model: GatewayModel, now: Date): boolean {
  const tags = model.tags ?? [];
  return model.type === 'language'
    && tags.includes('tool-use')
    && !tags.includes('free')
    && !/-(batch|free)$/.test(model.id)
    && !EXCLUDED_LABS.has(labOf(model))
    && !isDeprecated(model, now)
    && GATEWAY_MODEL_ID_PATTERN.test(model.id);
}

/** Mean token share per model name over the latest `SHARE_WINDOW_DAYS` dates. */
export function summarizeTokenShare(rows: readonly LeaderboardRow[]): Record<string, number> {
  const tokenRows = rows.filter((row) => row.metric === 'tokens' && row.name !== 'Other');
  const window = [...new Set(tokenRows.map((row) => row.date))].sort().slice(-SHARE_WINDOW_DAYS);
  if (window.length === 0) return {};
  const inWindow = new Set(window);
  const sums: Record<string, number> = {};
  for (const row of tokenRows) {
    if (!inWindow.has(row.date)) continue;
    sums[row.name] = (sums[row.name] ?? 0) + row.share_percent;
  }
  return Object.fromEntries(
    Object.entries(sums).map(([name, sum]) => [name, Math.round((sum / window.length) * 100) / 100]),
  );
}

function toCandidate(
  model: GatewayModel,
  share: number | null,
  isNew: boolean,
  byId: ReadonlyMap<string, GatewayModel>,
  now: Date,
): PiModelCandidate {
  const fast = byId.get(`${model.id}-fast`);
  return {
    id: model.id,
    piModel: toPiModel(model.id),
    name: model.name,
    lab: labOf(model),
    tokenSharePercent: share,
    released: model.released ? new Date(model.released * 1000).toISOString().slice(0, 10) : null,
    contextWindow: model.context_window ?? null,
    inputPerMTok: perMillion(model.pricing?.input),
    outputPerMTok: perMillion(model.pricing?.output),
    isNew,
    fastVariantId: fast && isLaneEligible(fast, now) ? fast.id : null,
  };
}

/**
 * Rank lane-eligible models by recent gateway token share. A dated snapshot
 * (`x-1017`) and its undated base (`x`) count as one family, represented by
 * the newest release, so a fresh snapshot inherits its family's usage. Models
 * released in the last two weeks that the leaderboard hasn't caught up with
 * follow the ranked list, marked `isNew`.
 */
export function rankPiModels(
  snapshot: Pick<GatewaySnapshot, 'catalog' | 'tokenShare'>,
  opts: { now: Date; limit?: number },
): PiModelCandidate[] {
  const { now } = opts;
  const limit = opts.limit ?? DEFAULT_CANDIDATE_LIMIT;
  const byId = new Map(snapshot.catalog.map((model) => [model.id, model]));
  const eligible = snapshot.catalog.filter((model) => isLaneEligible(model, now));

  const families = new Map<string, { representative: GatewayModel; share: number }>();
  for (const model of eligible) {
    const base = model.id.replace(/-\d{4}$/, '');
    const family = families.get(base);
    const share = snapshot.tokenShare[model.name] ?? 0;
    if (!family) {
      families.set(base, { representative: model, share });
      continue;
    }
    family.share += share;
    if ((model.released ?? 0) >= (family.representative.released ?? 0) && model.id !== base) {
      family.representative = model;
    }
  }

  const ranked = [...families.values()]
    .filter((family) => family.share > 0)
    .sort((a, b) => b.share - a.share)
    .map((family) => toCandidate(
      family.representative,
      Math.round(family.share * 100) / 100,
      false,
      byId,
      now,
    ));

  const included = new Set(ranked.flatMap((candidate) => [candidate.id, candidate.fastVariantId]));
  const newSince = now.getTime() / 1000 - NEW_MODEL_DAYS * 86_400;
  const fresh = eligible
    .filter((model) => (model.released ?? 0) >= newSince
      && (model.tags ?? []).includes('reasoning')
      && !included.has(model.id)
      && !model.id.endsWith('-fast'))
    .sort((a, b) => (b.released ?? 0) - (a.released ?? 0))
    .slice(0, 2)
    .map((model) => toCandidate(model, null, true, byId, now));

  return [...ranked.slice(0, Math.max(0, limit - fresh.length)), ...fresh];
}

function formatPrice(value: number | null): string {
  if (value === null) return '?';
  return `$${value < 1 ? value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : value.toFixed(2)}`;
}

function describeModel(model: GatewayModel, share: number | null, isNew: boolean): string {
  const parts = [toPiModel(model.id)];
  if (share !== null) parts.push(`${share}% of gateway tokens this week`);
  else if (isNew) parts.push('new this fortnight, not ranked yet');
  parts.push(`${formatPrice(perMillion(model.pricing?.input))} in / ${formatPrice(perMillion(model.pricing?.output))} out per M tokens`);
  if (model.context_window) parts.push(`${Math.round(model.context_window / 1000)}K context`);
  return parts.join(' · ');
}

const ROLE_QUESTION: Record<PiLaneRole, { question: string; header: string }> = {
  robustness: {
    question: 'Which model should the Pi robustness planner run? It takes the lens Codex used to run.',
    header: 'Robustness',
  },
  ergonomics: {
    question: 'Which model should the Pi ergonomics planner run?',
    header: 'Ergonomics',
  },
  implementer: {
    question: 'Which model should the Pi implementer panes run?',
    header: 'Pi model',
  },
};

/**
 * One AskUserQuestion payload per role. The first option is the role's last
 * pick when the catalog still lists it. Otherwise it is the top candidate
 * from a lab no earlier question in the same call defaults to, so the two
 * deep-plan Pi planners start on different labs. The default's fast variant
 * follows it.
 */
export function buildPiModelQuestions(
  roles: readonly PiLaneRole[],
  candidates: readonly PiModelCandidate[],
  snapshot: Pick<GatewaySnapshot, 'catalog' | 'tokenShare'>,
  picks: PiModelPicks,
): PiModelQuestion[] {
  const byId = new Map(snapshot.catalog.map((model) => [model.id, model]));
  const shareById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const defaultLabs = new Set<string>();

  return roles.map((role) => {
    const remembered = picks[role]?.id;
    const preferredId = (remembered && byId.has(remembered) ? remembered : undefined)
      ?? candidates.find((candidate) => !defaultLabs.has(candidate.lab))?.id
      ?? candidates[0]?.id;
    const preferred = preferredId ? byId.get(preferredId) : undefined;
    if (preferred) defaultLabs.add(labOf(preferred));

    const ids: string[] = [];
    const push = (id: string | null | undefined): void => {
      if (id && byId.has(id) && !ids.includes(id) && ids.length < MAX_OPTIONS) ids.push(id);
    };
    push(preferredId);
    push(preferredId ? `${preferredId}-fast` : undefined);
    const labs = new Set(ids.map((id) => labOf(byId.get(id)!)));
    for (const candidate of candidates) {
      if (!labs.has(candidate.lab)) {
        push(candidate.id);
        labs.add(candidate.lab);
      }
    }
    for (const candidate of candidates) push(candidate.id);

    const options = ids.map((id, index) => {
      const model = byId.get(id)!;
      const ranked = shareById.get(id);
      const note = index === 0 && id === remembered ? 'Last used for this role. ' : '';
      return {
        label: index === 0 ? `${model.name} (Recommended)` : model.name,
        description: `${note}${describeModel(model, ranked?.tokenSharePercent ?? null, ranked?.isNew ?? false)}`,
        piModel: toPiModel(id),
      };
    });
    return { role, ...ROLE_QUESTION[role], multiSelect: false as const, options };
  });
}

export type ResolvedPick =
  | { ok: true; id: string; piModel: string; name: string }
  | { ok: false; suggestions: string[] };

/** Accept an option label, a catalog name, a gateway id, or a `vercel-ai-gateway/` model. */
export function resolvePiModelAnswer(
  answer: string,
  catalog: readonly GatewayModel[],
): ResolvedPick {
  const text = answer.trim().replace(/\s*\(Recommended\)$/, '');
  const bare = text.startsWith(`${PI_GATEWAY_PROVIDER}/`)
    ? text.slice(PI_GATEWAY_PROVIDER.length + 1)
    : text;
  const lower = bare.toLowerCase();
  const match = catalog.find((model) => model.id === bare)
    ?? catalog.find((model) => model.name.toLowerCase() === lower);
  if (match && GATEWAY_MODEL_ID_PATTERN.test(match.id)) {
    return { ok: true, id: match.id, piModel: toPiModel(match.id), name: match.name };
  }
  const tokens = lower.split(/[\s/:-]+/).filter((token) => token.length > 1);
  const suggestions = catalog
    .filter((model) => model.type === 'language')
    .filter((model) => tokens.length > 0
      && tokens.every((token) => `${model.id} ${model.name}`.toLowerCase().includes(token)))
    .slice(0, 5)
    .map((model) => model.id);
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
    version: 1,
    fetchedAt: opts.now.toISOString(),
    catalog: catalog.filter((model) => model.type === 'language'),
    tokenShare: summarizeTokenShare(rows),
  };
}

async function readCachedSnapshot(cwd: string): Promise<GatewaySnapshot | null> {
  try {
    const parsed = GatewaySnapshotSchema.safeParse(
      JSON.parse(await readFile(join(cwd, CACHE_RELATIVE_PATH), 'utf8')),
    );
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
  const cached = await readCachedSnapshot(opts.cwd);
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

export async function readPiModelPicks(cwd: string): Promise<PiModelPicks> {
  try {
    const parsed = PicksFileSchema.safeParse(
      JSON.parse(await readFile(join(cwd, PICKS_RELATIVE_PATH), 'utf8')),
    );
    if (!parsed.success) return {};
    return Object.fromEntries(
      Object.entries(parsed.data.picks).filter(([role]) => (PI_LANE_ROLES as readonly string[]).includes(role)),
    ) as PiModelPicks;
  } catch {
    return {};
  }
}

export async function writePiModelPicks(
  cwd: string,
  updates: Partial<Record<PiLaneRole, string>>,
  now: Date,
): Promise<PiModelPicks> {
  const picks: PiModelPicks = { ...(await readPiModelPicks(cwd)) };
  for (const [role, id] of Object.entries(updates) as Array<[PiLaneRole, string]>) {
    picks[role] = { id, chosenAt: now.toISOString() };
  }
  await writeAtomic(
    join(cwd, PICKS_RELATIVE_PATH),
    `${JSON.stringify({ version: 1, picks }, null, 2)}\n`,
  );
  return picks;
}

/** `pi auth check` only reads credentials, so one call covers every gateway model. */
export async function checkPiGatewayAuth(
  exec: ExecFn,
  opts: { cwd?: string; signal?: AbortSignal; timeout?: number },
): Promise<{ ready: boolean; detail: string }> {
  try {
    const result = await exec(
      'pi',
      ['auth', 'check', '--provider', PI_GATEWAY_PROVIDER, '--no-refresh'],
      { timeout: opts.timeout ?? 5000, cwd: opts.cwd, signal: opts.signal },
    );
    const detail = `${result.stdout}${result.stderr}`.trim();
    return { ready: result.code === 0, detail: detail || `pi auth check exited ${result.code}` };
  } catch (err) {
    return { ready: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
