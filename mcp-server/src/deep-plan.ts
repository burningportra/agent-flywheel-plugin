import type { ExecFn } from "./exec.js";
import { join } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";

export interface DeepPlanAgent {
  name: string;
  task: string;
  model?: string;
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
    resolvedOutputDir = tmpdir();
    process.stderr.write(`[deep-plan] WARNING: Could not create output dir ${outputDir}, falling back to ${resolvedOutputDir}\n`);
  }

  const promises = agents.map(async (agent) => {
    const startTime = Date.now();
    const taskFile = join(resolvedOutputDir, `${agent.name}-task.md`);
    const outputFile = join(resolvedOutputDir, `${agent.name}-output.md`);

    try {
      writeFileSync(taskFile, agent.task, "utf8");

      const args = [
        "--print",            // non-interactive, output to stdout
        "--tools", "read,bash,grep,find,ls",  // read-only tools
      ];

      if (agent.model) {
        args.push("--model", agent.model);
      }

      args.push(`@${taskFile}`);

      const result = await exec("claude", args, {
        timeout: 180000, // 3 min timeout per planner
        cwd,
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

      writeFileSync(outputFile, plan, "utf8");

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

  // Run all in parallel
  return Promise.all(promises);
}

/**
 * Filter deep-plan results to only those that are viable for synthesis.
 * Excludes failed agents and empty results (sentinel strings starting with "(AGENT").
 */
export function filterViableResults(results: DeepPlanResult[]): DeepPlanResult[] {
  return results.filter(r => r.exitCode === 0 && !r.plan.startsWith("(AGENT"));
}
