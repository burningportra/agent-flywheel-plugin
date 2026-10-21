#!/usr/bin/env node
/**
 * Direct stdio MCP caller for the agent-flywheel MCP server.
 *
 * Use when `flywheel_*` MCP tools are not directly mounted in the current
 * harness session. Connects to `<repo>/mcp-server/dist/server.js` over stdio,
 * calls the named tool, and prints JSON `{ text, data }` (or `--raw` / `--text`).
 *
 * Usage:
 *   node scripts/fw-call.mjs <tool_name> '<json_args>' [--text | --data]
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [, , toolName, rawArgs = "{}", flag = "--data"] = process.argv;
if (!toolName || toolName === "--help" || toolName === "-h") {
  console.error("Usage: node fw-call.mjs <flywheel_tool_name> '<json_args>' [--data | --text | --full]");
  process.exit(2);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.env.CLAUDE_PLUGIN_ROOT,
  path.resolve(scriptDir, "..", "..", ".."),
  "/Volumes/1tb/Projects/agent-flywheel-plugin",
  process.cwd(),
].filter(Boolean);

const pluginRoot = candidates.find((dir) =>
  existsSync(path.join(dir, "mcp-server", "dist", "server.js")),
);
if (!pluginRoot) {
  console.error("fw-call: could not locate mcp-server/dist/server.js. Set CLAUDE_PLUGIN_ROOT.");
  process.exit(2);
}

const sdkBase = path.join(
  pluginRoot,
  "mcp-server",
  "node_modules",
  "@modelcontextprotocol",
  "sdk",
  "dist",
  "esm",
  "client",
);
const { Client } = await import(pathToFileURL(path.join(sdkBase, "index.js")).href);
const { StdioClientTransport } = await import(pathToFileURL(path.join(sdkBase, "stdio.js")).href);

const parsedArgs = JSON.parse(rawArgs);
const args =
  parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs) && !("cwd" in parsedArgs)
    ? { cwd: process.cwd(), ...parsedArgs }
    : parsedArgs;
const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(pluginRoot, "mcp-server", "dist", "server.js")],
  env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
  stderr: "pipe",
});

const client = new Client({ name: "fw-call", version: "1.0.0" });
await client.connect(transport);
try {
  const result = await client.callTool({ name: toolName, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  const data = result.structuredContent?.data ?? result;
  if (flag === "--text") {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  } else if (flag === "--full") {
    process.stdout.write(`${JSON.stringify({ text, data }, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  }
} finally {
  await client.close();
}
