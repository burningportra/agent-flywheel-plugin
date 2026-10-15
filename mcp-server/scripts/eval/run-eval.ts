#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SCENARIOS } from "./scenarios.js";
import { runScenario } from "./stream.js";
import type { BaselineReport, Scenario, ScenarioResult } from "./types.js";

const DEFAULT_MODEL = process.env.FW_EVAL_MODEL ?? "claude-sonnet-5-5";
const PER_SCENARIO_TIMEOUT_MS = Number(
  process.env.FW_EVAL_TIMEOUT_MS ?? 10 * 60 * 1000,
);
const MAX_BUDGET_USD = Number(process.env.FW_EVAL_MAX_BUDGET_USD ?? 1.0);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const BASELINE_PATH = join(REPO_ROOT, "docs", "perf", "eval-start-baseline.json");
const ARTIFACTS_DIR = join(REPO_ROOT, "mcp-server", "scripts", "eval", "artifacts");

const gitHead = (): { sha: string; dirty: boolean } => {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim().length > 0;
  return { sha, dirty };
};

const sdkVersion = (): string => {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("@anthropic-ai/claude-agent-sdk/package.json") as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
};

const argv = process.argv.slice(2);
const onlyIds = new Set<string>();
let dryRun = false;
let listOnly = false;
let writeBaseline = true;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--only") {
    const next = argv[i + 1] ?? "";
    for (const id of next.split(",")) if (id) onlyIds.add(id.trim());
    i += 1;
  } else if (a === "--dry-run") dryRun = true;
  else if (a === "--list") listOnly = true;
  else if (a === "--no-write-baseline") writeBaseline = false;
}

async function runOne(scenario: Scenario): Promise<ScenarioResult> {
  const started = Date.now();
  const jsonlPath = join(
    ARTIFACTS_DIR,
    `${scenario.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
  );
  const outcome = await runScenario({
    scenario,
    cwd: REPO_ROOT,
    model: DEFAULT_MODEL,
    jsonlPath,
    maxBudgetUsd: MAX_BUDGET_USD,
    timeoutMs: PER_SCENARIO_TIMEOUT_MS,
  });

  const violations = scenario.assert({
    toolUses: outcome.toolUses,
    texts: outcome.texts,
  });
  if (outcome.error) violations.push(`sdk error: ${outcome.error}`);
  if (outcome.timed_out) violations.push("eval timeout before completion");

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
  };
}

async function main(): Promise<number> {
  if (listOnly) {
    for (const s of SCENARIOS) console.log(`${s.id}\t${s.description}`);
    return 0;
  }

  const selected = SCENARIOS.filter((s) => onlyIds.size === 0 || onlyIds.has(s.id));
  if (selected.length === 0) {
    console.error(`No scenarios matched --only=${[...onlyIds].join(",")}`);
    return 2;
  }

  if (dryRun) {
    console.log("Would run:");
    for (const s of selected) console.log(`  - ${s.id} :: ${s.description}`);
    return 0;
  }

  await mkdir(ARTIFACTS_DIR, { recursive: true });
  const { sha, dirty } = gitHead();

  const results: ScenarioResult[] = [];
  for (const scenario of selected) {
    console.log(`\n→ ${scenario.id} :: ${scenario.description}`);
    const result = await runOne(scenario);
    results.push(result);
    const marker = result.status === "pass" ? "✓" : "✗";
    console.log(
      `  ${marker} status=${result.status} turns=${result.turns} tools=${result.tool_use_count} cost=$${(
        result.cost_usd ?? 0
      ).toFixed(4)} dur=${(result.duration_ms / 1000).toFixed(1)}s`,
    );
    for (const v of result.violations) console.log(`    - ${v}`);
  }

  const report: BaselineReport = {
    version: 1,
    git_sha: sha,
    git_dirty: dirty,
    recorded_at: new Date().toISOString(),
    model: DEFAULT_MODEL,
    claude_cli_version: `agent-sdk@${sdkVersion()}`,
    scenarios: results,
  };

  if (writeBaseline) {
    await mkdir(join(REPO_ROOT, "docs", "perf"), { recursive: true });
    await writeFile(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\nBaseline written to ${BASELINE_PATH}`);
  }

  return results.some((r) => r.status === "fail") ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(99);
  },
);
