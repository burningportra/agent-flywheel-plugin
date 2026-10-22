/**
 * br_config_latency remediation — set `no_auto_flush: true` and
 * `metrics.disabled: true` in `<cwd>/.beads/config.yaml` so `br update` stays
 * under its 5000ms timeout on external APFS/SMB volumes.
 *
 * Edits go through the `yaml` Document API, so comments and unrelated keys
 * survive. An existing file is copied to `.beads/config.yaml.bak` before the
 * rewrite; a missing file is created. Mutating, reversible.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { HandlerCtx, RemediationHandler } from '../remediate.js';
import { missingLowLatencyBrSettings } from '../doctor.js';
import { writeAtomic } from '../../atomic-write.js';

function configPath(cwd: string): string {
  return join(cwd, '.beads', 'config.yaml');
}

/**
 * Returns `raw` with both low-latency settings applied, or `raw` unchanged
 * when it already sets them. Throws when `raw` is not a YAML mapping.
 */
export function ensureLowLatencyBrConfig(raw: string): string {
  if (missingLowLatencyBrSettings(raw).length === 0) return raw;
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) throw doc.errors[0]!;
  doc.setIn(['no_auto_flush'], true);
  doc.setIn(['metrics', 'disabled'], true);
  return doc.toString();
}

export const brConfigLatencyHandler: RemediationHandler = {
  description: 'Set no_auto_flush: true and metrics.disabled: true in .beads/config.yaml.',
  mutating: true,
  reversible: true,

  async buildPlan({ cwd }: HandlerCtx) {
    const target = configPath(cwd);
    return {
      description: this.description,
      steps: existsSync(target)
        ? [`cp ${target} ${target}.bak`, `set no_auto_flush: true and metrics.disabled: true in ${target}`]
        : [`create ${target} with no_auto_flush: true and metrics.disabled: true`],
      mutating: this.mutating,
      reversible: this.reversible,
    };
  },

  async execute({ cwd }: HandlerCtx) {
    if (!existsSync(join(cwd, '.beads'))) {
      return { stepsRun: 0, stdout: 'no .beads directory — nothing to change' };
    }
    const target = configPath(cwd);
    if (!existsSync(target)) {
      await writeAtomic(target, ensureLowLatencyBrConfig(''));
      return { stepsRun: 1, stdout: `created ${target}` };
    }
    const raw = readFileSync(target, 'utf8');
    const next = ensureLowLatencyBrConfig(raw);
    if (next === raw) return { stepsRun: 0, stdout: `${target} already low-latency` };
    const backup = `${target}.bak`;
    await writeAtomic(backup, raw);
    await writeAtomic(target, next);
    return { stepsRun: 2, stdout: `updated ${target}; backup at ${backup}` };
  },

  async verifyProbe({ cwd }: HandlerCtx) {
    if (!existsSync(join(cwd, '.beads'))) return true;
    const target = configPath(cwd);
    if (!existsSync(target)) return false;
    try {
      return missingLowLatencyBrSettings(readFileSync(target, 'utf8')).length === 0;
    } catch {
      return false;
    }
  },
};
