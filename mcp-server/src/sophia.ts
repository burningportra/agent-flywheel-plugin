import type { ExecFn } from './exec.js';
import { createLogger } from './logger.js';

const log = createLogger("sophia");

/** Local type — sophia owns its own step interface for CR creation. */
interface PlanStep {
  index: number;
  description: string;
  acceptanceCriteria: string[];
  artifacts: string[];
  dependsOn?: number[];
}

// ─── Types ─────────────────────────────────────────────────────

export interface SophiaResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface SophiaCR {
  id: number;
  branch: string;
  title: string;
}

export interface SophiaTask {
  id: number;
  title: string;
}

export interface SophiaTaskStatus {
  id: number;
  title: string;
  status: string;
}

export interface SophiaCRStatus {
  id: number;
  branch: string;
  title: string;
  status: string;
  tasks: SophiaTaskStatus[];
}

// ─── Detection ─────────────────────────────────────────────────

let _sophiaAvailable: boolean | null = null;

export async function isSophiaAvailable(
  exec: ExecFn,
  cwd: string
): Promise<boolean> {
  if (_sophiaAvailable !== null) return _sophiaAvailable;
  try {
    const result = await exec("sophia", ["--help"], {
      timeout: 3000,
      cwd,
    });
    _sophiaAvailable = result.code === 0;
  } catch {
    _sophiaAvailable = false;
  }
  return _sophiaAvailable;
}

export async function isSophiaInitialized(
  exec: ExecFn,
  cwd: string
): Promise<boolean> {
  try {
    const result = await exec("sophia", ["cr", "list", "--json"], {
      timeout: 3000,
      cwd,
    });
    const parsed = JSON.parse(result.stdout);
    return parsed.ok === true;
  } catch {
    return false;
  }
}

// ─── Helpers ───────────────────────────────────────────────────

async function runSophia<T = unknown>(
  exec: ExecFn,
  cwd: string,
  args: string[]
): Promise<SophiaResult<T>> {
  try {
    const result = await exec("sophia", args, {
      timeout: 10000,
      cwd,
    });
    const parsed = JSON.parse(result.stdout);
    if (parsed.ok) {
      return { ok: true, data: parsed.data as T };
    }
    return {
      ok: false,
      error: parsed.error?.message ?? "Unknown sophia error",
    };
  } catch (err) {
    return {
      ok: false,
      error: `Sophia exec failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Init ──────────────────────────────────────────────────────

export async function initSophia(
  exec: ExecFn,
  cwd: string
): Promise<SophiaResult> {
  return runSophia(exec, cwd, ["init"]);
}

// ─── CR Status ─────────────────────────────────────────────────

export async function getCRStatus(
  exec: ExecFn,
  cwd: string,
  crId: number
): Promise<SophiaResult<SophiaCRStatus>> {
  const result = await runSophia<any>(exec, cwd, [
    "cr",
    "status",
    String(crId),
    "--json",
  ]);
  if (!result.ok || !result.data) {
    return { ok: false, error: result.error ?? "CR not found" };
  }
  const d = result.data;
  const cr = d.cr ?? d;
  const tasks: SophiaTaskStatus[] = (cr.tasks ?? d.tasks ?? []).map(
    (t: any) => ({
      id: t.id,
      title: t.title,
      status: t.status ?? "unknown",
    })
  );
  return {
    ok: true,
    data: {
      id: cr.id ?? crId,
      branch: cr.branch ?? "",
      title: cr.title ?? "",
      status: cr.status ?? "unknown",
      tasks,
    },
  };
}

// ─── CR Operations ─────────────────────────────────────────────

export async function createCR(
  exec: ExecFn,
  cwd: string,
  title: string,
  description: string
): Promise<SophiaResult<SophiaCR>> {
  const result = await runSophia<any>(exec, cwd, [
    "cr",
    "add",
    title,
    "--description",
    description,
    "--switch",
  ]);
  if (result.ok && result.data?.cr) {
    return {
      ok: true,
      data: {
        id: result.data.cr.id,
        branch: result.data.cr.branch,
        title: result.data.cr.title,
      },
    };
  }
  return { ok: false, error: result.error };
}

export async function setCRContract(
  exec: ExecFn,
  cwd: string,
  crId: number,
  opts: {
    why: string;
    scope: string[];
    nonGoals?: string[];
    invariants?: string[];
    testPlan?: string;
    rollbackPlan?: string;
    blastRadius?: string;
  }
): Promise<SophiaResult> {
  const args = ["cr", "contract", "set", String(crId), "--why", opts.why];
  for (const s of opts.scope) {
    args.push("--scope", s);
  }
  if (opts.nonGoals) {
    for (const ng of opts.nonGoals) args.push("--non-goal", ng);
  }
  if (opts.invariants) {
    for (const inv of opts.invariants) args.push("--invariant", inv);
  }
  if (opts.testPlan) args.push("--test-plan", opts.testPlan);
  if (opts.rollbackPlan) args.push("--rollback-plan", opts.rollbackPlan);
  if (opts.blastRadius) args.push("--blast-radius", opts.blastRadius);
  return runSophia(exec, cwd, args);
}

// ─── Task Operations ───────────────────────────────────────────

export async function addTask(
  exec: ExecFn,
  cwd: string,
  crId: number,
  title: string
): Promise<SophiaResult<SophiaTask>> {
  const result = await runSophia<any>(exec, cwd, [
    "cr",
    "task",
    "add",
    String(crId),
    title,
  ]);
  if (result.ok && result.data?.task) {
    return {
      ok: true,
      data: {
        id: result.data.task.id,
        title: result.data.task.title,
      },
    };
  }
  return { ok: false, error: result.error };
}

export async function setTaskContract(
  exec: ExecFn,
  cwd: string,
  crId: number,
  taskId: number,
  opts: {
    intent: string;
    acceptance: string[];
    scope: string[];
  }
): Promise<SophiaResult> {
  const args = [
    "cr",
    "task",
    "contract",
    "set",
    String(crId),
    String(taskId),
    "--intent",
    opts.intent,
  ];
  for (const a of opts.acceptance) args.push("--acceptance", a);
  for (const s of opts.scope) args.push("--scope", s);
  return runSophia(exec, cwd, args);
}

export async function checkpointTask(
  exec: ExecFn,
  cwd: string,
  crId: number,
  taskId: number,
  commitType: string = "feat"
): Promise<SophiaResult> {
  return runSophia(exec, cwd, [
    "cr",
    "task",
    "done",
    String(crId),
    String(taskId),
    "--commit-type",
    commitType,
    "--from-contract",
  ]);
}

// ─── Validate & Review ─────────────────────────────────────────

export async function validateCR(
  exec: ExecFn,
  cwd: string,
  crId: number
): Promise<SophiaResult> {
  return runSophia(exec, cwd, ["cr", "validate", String(crId)]);
}

export async function reviewCR(
  exec: ExecFn,
  cwd: string,
  crId: number
): Promise<SophiaResult> {
  return runSophia(exec, cwd, ["cr", "review", String(crId)]);
}

// ─── Batch: Create CR + Tasks from Plan ────────────────────────

export interface PlanToCRResult {
  cr: SophiaCR;
  taskIds: Map<number, number>; // stepIndex → sophia task ID
}

/**
 * Creates a Sophia CR from a plan, with tasks and contracts for each step.
 * Returns the CR info and a mapping of plan step indices to sophia task IDs.
 */
export async function createCRFromPlan(
  exec: ExecFn,
  cwd: string,
  goal: string,
  steps: PlanStep[],
  constraints: string[]
): Promise<SophiaResult<PlanToCRResult>> {
  // Create CR
  const crResult = await createCR(
    exec,
    cwd,
    goal.length > 72 ? goal.slice(0, 69) + "..." : goal,
    `Goal: ${goal}${constraints.length > 0 ? `\nConstraints: ${constraints.join(", ")}` : ""}`
  );
  if (!crResult.ok || !crResult.data) {
    return { ok: false, error: crResult.error };
  }
  const cr = crResult.data;

  // Set CR contract
  const allArtifacts = [
    ...new Set(steps.flatMap((s) => s.artifacts)),
  ];
  await setCRContract(exec, cwd, cr.id, {
    why: goal,
    scope: (() => {
      if (allArtifacts.length > 20) {
        log.warn("CR scope truncated", { total: allArtifacts.length, limit: 20 });
        return allArtifacts.slice(0, 20);
      }
      return allArtifacts;
    })(),
    invariants: constraints,
    testPlan: "All acceptance criteria met per step",
    rollbackPlan: "git revert CR merge commit",
  });

  // Create tasks with contracts
  const taskIds = new Map<number, number>();
  const warnings: string[] = [];
  for (const step of steps) {
    const taskResult = await addTask(
      exec,
      cwd,
      cr.id,
      `Step ${step.index}: ${step.description}`
    );
    if (taskResult.ok && taskResult.data) {
      taskIds.set(step.index, taskResult.data.id);

      const contractResult = await setTaskContract(exec, cwd, cr.id, taskResult.data.id, {
        intent: step.description,
        acceptance: step.acceptanceCriteria,
        scope: step.artifacts,
      });
      if (!contractResult.ok) {
        warnings.push(`Step ${step.index}: task created but contract failed: ${contractResult.error}`);
      }
    } else {
      warnings.push(`Step ${step.index}: task creation failed: ${taskResult.error}`);
    }
  }

  if (taskIds.size === 0) {
    return { ok: false, error: `CR created but all ${steps.length} tasks failed: ${warnings.join("; ")}` };
  }
  if (warnings.length > 0) {
    log.warn("CR partial", { crId: cr.id, warnings: warnings.join("; ") });
  }

  return { ok: true, data: { cr, taskIds } };
}

// ─── Worktree Merge ────────────────────────────────────────────

export interface MergeResult {
  ok: boolean;
  conflict: boolean;
  conflictFiles?: string[];
  error?: string;
}

/**
 * Merge changes from a worktree branch back to the target branch.
 * Uses --no-ff to keep a clear merge history.
 * If conflicts occur, aborts the merge and reports conflicting files.
 */
export async function mergeWorktreeChanges(
  exec: ExecFn,
  cwd: string,
  sourceBranch: string,
  targetBranch: string,
  stepDescription?: string
): Promise<MergeResult> {
  try {
    // Switch to target branch
    const checkout = await exec("git", ["checkout", targetBranch], {
      timeout: 10000,
      cwd,
    });
    if (checkout.code !== 0) {
      return { ok: false, conflict: false, error: `checkout failed: ${checkout.stderr.trim()}` };
    }

    // Attempt merge
    const msg = stepDescription
      ? `Merge worktree: ${stepDescription}`
      : `Merge ${sourceBranch} into ${targetBranch}`;
    const merge = await exec(
      "git",
      ["merge", "--no-ff", "-m", msg, sourceBranch],
      { timeout: 30000, cwd }
    );

    if (merge.code === 0) {
      return { ok: true, conflict: false };
    }

    // Check if it's a conflict
    const status = await exec("git", ["diff", "--name-only", "--diff-filter=U"], {
      timeout: 5000,
      cwd,
    });
    const conflictFiles = status.stdout.trim().split("\n").filter(Boolean);

    if (conflictFiles.length > 0) {
      // Abort the failed merge
      await exec("git", ["merge", "--abort"], { timeout: 5000, cwd });
      return { ok: false, conflict: true, conflictFiles };
    }

    return { ok: false, conflict: false, error: merge.stderr.trim() };
  } catch (err) {
    return {
      ok: false,
      conflict: false,
      error: `merge failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
