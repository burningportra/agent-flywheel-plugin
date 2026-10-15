import { query } from "@anthropic-ai/claude-agent-sdk";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
const pickAnswer = (header, question, options, scripted) => {
    const haystack = `${header}\n${question}`.toLowerCase();
    const rule = scripted.find((s) => haystack.includes(s.headerContains.toLowerCase()));
    const target = (rule?.option ?? options[0]?.["label"] ?? "").toString();
    const match = options.find((o) => String(o["label"] ?? "")
        .toLowerCase()
        .includes(target.toLowerCase()));
    return match ? String(match["label"]) : target;
};
export async function runScenario(opts) {
    const { scenario, cwd, model, jsonlPath, maxBudgetUsd, timeoutMs } = opts;
    await mkdir(dirname(jsonlPath), { recursive: true });
    const jsonl = createWriteStream(jsonlPath, { encoding: "utf8" });
    const toolUses = [];
    const texts = [];
    let turnCounter = 0;
    let stopReason;
    let costUsd;
    let totalTurns = 0;
    let timedOut = false;
    let errorMsg;
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
    const canUseTool = async (toolName, input) => {
        if (toolName === "AskUserQuestion") {
            const questions = input["questions"] || [];
            const answers = {};
            for (const q of questions) {
                const header = String(q["header"] ?? "");
                const questionText = String(q["question"] ?? "");
                const options = q["options"] || [];
                answers[questionText] = pickAnswer(header, questionText, options, scenario.scripted);
            }
            jsonl.write(`${JSON.stringify({
                ts: new Date().toISOString(),
                event: "canUseTool.injectAnswers",
                answers,
            })}\n`);
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
                    const b = block;
                    if (b["type"] === "tool_use") {
                        toolUses.push({
                            ts: new Date().toISOString(),
                            turn: turnCounter,
                            tool_use_id: String(b["id"]),
                            tool_name: String(b["name"]),
                            input: b["input"] ?? {},
                        });
                    }
                    else if (b["type"] === "text") {
                        texts.push({
                            ts: new Date().toISOString(),
                            turn: turnCounter,
                            text: String(b["text"] ?? ""),
                        });
                    }
                }
                if (msg.message.usage) {
                    const u = msg.message.usage;
                    usage.input_tokens += u["input_tokens"] ?? 0;
                    usage.output_tokens += u["output_tokens"] ?? 0;
                    usage.cache_read_input_tokens += u["cache_read_input_tokens"] ?? 0;
                    usage.cache_creation_input_tokens += u["cache_creation_input_tokens"] ?? 0;
                }
                if (msg.message.stop_reason)
                    stopReason = msg.message.stop_reason;
            }
            else if (msg.type === "result") {
                const r = msg;
                stopReason = stopReason ?? r.subtype;
                costUsd = r.total_cost_usd ?? costUsd;
                totalTurns = r.num_turns ?? totalTurns;
            }
        }
    }
    catch (err) {
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
//# sourceMappingURL=stream.js.map