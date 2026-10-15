#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export type BudgetGroup =
  | "skill"
  | "command"
  | "mcp-text"
  | "mcp-structured"
  | "adapter"
  | "gate";

export interface BudgetEntry {
  id: string;
  group: BudgetGroup;
  source: string;
  chars: number;
  estimatedTokens: number;
}

interface BudgetTotals {
  chars: number;
  estimatedTokens: number;
}

export interface PromptBudgetReport {
  version: 1;
  gitHead: string;
  sourceMode: "committed-head" | "working-tree";
  tokenEstimate: "ceil(chars / 4)";
  thresholdPercent: 10;
  entries: BudgetEntry[];
  totals: {
    all: BudgetTotals;
    startCycle: BudgetTotals;
    hotPath: BudgetTotals;
    byGroup: Record<BudgetGroup, BudgetTotals>;
  };
}

export interface GrowthViolation {
  id: string;
  baselineChars: number;
  currentChars: number;
  growthPercent: number;
  reason: "grew" | "new-entry";
}

interface ToolResultLike {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: unknown;
}

interface FixtureExecOptions {
  timeout?: number;
  cwd?: string;
  signal?: AbortSignal;
}

type FixtureExec = (
  command: string,
  args: string[],
  options?: FixtureExecOptions,
) => Promise<{ code: number; stdout: string; stderr: string }>;

interface FixtureContext {
  exec: FixtureExec;
  cwd: string;
  state: Record<string, unknown>;
  saveState: (state: Record<string, unknown>) => boolean;
  clearState: () => void;
}

type ToolRunner = (
  context: FixtureContext,
  args: Record<string, unknown>,
) => Promise<ToolResultLike>;

interface AdaptedPromptLike {
  provider: "claude" | "codex" | "gemini";
  prompt: string;
  trailingNewlines: 1 | 2;
}

interface RuntimeModules {
  runPlan: ToolRunner;
  runReview: ToolRunner;
  runApprove: ToolRunner;
  adaptPromptForClaude: (bead: Record<string, unknown>) => AdaptedPromptLike;
  adaptPromptForCodex: (bead: Record<string, unknown>) => AdaptedPromptLike;
  adaptPromptForGemini: (bead: Record<string, unknown>) => AdaptedPromptLike;
  buildFreshEyesPrompt: (options: Record<string, unknown>) => string;
  resetCassDetection: () => void;
}

interface CliOptions {
  check: boolean;
  write: boolean;
  worker: boolean;
  help: boolean;
  root: string;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const IS_COMPILED = import.meta.url.includes("/dist/scripts/");
const DEFAULT_REPO_ROOT = IS_COMPILED
  ? path.resolve(SCRIPT_DIR, "..", "..", "..")
  : path.resolve(SCRIPT_DIR, "..", "..");
const BASELINE_PATH = "docs/perf/prompt-budget.json";
const THRESHOLD_PERCENT = 10;
const FIXTURE_GOAL = "Improve cache behavior";
const FIXTURE_SLUG = "improve-cache-behavior";
const FIXTURE_DATE = "2026-10-15";

const SKILL_FILES = [
  "skills/start/SKILL.md",
  "skills/start/_planning.md",
  "skills/start/_beads.md",
  "skills/start/_implement.md",
  "skills/start/_review.md",
  "skills/start/_wrapup.md",
  "skills/start/_inflight_prompt.md",
  "skills/start/_deslop.md",
  "skills/start/_reality_check.md",
  "skills/flywheel-swarm/SKILL.md",
] as const;

const GROUPS: BudgetGroup[] = [
  "skill",
  "command",
  "mcp-text",
  "mcp-structured",
  "adapter",
  "gate",
];

export function measureText(
  id: string,
  group: BudgetGroup,
  source: string,
  value: string,
): BudgetEntry {
  const chars = value.length;
  return {
    id,
    group,
    source,
    chars,
    estimatedTokens: Math.ceil(chars / 4),
  };
}

export function compareEntries(
  baselineEntries: BudgetEntry[],
  currentEntries: BudgetEntry[],
  thresholdPercent = THRESHOLD_PERCENT,
): GrowthViolation[] {
  const baselineById = new Map(baselineEntries.map((entry) => [entry.id, entry]));
  const violations: GrowthViolation[] = [];

  for (const current of currentEntries) {
    const baseline = baselineById.get(current.id);
    if (!baseline) {
      if (current.chars > 0) {
        violations.push({
          id: current.id,
          baselineChars: 0,
          currentChars: current.chars,
          growthPercent: Number.POSITIVE_INFINITY,
          reason: "new-entry",
        });
      }
      continue;
    }
    if (baseline.chars === 0) {
      if (current.chars > 0) {
        violations.push({
          id: current.id,
          baselineChars: 0,
          currentChars: current.chars,
          growthPercent: Number.POSITIVE_INFINITY,
          reason: "grew",
        });
      }
      continue;
    }
    const growthPercent = ((current.chars - baseline.chars) / baseline.chars) * 100;
    if (growthPercent > thresholdPercent) {
      violations.push({
        id: current.id,
        baselineChars: baseline.chars,
        currentChars: current.chars,
        growthPercent,
        reason: "grew",
      });
    }
  }

  return violations.sort((left, right) => left.id.localeCompare(right.id));
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    check: false,
    write: false,
    worker: false,
    help: false,
    root: DEFAULT_REPO_ROOT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--write") options.write = true;
    else if (arg === "--worker") options.worker = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--root") {
      const root = argv[index + 1];
      if (!root) throw new Error("--root requires a directory");
      options.root = path.resolve(root);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.check && options.write) {
    throw new Error("--check and --write cannot be combined");
  }
  return options;
}

function readUtf8(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function gitHead(repoRoot: string): string {
  return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 5_000,
  }).trim();
}

function total(entries: BudgetEntry[]): BudgetTotals {
  const chars = entries.reduce((sum, entry) => sum + entry.chars, 0);
  return { chars, estimatedTokens: Math.ceil(chars / 4) };
}

function buildReport(
  gitCommit: string,
  sourceMode: PromptBudgetReport["sourceMode"],
  entries: BudgetEntry[],
): PromptBudgetReport {
  const sorted = [...entries].sort(
    (left, right) => left.group.localeCompare(right.group) || left.id.localeCompare(right.id),
  );
  const ids = new Set<string>();
  for (const entry of sorted) {
    if (ids.has(entry.id)) throw new Error(`duplicate budget entry id: ${entry.id}`);
    ids.add(entry.id);
  }
  const byGroup = Object.fromEntries(
    GROUPS.map((group) => [group, total(sorted.filter((entry) => entry.group === group))]),
  ) as Record<BudgetGroup, BudgetTotals>;
  const startCycle = sorted.filter(
    (entry) => entry.group === "skill" || entry.group === "command",
  );
  const hotPath = sorted.filter(
    (entry) => entry.group !== "skill" && entry.group !== "command",
  );
  return {
    version: 1,
    gitHead: gitCommit,
    sourceMode,
    tokenEstimate: "ceil(chars / 4)",
    thresholdPercent: 10,
    entries: sorted,
    totals: {
      all: total(sorted),
      startCycle: total(startCycle),
      hotPath: total(hotPath),
      byGroup,
    },
  };
}

async function loadRuntimeModules(): Promise<RuntimeModules> {
  const sourceBase = IS_COMPILED ? ".." : "../src";
  const [plan, review, approve, claude, codex, gemini, gates, memory] = await Promise.all([
    import(`${sourceBase}/tools/plan.js`),
    import(`${sourceBase}/tools/review.js`),
    import(`${sourceBase}/tools/approve.js`),
    import(`${sourceBase}/adapters/claude-prompt.js`),
    import(`${sourceBase}/adapters/codex-prompt.js`),
    import(`${sourceBase}/adapters/gemini-prompt.js`),
    import(`${sourceBase}/gates.js`),
    import(`${sourceBase}/memory.js`),
  ]);
  return {
    runPlan: plan.runPlan as ToolRunner,
    runReview: review.runReview as ToolRunner,
    runApprove: approve.runApprove as ToolRunner,
    adaptPromptForClaude: claude.adaptPromptForClaude as RuntimeModules["adaptPromptForClaude"],
    adaptPromptForCodex: codex.adaptPromptForCodex as RuntimeModules["adaptPromptForCodex"],
    adaptPromptForGemini: gemini.adaptPromptForGemini as RuntimeModules["adaptPromptForGemini"],
    buildFreshEyesPrompt: gates.buildFreshEyesPrompt as RuntimeModules["buildFreshEyesPrompt"],
    resetCassDetection: memory.resetCassDetection as () => void,
  };
}

function fixtureState(phase: string): Record<string, unknown> {
  return {
    phase,
    selectedGoal: FIXTURE_GOAL,
    constraints: ["No breaking changes"],
    retryCount: 0,
    maxRetries: 3,
    maxReviewPasses: 2,
    iterationRound: 0,
    currentGateIndex: 0,
    polishRound: 0,
    polishChanges: [],
    polishConverged: false,
    repoProfile: {
      name: "fixture-repo",
      languages: ["TypeScript"],
      frameworks: ["MCP"],
      structure: "mcp-server/src\nskills/start",
      entrypoints: ["mcp-server/src/server.ts"],
      recentCommits: [],
      hasTests: true,
      hasDocs: true,
      hasCI: true,
      todos: [],
      keyFiles: { server: "mcp-server/src/server.ts" },
    },
  };
}

const FIXTURE_BEADS = [
  {
    id: "fixture-a1",
    title: "Measure prompt surface",
    description: "Implement the meter.\n\nFiles:\n- mcp-server/scripts/prompt-budget.ts",
    status: "open",
    priority: 1,
    issue_type: "task",
  },
  {
    id: "fixture-a2",
    title: "Verify prompt baseline",
    description: "Verify the baseline.\n\nFiles:\n- docs/perf/prompt-budget.json",
    status: "open",
    priority: 2,
    issue_type: "task",
  },
] as const;

function fixtureExec(): FixtureExec {
  return async (command, args) => {
    if (command === "br" && args[0] === "list") {
      return { code: 0, stdout: JSON.stringify(FIXTURE_BEADS), stderr: "" };
    }
    if (command === "br" && args[0] === "ready") {
      return { code: 0, stdout: JSON.stringify(FIXTURE_BEADS), stderr: "" };
    }
    if (command === "br" && args[0] === "show") {
      const bead = FIXTURE_BEADS.find((candidate) => candidate.id === args[1]) ?? FIXTURE_BEADS[0];
      return { code: 0, stdout: JSON.stringify(bead), stderr: "" };
    }
    if (command === "br" && args[0] === "update") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "git" && args[0] === "status") {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

function fixtureContext(cwd: string, phase: string): FixtureContext {
  return {
    exec: fixtureExec(),
    cwd,
    state: fixtureState(phase),
    saveState: () => true,
    clearState: () => {},
  };
}

function normalizeFixturePath(value: string, fixtureCwd: string): string {
  return value.split(fixtureCwd).join("<fixture-cwd>");
}

function assertToolResult(label: string, result: ToolResultLike): string {
  if (result.isError) throw new Error(`${label} returned an error result`);
  const text = result.content[0]?.text;
  if (typeof text !== "string") throw new Error(`${label} did not return content[0].text`);
  return text;
}

function addToolResult(
  entries: BudgetEntry[],
  id: string,
  source: string,
  result: ToolResultLike,
  fixtureCwd: string,
): void {
  const text = normalizeFixturePath(assertToolResult(id, result), fixtureCwd);
  const structured = result.structuredContent === undefined
    ? ""
    : normalizeFixturePath(JSON.stringify(result.structuredContent), fixtureCwd);
  entries.push(measureText(`${id}.text`, "mcp-text", source, text));
  entries.push(measureText(`${id}.structured`, "mcp-structured", source, structured));
}

function collectStaticEntries(repoRoot: string): BudgetEntry[] {
  const entries: BudgetEntry[] = [];
  const skillContents: string[] = [];
  for (const relativePath of SKILL_FILES) {
    const content = readUtf8(path.join(repoRoot, relativePath));
    skillContents.push(content);
    entries.push(measureText(`skill:${relativePath}`, "skill", relativePath, content));
  }

  const commandNames = new Set(["start"]);
  const commandReference = /\/agent-flywheel:([a-z0-9-]+)/g;
  for (const content of skillContents) {
    for (const match of content.matchAll(commandReference)) commandNames.add(match[1]);
  }
  for (const name of [...commandNames].sort()) {
    const relativePath = `commands/${name}.md`;
    const absolutePath = path.join(repoRoot, relativePath);
    if (!existsSync(absolutePath)) continue;
    entries.push(measureText(`command:${relativePath}`, "command", relativePath, readUtf8(absolutePath)));
  }
  return entries;
}

async function collectHotPathEntries(modules: RuntimeModules): Promise<BudgetEntry[]> {
  const entries: BudgetEntry[] = [];
  const fixtureCwd = mkdtempSync(path.join(tmpdir(), "prompt-budget-fixture-"));
  const originalPath = process.env.PATH;
  const emptyPath = mkdtempSync(path.join(tmpdir(), "prompt-budget-empty-path-"));

  try {
    process.env.PATH = emptyPath;
    modules.resetCassDetection();
    const brainstormDir = path.join(fixtureCwd, "docs", "brainstorms");
    mkdirSync(brainstormDir, { recursive: true });
    writeFileSync(
      path.join(brainstormDir, `${FIXTURE_SLUG}-${FIXTURE_DATE}.md`),
      "# Fixture brainstorm\n\nSmallest: measure one deterministic prompt surface.\n",
      "utf8",
    );
    writeFileSync(
      path.join(brainstormDir, `${FIXTURE_SLUG}-${FIXTURE_DATE}-ambition.md`),
      "# Fixture ambition charter\n\nTarget rung: enforce a 10% prompt-growth budget.\nFloor: report every measured entry.\nOutside judge: the committed JSON baseline.\n",
      "utf8",
    );

    for (const mode of ["standard", "deep", "duel"] as const) {
      for (const ambition of ["scoped", "ambitious"] as const) {
        const result = await modules.runPlan(fixtureContext(fixtureCwd, "planning"), {
          cwd: fixtureCwd,
          mode,
          ambition,
        });
        const expectedKind = mode === "standard"
          ? "plan_prompt"
          : mode === "deep"
            ? "deep_plan_spawn"
            : "duel_plan_spawn";
        const kind = (result.structuredContent as { data?: { kind?: unknown } } | undefined)?.data?.kind;
        if (kind !== expectedKind) {
          throw new Error(`plan ${mode}/${ambition} returned kind ${String(kind)}`);
        }
        addToolResult(
          entries,
          `mcp.plan.${mode}.${ambition}`,
          "flywheel_plan",
          result,
          fixtureCwd,
        );
      }
    }

    const review = await modules.runReview(fixtureContext(fixtureCwd, "reviewing"), {
      cwd: fixtureCwd,
      beadId: FIXTURE_BEADS[0].id,
      action: "hit-me",
    });
    if ((review.structuredContent as { data?: { kind?: unknown } } | undefined)?.data?.kind !== "review_tasks") {
      throw new Error("review hit-me did not return review_tasks");
    }
    addToolResult(entries, "mcp.review.hit-me", "flywheel_review", review, fixtureCwd);

    const approveStart = await modules.runApprove(
      fixtureContext(fixtureCwd, "awaiting_bead_approval"),
      { cwd: fixtureCwd, action: "start" },
    );
    if (
      (approveStart.structuredContent as { data?: { kind?: unknown } } | undefined)?.data?.kind
      !== "beads_approved"
    ) {
      throw new Error("approve start did not return beads_approved");
    }
    addToolResult(
      entries,
      "mcp.approve.start",
      "flywheel_approve_beads",
      approveStart,
      fixtureCwd,
    );

    const approveAdvanced = await modules.runApprove(
      fixtureContext(fixtureCwd, "awaiting_bead_approval"),
      { cwd: fixtureCwd, action: "advanced", advancedAction: "blunder-hunt" },
    );
    const advancedText = assertToolResult("approve advanced blunder-hunt", approveAdvanced);
    if (!advancedText.includes("Blunder Hunt Pass 5")) {
      throw new Error("approve advanced blunder-hunt did not render all five passes");
    }
    addToolResult(
      entries,
      "mcp.approve.advanced-blunder-hunt",
      "flywheel_approve_beads",
      approveAdvanced,
      fixtureCwd,
    );

    const bead = {
      beadId: "fixture-bead",
      title: "Measure prompt budget",
      description: "Build a deterministic prompt-budget meter and ratchet.",
      acceptance: ["Print a table", "Fail after more than 10% growth"],
      complexity: "medium",
      relevantFiles: ["mcp-server/scripts/prompt-budget.ts"],
      priorArtBeads: ["fixture-prior"],
      agentName: "CalmRiver",
      coordinatorName: "WindyBasin",
      projectKey: "fixture-project",
    };
    for (const adapter of [
      modules.adaptPromptForClaude(bead),
      modules.adaptPromptForCodex(bead),
      modules.adaptPromptForGemini(bead),
    ]) {
      const dispatched = `${adapter.prompt}${"\n".repeat(adapter.trailingNewlines)}`;
      entries.push(
        measureText(
          `adapter.${adapter.provider}.implementer`,
          "adapter",
          `adapters/${adapter.provider}-prompt.ts`,
          dispatched,
        ),
      );
    }

    const freshEyes = modules.buildFreshEyesPrompt({
      round: 1,
      memoryContext: "",
      allArtifacts: ["src/fixture.ts", "src/fixture.test.ts"],
      callbackHint: "\n\nWrite the verdict to <fixture-verdict>.",
      regressionHint: "",
      shaRange: "abc123..def456",
      emitStructuredFindings: true,
    });
    entries.push(
      measureText("gate.fresh-eyes", "gate", "gates.ts#buildFreshEyesPrompt", freshEyes),
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    modules.resetCassDetection();
    rmSync(fixtureCwd, { recursive: true, force: true });
    rmSync(emptyPath, { recursive: true, force: true });
  }

  return entries;
}

export async function collectPromptBudget(
  repoRoot: string,
  gitCommit: string,
  sourceMode: PromptBudgetReport["sourceMode"],
): Promise<PromptBudgetReport> {
  const modules = await loadRuntimeModules();
  const entries = [
    ...collectStaticEntries(repoRoot),
    ...(await collectHotPathEntries(modules)),
  ];
  return buildReport(gitCommit, sourceMode, entries);
}

function measureCommittedHead(repoRoot: string): PromptBudgetReport {
  const cloneRoot = mkdtempSync(path.join(tmpdir(), "prompt-budget-head-"));
  try {
    execFileSync("git", ["clone", "--quiet", "--shared", repoRoot, cloneRoot], {
      timeout: 30_000,
      stdio: "pipe",
    });
    const sourceNodeModules = path.join(repoRoot, "mcp-server", "node_modules");
    const cloneNodeModules = path.join(cloneRoot, "mcp-server", "node_modules");
    if (!existsSync(sourceNodeModules)) {
      throw new Error(`node_modules not found at ${sourceNodeModules}; run npm install first`);
    }
    symlinkSync(sourceNodeModules, cloneNodeModules, "dir");
    const tsx = path.join(cloneNodeModules, ".bin", "tsx");
    const script = path.join(cloneRoot, "mcp-server", "scripts", "prompt-budget.ts");
    const output = execFileSync(tsx, [script, "--worker", "--root", cloneRoot], {
      cwd: path.join(cloneRoot, "mcp-server"),
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, PROMPT_BUDGET_WORKER: "1" },
    });
    const report = JSON.parse(output) as PromptBudgetReport;
    return { ...report, sourceMode: "committed-head" };
  } finally {
    if (path.basename(cloneRoot).startsWith("prompt-budget-head-")) {
      rmSync(cloneRoot, { recursive: true, force: true });
    }
  }
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function printTable(report: PromptBudgetReport): void {
  const idWidth = Math.max("Entry".length, ...report.entries.map((entry) => entry.id.length));
  const groupWidth = Math.max("Group".length, ...report.entries.map((entry) => entry.group.length));
  const lines = [
    `${"Group".padEnd(groupWidth)}  ${"Entry".padEnd(idWidth)}  ${"Chars".padStart(10)}  ${"Est. tokens".padStart(12)}`,
    `${"-".repeat(groupWidth)}  ${"-".repeat(idWidth)}  ${"-".repeat(10)}  ${"-".repeat(12)}`,
    ...report.entries.map(
      (entry) =>
        `${entry.group.padEnd(groupWidth)}  ${entry.id.padEnd(idWidth)}  ${formatNumber(entry.chars).padStart(10)}  ${formatNumber(entry.estimatedTokens).padStart(12)}`,
    ),
    "",
    `Start-cycle files: ${formatNumber(report.totals.startCycle.chars)} chars / ~${formatNumber(report.totals.startCycle.estimatedTokens)} estimated tokens`,
    `Hot responses:     ${formatNumber(report.totals.hotPath.chars)} chars / ~${formatNumber(report.totals.hotPath.estimatedTokens)} estimated tokens`,
    `All entries:       ${formatNumber(report.totals.all.chars)} chars / ~${formatNumber(report.totals.all.estimatedTokens)} estimated tokens`,
    `Measured commit:   ${report.gitHead}`,
    `Source mode:       ${report.sourceMode}`,
    "Token estimate:    ceil(chars / 4)",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function printViolations(violations: GrowthViolation[], thresholdPercent: number): void {
  process.stderr.write(`prompt-budget: ${violations.length} entr${violations.length === 1 ? "y" : "ies"} exceeded the ${thresholdPercent}% growth budget\n`);
  for (const violation of violations) {
    const growth = Number.isFinite(violation.growthPercent)
      ? `${violation.growthPercent.toFixed(1)}%`
      : "new entry";
    process.stderr.write(
      `  ${violation.id}: ${violation.baselineChars} -> ${violation.currentChars} chars (${growth})\n`,
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: npx tsx scripts/prompt-budget.ts [--check | --write]\n" +
        "  default  Measure committed HEAD, print the table, and create the baseline if missing.\n" +
        "  --write  Replace the baseline from committed HEAD.\n" +
        "  --check  Measure the working tree and fail when any entry grew more than 10%.\n",
    );
    return;
  }

  if (options.worker) {
    const report = await collectPromptBudget(
      options.root,
      gitHead(options.root),
      "working-tree",
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }

  const baselinePath = path.join(options.root, BASELINE_PATH);
  if (options.check) {
    if (!existsSync(baselinePath)) {
      throw new Error(`baseline not found at ${baselinePath}; run prompt-budget first`);
    }
    const baseline = JSON.parse(readUtf8(baselinePath)) as PromptBudgetReport;
    const current = await collectPromptBudget(
      options.root,
      gitHead(options.root),
      "working-tree",
    );
    printTable(current);
    const violations = compareEntries(
      baseline.entries,
      current.entries,
      baseline.thresholdPercent,
    );
    if (violations.length > 0) {
      printViolations(violations, baseline.thresholdPercent);
      process.exitCode = 1;
      return;
    }
    process.stdout.write("prompt-budget: check passed; no entry grew more than 10%\n");
    return;
  }

  const report = measureCommittedHead(options.root);
  printTable(report);
  if (!existsSync(baselinePath) || options.write) {
    mkdirSync(path.dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`prompt-budget: wrote ${BASELINE_PATH}\n`);
  } else {
    process.stdout.write(`prompt-budget: baseline already exists at ${BASELINE_PATH}; use --write to replace it\n`);
  }
}

const entryPath = process.argv[1] ? realpathSync(path.resolve(process.argv[1])) : "";
const modulePath = realpathSync(fileURLToPath(import.meta.url));
if (entryPath === modulePath) {
  void main().catch((error: unknown) => {
    process.stderr.write(`prompt-budget: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
