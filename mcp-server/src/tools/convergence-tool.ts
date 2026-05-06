/**
 * `flywheel_convergence` — read-only handler that returns the persisted
 * convergence state for a plan slug.
 *
 * Path: `.pi-flywheel/plans/<slug>/convergence.json` (per Phase 12 §12.3 cuts —
 * NO `.flywheel/` rename).
 *
 * State writes use the existing `writeFile`/`mkdir` pattern from
 * `completion-report.ts` (no new atomic-write infrastructure per opus §4.2).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';

import type { McpToolResult, ToolContext } from '../types.js';
import {
  parseConvergenceState,
  ConvergenceStateSchema,
  type ConvergenceState,
  SCORE_VERSION,
} from '../convergence.js';
import { makeToolResult } from './shared.js';
import { createLogger } from '../logger.js';

const log = createLogger('convergence-tool');

export const CONVERGENCE_DIR = '.pi-flywheel/plans';

/** Slugify a plan path (or arbitrary identifier) into a filesystem-safe directory name. */
export function planSlugFromIdentifier(identifierOrPath: string): string {
  const base = path.basename(identifierOrPath).replace(/\.(md|MD)$/, '');
  return base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function convergencePath(cwd: string, planSlug: string): string {
  const slug = planSlugFromIdentifier(planSlug);
  return path.join(cwd, CONVERGENCE_DIR, slug, 'convergence.json');
}

export interface ConvergenceToolArgs {
  cwd: string;
  planSlug: string;
}

type ConvergenceStructuredOk = {
  tool: 'flywheel_convergence';
  version: 1;
  status: 'ok';
  data: { kind: 'convergence_state'; state: ConvergenceState };
};

type ConvergenceStructuredNotFound = {
  tool: 'flywheel_convergence';
  version: 1;
  status: 'not_found';
  data: null;
  message: string;
  path: string;
};

type ConvergenceStructuredError = {
  tool: 'flywheel_convergence';
  version: 1;
  status: 'error';
  data: null;
  code: 'invalid_json' | 'schema_invalid' | 'score_version_mismatch' | 'invalid_input';
  message: string;
  path?: string;
};

export type ConvergenceStructured =
  | ConvergenceStructuredOk
  | ConvergenceStructuredNotFound
  | ConvergenceStructuredError;

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

export async function readConvergenceFromDisk(
  cwd: string,
  planSlug: string,
): Promise<ConvergenceStructured> {
  const filePath = convergencePath(cwd, planSlug);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return {
        tool: 'flywheel_convergence',
        version: 1,
        status: 'not_found',
        data: null,
        message: `No convergence state for plan slug ${JSON.stringify(planSlug)}.`,
        path: filePath,
      };
    }
    return {
      tool: 'flywheel_convergence',
      version: 1,
      status: 'error',
      data: null,
      code: 'invalid_json',
      message: `read failed: ${String(err)}`,
      path: filePath,
    };
  }
  const parsed = parseConvergenceState(raw);
  if (!parsed.ok) {
    return {
      tool: 'flywheel_convergence',
      version: 1,
      status: 'error',
      data: null,
      code: parsed.error.code,
      message: parsed.error.message,
      path: filePath,
    };
  }
  return {
    tool: 'flywheel_convergence',
    version: 1,
    status: 'ok',
    data: { kind: 'convergence_state', state: parsed.state },
  };
}

/**
 * Persist a convergence state to disk. Writes are simple `mkdir -p` + `writeFile`
 * (matches `writeCompletionReport` in `completion-report.ts`). The state schema's
 * own `scoreVersion` literal makes recovery from older states an explicit migration.
 */
export async function writeConvergenceToDisk(
  cwd: string,
  state: ConvergenceState,
): Promise<{ path: string }> {
  // Validate before persist — refuse to write a malformed state.
  ConvergenceStateSchema.parse(state);
  if (state.scoreVersion !== SCORE_VERSION) {
    throw new Error(
      `writeConvergenceToDisk: refusing to write state with scoreVersion=${state.scoreVersion} (current=${SCORE_VERSION})`,
    );
  }
  const filePath = convergencePath(cwd, state.planSlug);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return { path: filePath };
}

export async function runConvergence(
  ctx: ToolContext,
  args: ConvergenceToolArgs,
): Promise<McpToolResult> {
  const planSlugRaw = (args as { planSlug?: unknown }).planSlug;
  if (typeof planSlugRaw !== 'string' || planSlugRaw.trim() === '') {
    const errored: ConvergenceStructured = {
      tool: 'flywheel_convergence',
      version: 1,
      status: 'error',
      data: null,
      code: 'invalid_input',
      message: 'planSlug must be a non-empty string',
    };
    return makeToolResult('Invalid planSlug', errored);
  }
  try {
    const result = await readConvergenceFromDisk(ctx.cwd, planSlugRaw);
    let textSummary: string;
    if (result.status === 'ok') {
      const s = result.data.state;
      textSummary = `convergence(${s.planSlug}): score=${s.score.toFixed(3)} status=${s.status} revisions=${s.revisions.length}/${5}${s.oscillation.detected ? ' OSCILLATING' : ''}`;
    } else if (result.status === 'not_found') {
      textSummary = result.message;
    } else {
      textSummary = `convergence read error: ${result.code} — ${result.message}`;
    }
    return makeToolResult(textSummary, result);
  } catch (err: unknown) {
    log.warn('convergence read threw', { err: String(err) });
    const errored: ConvergenceStructured = {
      tool: 'flywheel_convergence',
      version: 1,
      status: 'error',
      data: null,
      code: 'schema_invalid',
      message: String(err),
    };
    return makeToolResult('convergence read threw', errored);
  }
}
