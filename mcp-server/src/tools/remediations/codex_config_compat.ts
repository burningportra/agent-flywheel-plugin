/**
 * codex_config_compat remediation — comment out the top-level
 * `model = "gpt-5*"` / `"o4-mini*"` line in ~/.codex/config.toml that breaks
 * the codex-companion app-server on ChatGPT-account auth (bead `cif`,
 * surfaced by the same-named doctor check).
 *
 * Strategy:
 *   1. Read ~/.codex/config.toml. Locate the same top-level `model = "..."`
 *      line the doctor parser finds — bail green if it's absent / commented /
 *      below a `[section]` / set to a compatible model.
 *   2. Write a timestamped backup (`config.toml.bak.<iso-ts>`) BEFORE mutating
 *      the original. Hard-fails the run if the backup write fails so we never
 *      mutate without recovery.
 *   3. Atomically rewrite the config with that exact line prefixed by `# ` so
 *      the codex-companion app-server falls through to its built-in default.
 *      Untouched lines are byte-stable.
 *   4. verifyProbe re-reads the file via `parseCodexConfigTopLevelModel` and
 *      asserts the offending model is gone (either null or now compatible).
 *
 * Reversible: `mv ~/.codex/config.toml.bak.<ts> ~/.codex/config.toml` restores
 * the pre-remediation state. Backup files are never auto-deleted.
 *
 * Mutating, reversible. Refuses `autoConfirm:false` in execute mode (enforced
 * by the dispatcher in remediate.ts).
 *
 * Bead: claude-orchestrator-3s58 (reality-check-2026-05-15).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HandlerCtx, RemediationHandler } from '../remediate.js';
import {
  parseCodexConfigTopLevelModel,
  isCodexIncompatibleModel,
} from '../doctor.js';
import { writeAtomic } from '../../atomic-write.js';
import { createLogger } from '../../logger.js';

const log = createLogger('remediation.codex_config_compat');

/** Resolved at call time so tests can swap `HOME` / `process.env.HOME`. */
function codexConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml');
}

function backupPathFor(target: string, tsIso: string): string {
  // Filesystem-safe timestamp (mirrors checkpoint_validity backup naming).
  const safeTs = tsIso.replace(/[:.]/g, '-');
  return `${target}.bak.${safeTs}`;
}

/**
 * Same matcher used by `parseCodexConfigTopLevelModel`, but kept inline so
 * the rewrite step doesn't depend on doctor.ts' internals. The two MUST stay
 * in sync — the unit test for this handler asserts they agree.
 */
const TOP_LEVEL_MODEL_LINE = /^(\s*)model(\s*=\s*"[^"]*"\s*(?:#.*)?)$/;

interface RewriteResult {
  rewritten: string;
  /** Original line, untrimmed; null if no rewrite happened. */
  changedLine: string | null;
  /** 1-based line number, or null if no change. */
  changedLineNumber: number | null;
}

/**
 * Comment out the first top-level (pre-`[section]`) `model = "..."` line.
 * Returns the rewritten content and a small audit envelope. If no eligible
 * line is found (already commented, below a section header, or absent), the
 * content is returned unchanged with `changedLine: null`.
 *
 * Exported for unit-test access.
 */
export function commentOutTopLevelModel(content: string): RewriteResult {
  const lines = content.split('\n');
  let i = 0;
  for (; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (line.startsWith('[')) {
      // Hit the first section header before finding a top-level model. No-op.
      return { rewritten: content, changedLine: null, changedLineNumber: null };
    }
    if (line.startsWith('#') || line.length === 0) continue;
    if (TOP_LEVEL_MODEL_LINE.test(raw)) {
      // Comment out by prepending `# ` (preserve original spacing & comment
      // trailer so a future operator can reverse with a one-liner).
      const original = raw;
      lines[i] = `# ${raw}`;
      return {
        rewritten: lines.join('\n'),
        changedLine: original,
        changedLineNumber: i + 1,
      };
    }
  }
  // Walked the whole file with no model line and no section header.
  return { rewritten: content, changedLine: null, changedLineNumber: null };
}

export const codexConfigCompatHandler: RemediationHandler = {
  description:
    'Comment out incompatible top-level model line in ~/.codex/config.toml (with timestamped backup)',
  mutating: true,
  reversible: true,

  async buildPlan(_ctx: HandlerCtx) {
    const target = codexConfigPath();
    if (!existsSync(target)) {
      return {
        description: 'No ~/.codex/config.toml present — nothing to remediate.',
        steps: [],
        mutating: false,
        reversible: true,
      };
    }
    let content: string;
    try {
      content = readFileSync(target, 'utf8');
    } catch (err) {
      log.warn('buildPlan: could not read codex config', { err: String(err) });
      return {
        description: `Cannot read ${target}: ${String(err)}`,
        steps: [],
        mutating: false,
        reversible: true,
      };
    }
    const model = parseCodexConfigTopLevelModel(content);
    if (model === null) {
      return {
        description:
          'No top-level `model = ...` override in ~/.codex/config.toml — already compatible.',
        steps: [],
        mutating: false,
        reversible: true,
      };
    }
    if (!isCodexIncompatibleModel(model)) {
      return {
        description: `~/.codex/config.toml sets model="${model}" — already compatible with codex-companion app-server.`,
        steps: [],
        mutating: false,
        reversible: true,
      };
    }
    return {
      description:
        `Back up ~/.codex/config.toml to ~/.codex/config.toml.bak.<timestamp>, then comment out the line setting model="${model}" so the codex-companion app-server falls through to its built-in default. Restore with \`mv\` from the .bak file.`,
      steps: [
        'cp ~/.codex/config.toml ~/.codex/config.toml.bak.<ts>',
        'sed -i \'s/^\\s*model = "..."/# &/\' ~/.codex/config.toml  # only the top-level line',
      ],
      mutating: true,
      reversible: true,
    };
  },

  async execute(_ctx: HandlerCtx) {
    const target = codexConfigPath();
    if (!existsSync(target)) {
      return { stepsRun: 0, stdout: 'no ~/.codex/config.toml — nothing to do' };
    }
    let content: string;
    try {
      content = readFileSync(target, 'utf8');
    } catch (err) {
      log.warn('execute: could not read codex config', { err: String(err) });
      return { stepsRun: 0, stderr: `could not read ${target}: ${String(err)}` };
    }
    const model = parseCodexConfigTopLevelModel(content);
    if (model === null || !isCodexIncompatibleModel(model)) {
      return {
        stepsRun: 0,
        stdout: model === null
          ? 'no top-level model line — nothing to do'
          : `model="${model}" already compatible — nothing to do`,
      };
    }
    const { rewritten, changedLine, changedLineNumber } =
      commentOutTopLevelModel(content);
    if (changedLine === null) {
      // Parser said the model was set but the line matcher disagreed (edge
      // case: parser is more permissive). Refuse to mutate.
      log.warn('execute: parser/matcher disagreement — refusing to mutate', {
        model,
      });
      return {
        stepsRun: 0,
        stderr: `parser found model="${model}" but the line matcher could not locate it — refusing to edit blindly`,
      };
    }

    // 1. Write the backup FIRST. If this fails the original is untouched.
    const tsIso = new Date().toISOString();
    const backup = backupPathFor(target, tsIso);
    try {
      await writeAtomic(backup, content);
    } catch (err) {
      log.warn('execute: backup write failed — aborting', { backup, err: String(err) });
      return {
        stepsRun: 0,
        stderr: `failed to write backup at ${backup}: ${String(err)}`,
      };
    }

    // 2. Atomic rewrite of the original.
    try {
      await writeAtomic(target, rewritten);
    } catch (err) {
      log.warn('execute: rewrite failed AFTER backup', { target, backup, err: String(err) });
      return {
        stepsRun: 1,
        stderr: `backup at ${backup} succeeded but rewrite of ${target} failed: ${String(err)}`,
      };
    }
    return {
      stepsRun: 2,
      stdout:
        `commented out line ${changedLineNumber} (model="${model}") in ${target}; backup at ${backup}`,
    };
  },

  async verifyProbe(_ctx: HandlerCtx) {
    const target = codexConfigPath();
    if (!existsSync(target)) {
      // Missing file is green per the doctor check semantics.
      return true;
    }
    let content: string;
    try {
      content = readFileSync(target, 'utf8');
    } catch {
      return false;
    }
    const model = parseCodexConfigTopLevelModel(content);
    if (model === null) return true;
    return !isCodexIncompatibleModel(model);
  },
};
