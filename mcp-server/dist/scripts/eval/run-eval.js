#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgv } from "./argv.js";
import { SCENARIOS } from "./scenarios.js";
import { runScenario } from "./stream.js";
const DEFAULT_MODEL = process.env.FW_EVAL_MODEL ?? "claude-sonnet-5-5";
const PER_SCENARIO_TIMEOUT_MS = Number(process.env.FW_EVAL_TIMEOUT_MS ?? 10 * 60 * 1000);
const MAX_BUDGET_USD = Number(process.env.FW_EVAL_MAX_BUDGET_USD ?? 1.0);
const SCRATCH_ROOT = process.env.FW_EVAL_SCRATCH ?? "/tmp/claude-501/fw-eval";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const BASELINE_PATH = join(REPO_ROOT, "docs", "perf", "eval-start-baseline.json");
const ARTIFACTS_DIR = join(REPO_ROOT, "mcp-server", "scripts", "eval", "artifacts");
const MAIN_NODE_MODULES = join(REPO_ROOT, "mcp-server", "node_modules");
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
const shLog = (cmd, args, cwd) => {
    execFileSync(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
};
const slugifyGoal = (goal) => goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "plan";
const todayDate = () => {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
};
const brainstormBody = (goal) => `# Brainstorm — ${goal}

**Date:** ${todayDate()}

## Framing synthesis

The orchestrator has enough context: the goal names the concrete surface
to change, the constraint ("don't break existing consumers"), and the
measurable outcome. No further framing round is needed.

## Scope floor

The smallest version is the goal as stated: the single surface edit, with
tests covering the before/after behavior and a one-line entry in the
relevant doc.

## Ambition ceiling

The 10x version keeps the same surface but extends it with a schema'd
output and a doctor row so downstream tooling can key on it. Not required
for the floor.
`;
const sdkVersion = () => {
    const path = join(REPO_ROOT, "mcp-server", "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
    try {
        const pkg = JSON.parse(readFileSync(path, "utf8"));
        return pkg.version ?? "unknown";
    }
    catch {
        return "unknown";
    }
};
const claudeCliVersion = () => {
    try {
        return sh("claude", ["--version"]);
    }
    catch {
        return "unavailable";
    }
};
async function setupWorktree(scenarioId, sha) {
    await mkdir(SCRATCH_ROOT, { recursive: true });
    const dir = await mkdtemp(join(SCRATCH_ROOT, `${scenarioId}-`));
    sh("git", ["worktree", "add", "-f", "--detach", dir, sha], REPO_ROOT);
    // Share node_modules via symlink so `npm run build` can resolve
    // dependencies in the worktree without re-installing.
    const worktreeNm = join(dir, "mcp-server", "node_modules");
    if (!existsSync(worktreeNm) && existsSync(MAIN_NODE_MODULES)) {
        symlinkSync(MAIN_NODE_MODULES, worktreeNm);
    }
    // Build the worktree's dist/ and skills.bundle.json so the plugin's
    // MCP server reflects the sha under test, not whatever `dist/` the
    // committed worktree carries.
    console.log("  building worktree (npm run build)...");
    try {
        shLog("npm", ["run", "build"], join(dir, "mcp-server"));
    }
    catch (err) {
        throw new Error(`worktree build failed: ${String(err)}`);
    }
    return dir;
}
async function removeWorktree(dir) {
    try {
        sh("git", ["worktree", "remove", "-f", dir], REPO_ROOT);
    }
    catch {
        /* non-fatal — leaves disk state for inspection */
    }
}
async function writeBrainstorm(cwd, goal) {
    const cleaned = goal.replace(/^\/agent-flywheel:start\s+/, "");
    const slug = slugifyGoal(cleaned);
    const path = join(cwd, "docs", "brainstorms", `${slug}-${todayDate()}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, brainstormBody(cleaned), "utf8");
    return path;
}
async function runOne(scenario, baseSha, keepWorktrees) {
    const started = Date.now();
    let cwd = "";
    let brainstormPath = "";
    try {
        cwd = await setupWorktree(scenario.id, baseSha);
        brainstormPath = await writeBrainstorm(cwd, scenario.goal);
        if (scenario.prepareFixtures) {
            await scenario.prepareFixtures(cwd);
        }
    }
    catch (err) {
        return {
            id: scenario.id,
            description: scenario.description,
            status: "fail",
            violations: [`fixture setup failed: ${String(err)}`],
            turns: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
            tool_use_count: 0,
            artifact_path: "",
            duration_ms: Date.now() - started,
        };
    }
    const jsonlPath = join(ARTIFACTS_DIR, `${scenario.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    const outcome = await runScenario({
        scenario,
        cwd,
        model: DEFAULT_MODEL,
        jsonlPath,
        maxBudgetUsd: MAX_BUDGET_USD,
        timeoutMs: PER_SCENARIO_TIMEOUT_MS,
    });
    const violations = scenario.assert({
        toolUses: outcome.toolUses,
        texts: outcome.texts,
    });
    if (outcome.plugin_check.kind !== "ok") {
        if (outcome.plugin_check.kind === "fail") {
            violations.push(`agent-flywheel plugin check failed — loaded from ${outcome.plugin_check.actual ?? "(none)"} instead of worktree ${outcome.plugin_check.expected}`);
        }
        else {
            violations.push("no system init message received; plugin path unverified");
        }
    }
    if (outcome.skill_stub_detected) {
        violations.push("harness: Skill(agent-flywheel:*) tool_result contained \"already loaded above\" — pointer-command dedup kept the skill body from arriving (see agent-flywheel-plugin-m66.1.5). This run is on the recovery path, not /start; discard it.");
    }
    for (const ev of outcome.pick_events) {
        if (ev.kind === "unmatched") {
            violations.push(`harness: scripted target "${ev.ruleTarget}" matched no option at header "${ev.header}" on turn ${ev.turn}; offered [${ev.labels.join(", ")}]`);
        }
        // "default" picks are logged in JSONL but not scenario-fatal.
    }
    if (outcome.error)
        violations.push(`sdk error: ${outcome.error}`);
    if (outcome.timed_out)
        violations.push("eval timeout before completion");
    if (!keepWorktrees)
        await removeWorktree(cwd);
    const status = violations.length === 0 ? "pass" : "fail";
    return {
        id: scenario.id,
        description: scenario.description,
        status,
        violations,
        turns: outcome.turns,
        stop_reason: outcome.stop_reason,
        usage: outcome.usage,
        cost_usd: outcome.cost_usd,
        tool_use_count: outcome.toolUses.length,
        artifact_path: jsonlPath,
        duration_ms: Date.now() - started,
        ...(keepWorktrees ? { worktree: cwd, brainstorm_path: brainstormPath } : {}),
    };
}
async function main() {
    const parsed = parseArgv(process.argv.slice(2));
    if (parsed.kind === "help") {
        console.log(parsed.text);
        return 0;
    }
    if (parsed.kind === "error") {
        console.error(parsed.message);
        return parsed.exitCode;
    }
    const { onlyIds, sha: shaArg, listOnly, dryRun, writeBaseline, appendBaseline, keepWorktrees } = parsed;
    if (listOnly) {
        for (const s of SCENARIOS)
            console.log(`${s.id}\t${s.description}`);
        return 0;
    }
    const sha = shaArg ?? sh("git", ["rev-parse", "HEAD"], REPO_ROOT);
    const selected = SCENARIOS.filter((s) => onlyIds.size === 0 || onlyIds.has(s.id));
    if (selected.length === 0) {
        console.error(`No scenarios matched --only=${[...onlyIds].join(",")}`);
        return 2;
    }
    if (dryRun) {
        console.log(`Would run (worktrees from sha ${sha}):`);
        for (const s of selected)
            console.log(`  - ${s.id} :: ${s.description}`);
        return 0;
    }
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    const results = [];
    for (const scenario of selected) {
        console.log(`\n→ ${scenario.id} :: ${scenario.description}`);
        const result = await runOne(scenario, sha, keepWorktrees);
        results.push(result);
        const marker = result.status === "pass" ? "✓" : "✗";
        console.log(`  ${marker} status=${result.status} turns=${result.turns} tools=${result.tool_use_count} cost=$${(result.cost_usd ?? 0).toFixed(4)} dur=${(result.duration_ms / 1000).toFixed(1)}s`);
        for (const v of result.violations)
            console.log(`    - ${v}`);
    }
    const report = {
        version: 1,
        git_sha: sha,
        git_dirty: false,
        recorded_at: new Date().toISOString(),
        model: DEFAULT_MODEL,
        claude_cli_version: `agent-sdk@${sdkVersion()} / cli@${claudeCliVersion()}`,
        scenarios: results,
    };
    if (writeBaseline) {
        await mkdir(join(REPO_ROOT, "docs", "perf"), { recursive: true });
        await writeFile(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
        console.log(`\nBaseline written to ${BASELINE_PATH}`);
    }
    else if (appendBaseline) {
        const merged = await mergeBaselineRows(report);
        await writeFile(BASELINE_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
        console.log(`\nBaseline rows merged into ${BASELINE_PATH} (${results.length} scenario(s) replaced/added).`);
    }
    else {
        console.log(`\nBaseline NOT written (pass --write-baseline for a full rewrite or --append-baseline to merge selected rows).`);
    }
    return results.some((r) => r.status === "fail") ? 1 : 0;
}
async function mergeBaselineRows(report) {
    if (!existsSync(BASELINE_PATH))
        return report;
    const prevText = readFileSync(BASELINE_PATH, "utf8");
    const prev = JSON.parse(prevText);
    const byId = new Map(prev.scenarios.map((s) => [s.id, s]));
    for (const s of report.scenarios)
        byId.set(s.id, s);
    return {
        version: prev.version,
        git_sha: report.git_sha,
        git_dirty: report.git_dirty,
        recorded_at: report.recorded_at,
        model: report.model,
        claude_cli_version: report.claude_cli_version,
        scenarios: [...byId.values()],
    };
}
main().then((code) => process.exit(code), (err) => {
    console.error(err);
    process.exit(99);
});
//# sourceMappingURL=run-eval.js.map