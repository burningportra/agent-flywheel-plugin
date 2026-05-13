/**
 * T5.1 — First-run detection for `/agent-flywheel:start` Step 0b check 9.
 *
 * Returns true only when **all five** signals are absent — i.e. this is a
 * truly fresh project that's never seen the flywheel before. Any one of
 * the signals firing means the operator has run the flywheel here before
 * (so the tutorial-bead offer in Step 0d must be suppressed).
 *
 * Signals (each independently sufficient to flip the result to false):
 *   1. `.pi-flywheel/checkpoint.json` exists
 *   2. `br` has open or closed beads under this cwd (`brList().length > 0`)
 *   3. Any `docs/plans/*.md` plan file exists
 *   4. `.pi-orchestrator/` directory exists (legacy / orchestrator state)
 *   5. CASS returned ≥1 entry for this cwd (`cassSearch().length > 0`)
 *
 * `brList` and `cassSearch` are injected so tests can run hermetically
 * without spawning the real CLIs; production callers should pass thin
 * wrappers around `br list --json` and `cm search --json`.
 */

import { stat, readdir } from "node:fs/promises";
import { join } from "node:path";

export type IsFirstRunOpts = {
  cwd: string;
  brList: () => Promise<unknown[]>;
  cassSearch: () => Promise<unknown[]>;
};

export async function isFirstRun(opts: IsFirstRunOpts): Promise<boolean> {
  const signals = await Promise.all([
    exists(join(opts.cwd, ".pi-flywheel/checkpoint.json")),
    opts.brList().then((d) => d.length > 0).catch(() => false),
    hasAnyPlanMarkdown(opts.cwd),
    exists(join(opts.cwd, ".pi-orchestrator")),
    opts.cassSearch().then((d) => d.length > 0).catch(() => false),
  ]);
  return !signals.some(Boolean);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function hasAnyPlanMarkdown(cwd: string): Promise<boolean> {
  try {
    const entries = await readdir(join(cwd, "docs/plans"));
    return entries.some((name) => name.endsWith(".md"));
  } catch {
    return false;
  }
}
