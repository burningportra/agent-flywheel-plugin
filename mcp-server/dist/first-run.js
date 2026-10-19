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
 * The three filesystem signals are checked first, and a hit returns without
 * spawning `br` or `cass`. Otherwise both probes run, and the answer comes
 * as soon as either reports history, since `cass search ""` can take
 * seconds on a large index.
 *
 * `brList` and `cassSearch` are injected so tests can run hermetically
 * without spawning the real CLIs; production callers should pass bounded
 * wrappers around `br list --all --limit 1 --json` and project-scoped
 * `cass search "" --limit 1 --fields minimal --json`.
 */
import { stat, readdir } from "node:fs/promises";
import { join } from "node:path";
export async function isFirstRun(opts) {
    const local = await Promise.all([
        exists(join(opts.cwd, ".pi-flywheel/checkpoint.json")),
        hasAnyPlanMarkdown(opts.cwd),
        exists(join(opts.cwd, ".pi-orchestrator")),
    ]);
    if (local.some(Boolean))
        return false;
    const seen = await Promise.any([opts.brList(), opts.cassSearch()].map((probe) => probe.then((rows) => (rows.length > 0 ? true : Promise.reject(new Error("no history")))))).catch(() => false);
    return !seen;
}
async function exists(p) {
    try {
        await stat(p);
        return true;
    }
    catch {
        return false;
    }
}
async function hasAnyPlanMarkdown(cwd) {
    try {
        const entries = await readdir(join(cwd, "docs/plans"));
        return entries.some((name) => name.endsWith(".md"));
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=first-run.js.map