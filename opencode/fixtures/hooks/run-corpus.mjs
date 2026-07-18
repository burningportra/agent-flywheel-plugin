#!/usr/bin/env node

/**
 * Shared Agent-Mail guard corpus runner (bead claude-19xh, T7).
 *
 * Feeds every command in guard-corpus.json through BOTH Agent-Mail guards and
 * asserts each produces the case's expected allow/block decision — and, by
 * construction, that the two guards agree with each other:
 *
 *   - Claude hook   `hooks/agent-mail-guard.js`     — a separate node process;
 *     the command is delivered via CLAUDE_TOOL_INPUT (its own input contract).
 *     Decision: exit 2 = block, exit 0 = allow.
 *   - Plugin port   `opencode/plugins/agent-flywheel.js` `tool.execute.before` —
 *     invoked in-process; the command is delivered via `output.args.command`
 *     with `input.tool = "bash"` (its own input contract). Decision: the handler
 *     throwing = block, returning = allow.
 *
 * Comparing decisions (not regex source) means a formatting change in either
 * guard cannot cause false drift, while a real divergence fails the runner.
 *
 * Exit 0 when every case matches on both guards; exit 1 on the first mismatch
 * batch with a per-case diff; exit 2 on a harness/setup error.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const SOURCE_GUARD = path.join(REPO_ROOT, "hooks", "agent-mail-guard.js");
const PLUGIN_TEMPLATE = path.join(REPO_ROOT, "opencode", "plugins", "agent-flywheel.js");
const CORPUS_PATH = path.join(HERE, "guard-corpus.json");

const BREAK_GLASS = "FLYWHEEL_ALLOW_AM_DOCTOR";

/** Build a child env with the break-glass var scrubbed unless the case sets it. */
function childEnvFor(caseEnv) {
  const env = { ...process.env };
  delete env[BREAK_GLASS];
  return { ...env, ...(caseEnv ?? {}) };
}

/** Run the Claude hook in its own process; map its exit code to a decision. */
function sourceGuardDecision(command, caseEnv) {
  const result = spawnSync(process.execPath, [SOURCE_GUARD], {
    input: "",
    timeout: 10_000,
    encoding: "utf8",
    env: { ...childEnvFor(caseEnv), CLAUDE_TOOL_INPUT: JSON.stringify({ command }) },
  });
  if (result.error) throw new Error(`source guard failed to run: ${result.error.message}`);
  if (result.signal) throw new Error(`source guard killed by signal ${result.signal}`);
  if (result.status === 2) return "block";
  if (result.status === 0) return "allow";
  throw new Error(`source guard exited with unexpected status ${String(result.status)}`);
}

/** Build the plugin's tool.execute.before handler once with a stubbed context. */
async function loadPluginBeforeHandler() {
  const noop = async () => {};
  const client = { app: { log: noop }, tui: { showToast: noop } };
  const mod = await import(pathToFileURL(PLUGIN_TEMPLATE).href);
  const factory = mod.AgentFlywheelPlugin;
  if (typeof factory !== "function") {
    throw new Error("plugin template does not export AgentFlywheelPlugin");
  }
  const api = await factory({
    project: "guard-corpus",
    client,
    $: noop,
    directory: REPO_ROOT,
    worktree: REPO_ROOT,
  });
  const handler = api?.["tool.execute.before"];
  if (typeof handler !== "function") {
    throw new Error("plugin api has no tool.execute.before handler");
  }
  return handler;
}

/** Drive the in-process plugin handler; throwing = block, returning = allow. */
async function pluginGuardDecision(handler, command, caseEnv) {
  // Apply the case env to the in-process handler exactly as the source guard
  // receives it (break-glass scrubbed unless the case sets it), then restore —
  // so both guards see identical inputs and a future env-driven case stays fair.
  const keys = new Set([BREAK_GLASS, ...Object.keys(caseEnv ?? {})]);
  const saved = new Map();
  for (const key of keys) {
    saved.set(
      key,
      Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined,
    );
  }
  delete process.env[BREAK_GLASS];
  for (const [key, value] of Object.entries(caseEnv ?? {})) process.env[key] = value;
  try {
    await handler({ tool: "bash" }, { args: { command } });
    return "allow";
  } catch {
    return "block";
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function main() {
  let corpus;
  try {
    corpus = JSON.parse(await readFile(CORPUS_PATH, "utf8"));
  } catch (error) {
    process.stderr.write(`[ERROR] cannot load guard corpus: ${String(error)}\n`);
    return 2;
  }
  assert.ok(Array.isArray(corpus.cases) && corpus.cases.length > 0, "corpus has cases");

  let handler;
  try {
    handler = await loadPluginBeforeHandler();
  } catch (error) {
    process.stderr.write(`[ERROR] cannot load plugin guard: ${String(error)}\n`);
    return 2;
  }

  const failures = [];
  for (const testCase of corpus.cases) {
    const { id, command, expect, env } = testCase;
    if (typeof command !== "string" || (expect !== "allow" && expect !== "block")) {
      failures.push(`${id ?? "?"}: malformed corpus entry`);
      continue;
    }
    let source;
    let plugin;
    try {
      source = sourceGuardDecision(command, env);
      plugin = await pluginGuardDecision(handler, command, env);
    } catch (error) {
      failures.push(`${id}: harness error — ${String(error)}`);
      continue;
    }
    if (source !== expect || plugin !== expect) {
      failures.push(
        `${id}: expected=${expect} source=${source} plugin=${plugin}` +
          (source !== plugin ? " (GUARDS DIVERGE)" : "") +
          ` :: ${JSON.stringify(command)}`,
      );
    }
  }

  if (failures.length > 0) {
    process.stderr.write("[FAIL] Agent-Mail guard corpus mismatches:\n");
    for (const line of failures) process.stderr.write(`  - ${line}\n`);
    return 1;
  }

  process.stdout.write(
    `[OK] guard corpus: ${corpus.cases.length} command(s); ` +
      "hooks/agent-mail-guard.js and the plugin port agree on every decision\n",
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}

export { main };
