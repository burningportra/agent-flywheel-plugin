import type { ExecFn } from "./exec.js";
import { join } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { loadCachedProfile, profileRepo, saveCachedProfile } from "./profiler.js";

export interface DeepPlanAgent {
  name: string;
  task: string;
  model?: string;
}

/**
 * Compute or load the repo profile snapshot and persist it as JSON under outputDir.
 * Returns the absolute path to the snapshot, or null if profiling failed entirely.
 * Exported for testability.
 */
export async function writeProfileSnapshot(
  exec: ExecFn,
  cwd: string,
  outputDir: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    let profile = await loadCachedProfile(exec, cwd);
    if (!profile) {
      profile = await profileRepo(exec, cwd, signal);
      // Fire-and-forget cache save; don't let it block planners.
      saveCachedProfile(exec, cwd, profile).catch(() => { /* ignore */ });
    }
    const snapshotPath = join(outputDir, "profile-snapshot.json");
    writeFileSync(snapshotPath, JSON.stringify(profile, null, 2), "utf8");
    return snapshotPath;
  } catch (err) {
    process.stderr.write(
      `[deep-plan] WARNING: Could not compute profile snapshot: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
}

export interface DeepPlanResult {
  name: string;
  model: string;
  plan: string;
  exitCode: number;
  elapsed: number;
  error?: string;
}

/**
 * Run deep planning agents via the claude CLI in print mode.
 * Each agent gets its own task file and runs in parallel.
 */
export async function runDeepPlanAgents(
  exec: ExecFn,
  cwd: string,
  agents: DeepPlanAgent[],
  signal?: AbortSignal
): Promise<DeepPlanResult[]> {
  // Write each agent's task to a temp file and spawn claude in print mode
  const outputDir = join(tmpdir(), `claude-deep-plan-${Date.now()}`);
  let resolvedOutputDir = outputDir;
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    const fallbackDir = join(tmpdir(), `claude-deep-plan-fallback-${Date.now()}`);
    try {
      mkdirSync(fallbackDir, { recursive: true });
      resolvedOutputDir = fallbackDir;
    } catch {
      resolvedOutputDir = tmpdir(); // last resort
    }
    process.stderr.write(`[deep-plan] WARNING: Could not create output dir ${outputDir}, falling back to ${resolvedOutputDir}\n`);
  }

  // Compute/load shared profile snapshot once and hand path to each planner.
  const snapshotPath = await writeProfileSnapshot(exec, cwd, resolvedOutputDir, signal);
  const snapshotPreamble = snapshotPath
    ? `Shared repo profile available at: ${snapshotPath}. Read it once with the Read tool before scanning; do NOT rerun broad grep/ls unless the snapshot is missing fields you need.\n\n`
    : "";

  const promises = agents.map(async (agent) => {
    const startTime = Date.now();
    const taskFile = join(resolvedOutputDir, `${agent.name}-task.md`);
    const outputFile = join(resolvedOutputDir, `${agent.name}-output.md`);

    try {
      writeFileSync(taskFile, `${snapshotPreamble}${agent.task}`, "utf8");

      const args = [
        "--print",            // non-interactive, output to stdout
        "--tools", "read,bash,grep,find,ls",  // read-only tools
      ];

      if (agent.model) {
        args.push("--model", agent.model);
      }

      args.push(`@${taskFile}`);

      const result = await exec("claude", args, {
        timeout: Number(process.env.DEEP_PLAN_TIMEOUT_MS ?? 420000), // 7 min default; override via DEEP_PLAN_TIMEOUT_MS env var
        cwd,
        signal,
      });

      const plan = result.stdout.trim();
      if (!plan) {
        return {
          name: agent.name,
          model: agent.model ?? "default",
          plan: "(AGENT RETURNED EMPTY — exclude from synthesis)",
          exitCode: result.code,
          elapsed: Math.floor((Date.now() - startTime) / 1000),
        } as DeepPlanResult;
      }

      try {
        writeFileSync(outputFile, plan, "utf8");
      } catch (writeErr) {
        process.stderr.write(`[deep-plan] WARNING: Could not write output file ${outputFile}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}\n`);
      }

      return {
        name: agent.name,
        model: agent.model ?? "default",
        plan,
        exitCode: result.code,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
      } as DeepPlanResult;
    } catch (err) {
      return {
        name: agent.name,
        model: agent.model ?? "default",
        plan: `(AGENT FAILED — exclude from synthesis: ${err instanceof Error ? err.message : String(err)})`,
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: err instanceof Error ? err.message : String(err),
      } as DeepPlanResult;
    }
  });

  // Run all in parallel, then filter to only viable results for synthesis
  const allResults = await Promise.all(promises);
  const viable = filterViableResults(allResults);
  if (viable.length === 0) {
    process.stderr.write(
      `[deep-plan] WARNING: All ${allResults.length} planners failed or timed out. Synthesis will be empty.\n`
    );
  } else if (viable.length < allResults.length) {
    process.stderr.write(
      `[deep-plan] WARNING: Only ${viable.length}/${allResults.length} planners succeeded.\n`
    );
  }
  return viable;
}

/**
 * Filter deep-plan results to only those that are viable for synthesis.
 * Excludes failed agents and empty results (sentinel strings starting with "(AGENT").
 */
export function filterViableResults(results: DeepPlanResult[]): DeepPlanResult[] {
  return results.filter(r => r.exitCode === 0 && !r.plan.startsWith("(AGENT"));
}
