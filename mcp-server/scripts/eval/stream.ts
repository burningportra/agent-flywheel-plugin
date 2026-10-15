import { query } from "@anthropic-ai/claude-agent-sdk";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { Scenario, ScriptedAnswer, TextRecord, ToolUseRecord } from "./types.js";

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
};

const pickAnswer = (
  header: string,
  question: string,
  options: Array<Record<string, unknown>>,
  scripted: ScriptedAnswer[],
): string => {
  const haystack = `${header}\n${question}`.toLowerCase();
  const rule = scripted.find((s) => haystack.includes(s.headerContains.toLowerCase()));
  const target = (rule?.option ?? options[0]?.["label"] ?? "").toString();
  const match = options.find((o) =>
    String(o["label"] ?? "")
      .toLowerCase()
      .includes(target.toLowerCase()),
  );
  return match ? String(match["label"]) : target;
};

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
      for (const q of questions) {
        const header = String(q["header"] ?? "");
        const questionText = String(q["question"] ?? "");
        const options = (q["options"] as Array<Record<string, unknown>>) || [];
        answers[questionText] = pickAnswer(header, questionText, options, scenario.scripted);
      }
      jsonl.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          event: "canUseTool.injectAnswers",
          answers,
        })}\n`,
      );
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }
    return { behavior: "allow" };
  };

  const iterator = query({
    prompt: scenario.goal,
    options: {
      cwd,
      model,
      maxBudgetUsd,
      permissionMode: "default",
      canUseTool,
      abortController,
      settingSources: ["user", "project"],
      additionalDirectories: [cwd],
    },
  });

  try {
    for await (const msg of iterator) {
      jsonl.write(`${JSON.stringify({ ts: new Date().toISOString(), msg })}\n`);
      if (msg.type === "assistant" && msg.message?.content) {
        turnCounter += 1;
        for (const block of msg.message.content) {
          const b = block as unknown as Record<string, unknown>;
          if (b["type"] === "tool_use") {
            toolUses.push({
              ts: new Date().toISOString(),
              turn: turnCounter,
              tool_use_id: String(b["id"]),
              tool_name: String(b["name"]),
              input: (b["input"] as Record<string, unknown>) ?? {},
            });
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
    errorMsg = String(err);
  }
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
  };
}
