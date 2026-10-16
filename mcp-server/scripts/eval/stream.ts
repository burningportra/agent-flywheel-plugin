import { query } from "@anthropic-ai/claude-agent-sdk";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { pickAnswer } from "./pick.js";
import type { Scenario, TextRecord, ToolUseRecord } from "./types.js";

export type RunOutcome = {
  toolUses: ToolUseRecord[];
  texts: TextRecord[];
  stop_reason?: string;
  turns: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  cost_usd?: number;
  error?: string;
  timed_out: boolean;
  plugin_check: PluginCheck;
  /**
   * True when the first Skill(agent-flywheel:*) tool_result contains
   * "already loaded above". That dedup message means the skill body never
   * arrived and the model is on the recovery path — the scenario cannot be a
   * valid baseline. See agent-flywheel-plugin-m66.1.5.
   */
  skill_stub_detected: boolean;
  /**
   * Scripted-answer events: unmatched targets (ruleTarget matched no offered
   * label) and default-fallback picks (no rule by header; options[0] used).
   * The caller surfaces unmatched entries as scenario violations so a harness
   * miss cannot pass as a skill result.
   */
  pick_events: Array<
    | {
        kind: "unmatched";
        turn: number;
        ruleTarget: string;
        header: string;
        labels: string[];
      }
    | {
        kind: "default";
        turn: number;
        header: string;
        label: string;
        labels: string[];
      }
  >;
};

export type PluginCheck =
  | { kind: "ok"; worktree: string; pluginPath: string }
  | {
      kind: "fail";
      worktree: string;
      expected: string;
      actual: string | null;
      plugins: Array<{ name: string; path?: string }>;
    }
  | { kind: "no-init" };

/**
 * Guard against the pointer-command dedup defect filed as
 * `agent-flywheel-plugin-m66.1.5`. When `commands/start.md` and
 * `skills/start/SKILL.md` both register as `agent-flywheel:start`, the harness
 * answers the Skill() call with "Skill /agent-flywheel:start is already loaded
 * above; instructions unchanged" and the SKILL.md body never arrives. The eval
 * must not treat the resulting recovery-path run as a valid baseline.
 */
export const SKILL_STUB_MARKER = "already loaded above";

// pickAnswer moved to ./pick.ts (header-first matching + unmatched failure).

export async function runScenario(opts: {
  scenario: Scenario;
  cwd: string;
  model: string;
  jsonlPath: string;
  maxBudgetUsd: number;
  timeoutMs: number;
}): Promise<RunOutcome> {
  const { scenario, cwd, model, jsonlPath, maxBudgetUsd, timeoutMs } = opts;

  await mkdir(dirname(jsonlPath), { recursive: true });
  const jsonl = createWriteStream(jsonlPath, { encoding: "utf8" });

  const toolUses: ToolUseRecord[] = [];
  const texts: TextRecord[] = [];
  let turnCounter = 0;
  let stopReason: string | undefined;
  let costUsd: number | undefined;
  let totalTurns = 0;
  let timedOut = false;
  let errorMsg: string | undefined;
  let pluginCheck: PluginCheck = { kind: "no-init" };
  let skillStubDetected = false;
  let sawSkillToolUse = false;
  const pickEvents: RunOutcome["pick_events"] = [];
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  const abortController = new AbortController();
  const deadline = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<
    | { behavior: "allow"; updatedInput?: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  > => {
    if (toolName === "AskUserQuestion") {
      const questions = (input["questions"] as Array<Record<string, unknown>>) || [];
      const answers: Record<string, string> = {};
      const picks: Array<{ header: string; outcome: ReturnType<typeof pickAnswer> }> = [];
      for (const q of questions) {
        const header = String(q["header"] ?? "");
        const questionText = String(q["question"] ?? "");
        const options = (q["options"] as Array<Record<string, unknown>>) || [];
        const outcome = pickAnswer(header, options, scenario.scripted);
        picks.push({ header, outcome });

        if (outcome.kind === "matched" || outcome.kind === "default") {
          answers[questionText] = outcome.label;
        } else {
          // Unmatched scripted target — do NOT inject free text that would
          // read as user consent. Pick options[0] as a terminal-safe default,
          // record the violation, and let the scenario's assert() surface it.
          const fallback = options[0] ? String(options[0]["label"] ?? "") : "";
          answers[questionText] = fallback;
          pickEvents.push({
            kind: "unmatched",
            turn: turnCounter + 1,
            ruleTarget: outcome.ruleTarget,
            header: outcome.header,
            labels: outcome.labels,
          });
        }
        if (outcome.kind === "default") {
          pickEvents.push({
            kind: "default",
            turn: turnCounter + 1,
            header: outcome.header,
            label: outcome.label,
            labels: outcome.labels,
          });
        }
      }
      jsonl.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          event: "canUseTool.injectAnswers",
          answers,
          picks,
        })}\n`,
      );
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }
    return { behavior: "allow" };
  };

  // Load the plugin from the worktree only. `settingSources: []` means no
  // user/project settings are read, which prevents the installed
  // ~/.claude/plugins/cache/agent-flywheel copy from leaking into the
  // session. The worktree's own `.claude-plugin/plugin.json` is picked up
  // via the explicit `plugins` entry below.
  // Prepend the per-worktree shim directory to PATH for the duration of the
  // SDK session. Scenarios' prepareFixtures hooks write stub executables
  // (e.g. an `ntm` shim that logs argv and exits 0 so the model's robot-send
  // doesn't actually spawn panes) into `<cwd>/.pi-flywheel/eval-bin`; the
  // SDK's spawned child inherits PATH from this process.
  const shimDir = `${cwd}/.pi-flywheel/eval-bin`;
  const prevPath = process.env.PATH;
  process.env.PATH = prevPath ? `${shimDir}:${prevPath}` : shimDir;
  // Point CLAUDE_PLUGIN_ROOT at the worktree so skills that reference
  // `$CLAUDE_PLUGIN_ROOT/mcp-server/...` (e.g. `_implement.md:76` for the
  // tender-daemon) don't pick up the installed `~/.claude/plugins/cache/...`
  // copy. Without this override an installed daemon can escape the
  // worktree and keep running past the SDK's exit — see teardown below.
  const prevPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_PLUGIN_ROOT = cwd;

  const iterator = query({
    prompt: scenario.goal,
    options: {
      cwd,
      model,
      maxBudgetUsd,
      permissionMode: "default",
      canUseTool,
      abortController,
      settingSources: [],
      additionalDirectories: [cwd],
      plugins: [{ type: "local", path: cwd }],
    },
  });

  try {
    for await (const msg of iterator) {
      jsonl.write(`${JSON.stringify({ ts: new Date().toISOString(), msg })}\n`);
      if (msg.type === "system" && msg.subtype === "init") {
        const sys = msg as unknown as {
          plugins?: Array<{ name: string; path?: string }>;
        };
        const plugins = sys.plugins ?? [];
        const flywheel = plugins.find((p) => p.name === "agent-flywheel");
        if (!flywheel) {
          pluginCheck = {
            kind: "fail",
            worktree: cwd,
            expected: cwd,
            actual: null,
            plugins,
          };
          errorMsg = `agent-flywheel plugin not loaded in session init; aborting`;
          abortController.abort();
          continue;
        }
        if (flywheel.path !== cwd) {
          pluginCheck = {
            kind: "fail",
            worktree: cwd,
            expected: cwd,
            actual: flywheel.path ?? null,
            plugins,
          };
          errorMsg =
            `agent-flywheel plugin loaded from ${flywheel.path} instead of worktree ${cwd}; aborting`;
          abortController.abort();
          continue;
        }
        pluginCheck = { kind: "ok", worktree: cwd, pluginPath: flywheel.path };
      } else if (msg.type === "assistant" && msg.message?.content) {
        turnCounter += 1;
        for (const block of msg.message.content) {
          const b = block as unknown as Record<string, unknown>;
          if (b["type"] === "tool_use") {
            const toolName = String(b["name"]);
            const input = (b["input"] as Record<string, unknown>) ?? {};
            toolUses.push({
              ts: new Date().toISOString(),
              turn: turnCounter,
              tool_use_id: String(b["id"]),
              tool_name: toolName,
              input,
            });
            if (
              toolName === "Skill" &&
              typeof input["skill"] === "string" &&
              input["skill"].startsWith("agent-flywheel:")
            ) {
              sawSkillToolUse = true;
            }
          } else if (b["type"] === "text") {
            texts.push({
              ts: new Date().toISOString(),
              turn: turnCounter,
              text: String(b["text"] ?? ""),
            });
          }
        }
        if (msg.message.usage) {
          const u = msg.message.usage as unknown as Record<string, number>;
          usage.input_tokens += u["input_tokens"] ?? 0;
          usage.output_tokens += u["output_tokens"] ?? 0;
          usage.cache_read_input_tokens += u["cache_read_input_tokens"] ?? 0;
          usage.cache_creation_input_tokens += u["cache_creation_input_tokens"] ?? 0;
        }
        if (msg.message.stop_reason) stopReason = msg.message.stop_reason;
      } else if (
        msg.type === "user" &&
        msg.message?.content &&
        sawSkillToolUse &&
        !skillStubDetected
      ) {
        // Inspect the Skill() tool_result for the pointer-command dedup
        // marker. We only care about the FIRST Skill result; sawSkillToolUse
        // flips back to false after a check so later Skill calls (e.g. for a
        // different skill) don't re-trigger.
        for (const block of msg.message.content) {
          const b = block as unknown as Record<string, unknown>;
          if (b["type"] === "tool_result") {
            const content = b["content"];
            const stringified = Array.isArray(content)
              ? content.map((c) => JSON.stringify(c)).join("\n")
              : JSON.stringify(content);
            if (stringified.includes(SKILL_STUB_MARKER)) {
              skillStubDetected = true;
            }
            sawSkillToolUse = false;
          }
        }
      } else if (msg.type === "result") {
        const r = msg as unknown as {
          subtype?: string;
          total_cost_usd?: number;
          num_turns?: number;
        };
        stopReason = stopReason ?? r.subtype;
        costUsd = r.total_cost_usd ?? costUsd;
        totalTurns = r.num_turns ?? totalTurns;
      }
    }
  } catch (err) {
    if (!errorMsg) errorMsg = String(err);
  }
  // Restore PATH + CLAUDE_PLUGIN_ROOT no matter how the loop exited.
  if (prevPath === undefined) delete process.env.PATH;
  else process.env.PATH = prevPath;
  if (prevPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = prevPluginRoot;
  clearTimeout(deadline);
  jsonl.end();

  totalTurns = Math.max(totalTurns, turnCounter);
  return {
    toolUses,
    texts,
    stop_reason: stopReason,
    turns: totalTurns,
    usage,
    cost_usd: costUsd,
    error: errorMsg,
    timed_out: timedOut,
    plugin_check: pluginCheck,
    skill_stub_detected: skillStubDetected,
    pick_events: pickEvents,
  };
}
