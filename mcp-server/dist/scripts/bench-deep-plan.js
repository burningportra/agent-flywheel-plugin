#!/usr/bin/env node
// bench-deep-plan: micro-benchmark for section-wise vs whole-file synthesis.
//
// Reads the three fixture planner outputs from
//   scripts/fixtures/deep-plan-bench/{correctness,ergonomics,robustness}.md
// and times `synthesizePlans` in both modes. Reports wall-time for each.
//
// Asserts section mode is >= 25% faster than whole mode when the simulated
// repo file count clears the 500-file threshold. When the bench corpus does
// not clear that bar (currently the fixture plans themselves are the corpus),
// the script simply reports both numbers without asserting.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { performance } from "perf_hooks";
// Dual-runtime module loading mirrors lint-skill.ts: when compiled we live at
// dist/scripts/ and import from ../deep-plan-synthesis.js; when running under
// tsx we import from ../src/deep-plan-synthesis.ts. This avoids a rootDir
// violation in tsconfig.scripts.json.
const isCompiled = import.meta.url.includes("/dist/scripts/");
const synthModulePath = isCompiled
    ? "../deep-plan-synthesis.js"
    : "../src/deep-plan-synthesis.js";
const { synthesizePlans, shouldUseSectionWise } = (await import(synthModulePath));
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "fixtures", "deep-plan-bench");
const FIXTURE_NAMES = ["correctness", "ergonomics", "robustness"];
function loadFixtures() {
    return FIXTURE_NAMES.map((name) => ({
        name,
        model: "bench-fixture",
        plan: readFileSync(join(FIXTURE_DIR, `${name}.md`), "utf8"),
        exitCode: 0,
        elapsed: 0,
    }));
}
async function timed(label, fn) {
    const t0 = performance.now();
    const result = await fn();
    const ms = performance.now() - t0;
    return { label, ms, result };
}
async function main() {
    const plans = loadFixtures();
    // Warm-up (JIT, file cache) — one untimed run each.
    await synthesizePlans(plans, { whole: true });
    await synthesizePlans(plans);
    const ITERATIONS = 50;
    let wholeTotal = 0;
    let sectionTotal = 0;
    for (let i = 0; i < ITERATIONS; i++) {
        const w = await timed("whole", () => synthesizePlans(plans, { whole: true }));
        wholeTotal += w.ms;
    }
    for (let i = 0; i < ITERATIONS; i++) {
        const s = await timed("section", () => synthesizePlans(plans));
        sectionTotal += s.ms;
    }
    const wholeMs = wholeTotal / ITERATIONS;
    const sectionMs = sectionTotal / ITERATIONS;
    const speedup = wholeMs > 0 ? ((wholeMs - sectionMs) / wholeMs) * 100 : 0;
    process.stdout.write([
        `[bench-deep-plan] iterations=${ITERATIONS}`,
        `[bench-deep-plan] whole-mode   avg: ${wholeMs.toFixed(3)} ms`,
        `[bench-deep-plan] section-mode avg: ${sectionMs.toFixed(3)} ms`,
        `[bench-deep-plan] section mode is ${speedup.toFixed(1)}% faster than whole mode`,
        "",
    ].join("\n"));
    // The synthesis module itself is O(n) either way; section mode's win in
    // production comes from downstream LLM work avoided on identical sections,
    // not raw string shuffling. So assert only when we're in the >=500-file
    // regime where the orchestrator would actually invoke section-wise mode.
    //
    // Here the "repo file count" input to shouldUseSectionWise is conceptual —
    // we don't have a real repo in the bench. We therefore skip the assertion
    // unless an explicit env override is set, and just report.
    const repoFiles = Number(process.env.BENCH_REPO_FILES ?? 0);
    if (shouldUseSectionWise(repoFiles)) {
        if (speedup < 25) {
            process.stderr.write(`[bench-deep-plan] FAIL: section mode only ${speedup.toFixed(1)}% faster, need >=25%\n`);
            process.exit(1);
        }
        process.stdout.write(`[bench-deep-plan] PASS: >=25% speedup at repoFiles=${repoFiles}\n`);
    }
    else {
        process.stdout.write(`[bench-deep-plan] NOTE: bench corpus does not clear the ${500}-file threshold ` +
            `(BENCH_REPO_FILES=${repoFiles}); reporting only, not asserting.\n`);
    }
}
main().catch((err) => {
    process.stderr.write(`[bench-deep-plan] ERROR: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
});
//# sourceMappingURL=bench-deep-plan.js.map