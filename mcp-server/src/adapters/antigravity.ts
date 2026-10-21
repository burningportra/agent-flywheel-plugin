/**
 * Antigravity (`agy`) lane helpers: detect the CLI, list its models, turn a
 * model plus effort into the slug `agy models` prints, build the `ntm spawn
 * --agy` flag, and run `scripts/sync-agy.sh`, which mirrors this plugin into
 * Antigravity's plugin directory.
 *
 * `agy models` lists only effort-suffixed slugs (`gemini-4-argon-high`); there
 * is no bare `gemini-4-argon`, so a model without a suffix gets one.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExecFn } from '../exec.js';
import { CURRENT_GEMINI_MODEL_ID } from '../model-detection.js';

export const AGY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgyEffort = (typeof AGY_EFFORTS)[number];
export const DEFAULT_AGY_EFFORT: AgyEffort = 'high';

const AGY_VERSION_TIMEOUT_MS = 5_000;
const AGY_MODELS_TIMEOUT_MS = 20_000;
const NTM_HELP_TIMEOUT_MS = 5_000;
const AGY_SLUG_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;
const AGY_EFFORT_SUFFIX = new RegExp(`-(${AGY_EFFORTS.join('|')})$`);

/** Where `agy/manifest.json` sends the port when it names no target. */
export const DEFAULT_AGY_PORT_TARGET = join(homedir(), '.gemini', 'antigravity', 'plugins', 'agent-flywheel');

/** The running plugin's root: `src/adapters/` and `dist/adapters/` both sit two levels under `mcp-server/`. */
export const RUNNING_PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface AgyCliStatus {
  available: boolean;
  /** True when `agy` is on PATH, even if `agy --version` failed. */
  installed: boolean;
  version?: string;
  path?: string;
  reason?: string;
}

export interface AgyModel {
  slug: string;
  name: string;
}

export type AgyModelsResult = { ok: true; models: AgyModel[] } | { ok: false; reason: string };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function detectAgyCli(
  exec: ExecFn,
  signal?: AbortSignal,
  timeout = AGY_VERSION_TIMEOUT_MS,
): Promise<AgyCliStatus> {
  let reason: string;
  try {
    const res = await exec('agy', ['--version'], { timeout, signal });
    const version = res.stdout.trim().split('\n')[0] ?? '';
    if (res.code === 0 && version.length > 0) return { available: true, installed: true, version };
    reason = res.stderr.trim() || `agy --version exited ${res.code}`;
  } catch (err) {
    reason = errText(err);
  }
  try {
    const which = await exec('which', ['agy'], { timeout, signal });
    const path = which.stdout.trim().split('\n')[0] ?? '';
    if (which.code === 0 && path.length > 0) return { available: false, installed: true, path, reason };
  } catch {
    // Same answer as a failed `which`: not on PATH.
  }
  return { available: false, installed: false, reason: 'agy is not on PATH' };
}

/** Parses `agy models`: one `slug<TAB>display name` row per model, after a "Fetching…" banner. */
export async function probeAgyModels(
  exec: ExecFn,
  signal?: AbortSignal,
  timeout = AGY_MODELS_TIMEOUT_MS,
): Promise<AgyModelsResult> {
  try {
    const res = await exec('agy', ['models'], { timeout, signal });
    if (res.code !== 0) return { ok: false, reason: res.stderr.trim() || `agy models exited ${res.code}` };
    const models = res.stdout
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((cols): cols is [string, string] => cols.length >= 2 && AGY_SLUG_PATTERN.test(cols[0]!.trim()))
      .map(([slug, name]) => ({ slug: slug.trim(), name: name.trim() }));
    if (models.length === 0) return { ok: false, reason: 'agy models listed no models' };
    return { ok: true, models };
  } catch (err) {
    return { ok: false, reason: errText(err) };
  }
}

/**
 * `gemini-4-argon` + `high` → `gemini-4-argon-high`. A slug that already
 * ends in an effort keeps it; a bare model with no effort gets
 * {@link DEFAULT_AGY_EFFORT}.
 */
export function resolveAgySlug(model: string = CURRENT_GEMINI_MODEL_ID, effort?: AgyEffort): string {
  if (AGY_EFFORT_SUFFIX.test(model)) return model;
  return `${model}-${effort ?? DEFAULT_AGY_EFFORT}`;
}

/** `ntm spawn` flags for `count` agy panes: `--agy=N`, or `--agy=N:<slug>` when a model or effort is given. */
export function buildAgyNtmArgs(count: number, model?: string, effort?: AgyEffort): string[] {
  if (!Number.isInteger(count) || count < 0) throw new Error(`agy pane count must be a non-negative integer, got ${count}`);
  if (count === 0) return [];
  if (model === undefined && effort === undefined) return [`--agy=${count}`];
  if (model !== undefined && !AGY_SLUG_PATTERN.test(model)) {
    throw new Error(`agy model must be a slug from \`agy models\` (lowercase, no spaces), got ${JSON.stringify(model)}`);
  }
  if (effort !== undefined && !AGY_EFFORTS.includes(effort)) throw new Error(`unknown agy effort ${JSON.stringify(effort)}`);
  return [`--agy=${count}:${resolveAgySlug(model, effort)}`];
}

/** True when this ntm's `spawn --help` lists `--agy` (ntm v1.37+). */
export async function probeNtmAgySupport(exec: ExecFn, signal?: AbortSignal, timeout = NTM_HELP_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await exec('ntm', ['spawn', '--help'], { timeout, signal });
    return res.code === 0 && /--agy\b/.test(res.stdout + res.stderr);
  } catch {
    return false;
  }
}

// ─── scripts/sync-agy.sh ──────────────────────────────────────────────────

export type SyncAgyMode = 'check' | 'write' | 'prune';

export interface SyncAgySummary {
  ok: number;
  add: number;
  update: number;
  local: number;
  prune: number;
  total: number;
}

export interface SyncAgyReport {
  mode: SyncAgyMode;
  target: string;
  summary: SyncAgySummary;
  [key: string]: unknown;
}

export interface SyncAgyRun {
  /** 0 = in sync, 1 = drift or findings, 2 = usage or setup failure. */
  code: number;
  report?: SyncAgyReport;
  stderr: string;
}

/** The plugin root holding `scripts/sync-agy.sh`: `cwd` when it is this plugin's checkout, else the running plugin. */
export function findSyncAgyScript(cwd: string): { pluginRoot: string; script: string } | null {
  for (const pluginRoot of [cwd, RUNNING_PLUGIN_ROOT]) {
    const script = join(pluginRoot, 'scripts', 'sync-agy.sh');
    if (existsSync(script)) return { pluginRoot, script };
  }
  return null;
}

/** The port target from `<pluginRoot>/agy/manifest.json`, with `~` expanded. */
export function resolveAgyPortTarget(pluginRoot: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, 'agy', 'manifest.json'), 'utf8')) as { target?: unknown };
    if (typeof manifest.target === 'string' && manifest.target.length > 0) {
      if (manifest.target === '~') return homedir();
      return manifest.target.startsWith('~/') ? join(homedir(), manifest.target.slice(2)) : resolve(pluginRoot, manifest.target);
    }
  } catch {
    // No manifest: the script's own default applies.
  }
  return DEFAULT_AGY_PORT_TARGET;
}

export async function runSyncAgy(
  exec: ExecFn,
  opts: { script: string; pluginRoot: string; mode: SyncAgyMode; target?: string; timeout: number; signal?: AbortSignal },
): Promise<SyncAgyRun> {
  const args = [opts.script, `--${opts.mode}`, '--json', ...(opts.target ? ['--target', opts.target] : [])];
  const res = await exec('bash', args, { timeout: opts.timeout, cwd: opts.pluginRoot, signal: opts.signal });
  try {
    const parsed = JSON.parse(res.stdout) as SyncAgyReport;
    if (parsed && typeof parsed === 'object' && parsed.summary) return { code: res.code, report: parsed, stderr: res.stderr };
  } catch {
    // Usage and setup failures print to stderr only.
  }
  return { code: res.code, stderr: res.stderr.trim() || res.stdout.trim() || `sync-agy exited ${res.code}` };
}

export function describeSyncAgySummary(summary: SyncAgySummary): string {
  return `${summary.ok}/${summary.total} ok, ${summary.add} add, ${summary.update} update, ${summary.local} local edits, ${summary.prune} prune`;
}

export const AntigravityAdapter = {
  detectAgyCli,
  probeAgyModels,
  resolveAgySlug,
  buildAgyNtmArgs,
  probeNtmAgySupport,
} as const;
