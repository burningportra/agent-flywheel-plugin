#!/usr/bin/env node

/**
 * Plugin-level validation for the AGY mirror (bead agent-flywheel-plugin-dm1).
 *
 * Checks what the host validator cannot know (our own invariants), then defers
 * to `agy plugin validate <target> --strict --json` as the oracle when the CLI
 * is on PATH. A missing CLI is reported, never silent.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const AGY_PLUGIN_FIELDS = Object.freeze([
  "name",
  "displayName",
  "version",
  "description",
  "logo",
  "suggestedPrompts",
  "disabled",
]);

export const AGY_VALIDATE_TIMEOUT_MS = 30_000;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate a rendered plugin set (map of relPath -> {content}) or a directory
 * on disk. Returns { findings: [{severity,file,message}], agy: {...}|null }.
 * findings with severity "error" or "warning" both fail the caller's gate —
 * `agy plugin validate --strict` treats warnings as failures too.
 */
export function validatePlugin({ files = new Map(), manifest }) {
  const findings = [];
  const add = (severity, file, message) => findings.push({ severity, file, message });
  const read = (relPath) => {
    const entry = files.get(relPath);
    if (!entry) return undefined;
    return typeof entry === "string" ? entry : entry.content;
  };

  // 1. plugin.json exists and carries EXACTLY the 7-field AGY schema.
  const pluginJsonRaw = read("plugin.json");
  let pluginJson;
  if (pluginJsonRaw === undefined) {
    add("error", "plugin.json", "plugin.json is missing from the rendered plugin");
  } else {
    try {
      pluginJson = JSON.parse(pluginJsonRaw);
    } catch (err) {
      add("error", "plugin.json", `plugin.json is not valid JSON: ${err.message}`);
    }
  }
  if (isPlainObject(pluginJson)) {
    const unknown = Object.keys(pluginJson).filter(
      (key) => !AGY_PLUGIN_FIELDS.includes(key),
    );
    for (const key of unknown) {
      add(
        "error",
        "plugin.json",
        `unknown field "${key}" — agy plugin validate --strict rejects it (allowed: ${AGY_PLUGIN_FIELDS.join(", ")})`,
      );
    }
    if (typeof pluginJson.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(pluginJson.name)) {
      add("error", "plugin.json", '"name" must be lowercase kebab-case');
    }
    if (typeof pluginJson.version !== "string" || !/^\d+\.\d+\.\d+/.test(pluginJson.version)) {
      add("error", "plugin.json", '"version" must be a semantic version string');
    }
    if (typeof pluginJson.description !== "string" || pluginJson.description.length < 10) {
      add("error", "plugin.json", '"description" must be a non-trivial string');
    }
    if (typeof pluginJson.disabled !== "boolean") {
      add("error", "plugin.json", '"disabled" must be a boolean');
    }
    const prompts = pluginJson.suggestedPrompts;
    if (
      !Array.isArray(prompts) ||
      prompts.length === 0 ||
      prompts.some((p) => typeof p !== "string" || p.trim() === "") ||
      prompts.length > 3
    ) {
      add("error", "plugin.json", '"suggestedPrompts" must be 1-3 non-empty strings');
    }
    if (typeof pluginJson.logo !== "string" || pluginJson.logo.startsWith("/")) {
      add("error", "plugin.json", '"logo" must be a plugin-relative path');
    } else if (read(pluginJson.logo) === undefined) {
      add("error", pluginJson.logo, `logo file "${pluginJson.logo}" is missing from the rendered plugin`);
    }
  }

  // 2. MCP config is mcp_config.json (AGY rejects .mcp.json).
  if (read(".mcp.json") !== undefined) {
    add("warning", ".mcp.json", "never loaded: AGY requires mcp_config.json (Claude Code file name)");
  }
  const mcpRaw = read("mcp_config.json");
  if (mcpRaw !== undefined) {
    try {
      const mcp = JSON.parse(mcpRaw);
      const servers = Object.keys(mcp?.mcpServers ?? {});
      if (servers.length === 0) {
        add("warning", "mcp_config.json", "declares no mcpServers");
      }
      for (const server of servers) {
        if (!server.startsWith("agent-flywheel")) {
          add("warning", "mcp_config.json", `server "${server}" is not agent-flywheel-prefixed`);
        }
      }
    } catch (err) {
      add("error", "mcp_config.json", `not valid JSON: ${err.message}`);
    }
  }

  // 3. Rules stay under the byte budget (AGY silently truncates past it).
  const maxBytes = manifest?.rulesMaxBytes ?? manifest?.rules?.maxBytes ?? 24_000;
  for (const [relPath, entry] of files) {
    if (!/^rules\/.*\.md$/.test(relPath)) continue;
    const content = typeof entry === "string" ? entry : entry.content;
    const size = Buffer.byteLength(content, "utf8");
    if (size > maxBytes) {
      add(
        "error",
        relPath,
        `rule file is ${size} bytes; AGY silently truncates above ${maxBytes}`,
      );
    }
    if (/^---\s*\n/.test(content)) {
      add("warning", relPath, "AGY rules are plain markdown; frontmatter is not supported");
    }
  }

  // 4. hooks.json parses, every handler has a command, and wrapper scripts exist.
  const hooksRaw = read("hooks.json");
  if (hooksRaw !== undefined) {
    try {
      const hooks = JSON.parse(hooksRaw);
      for (const [name, spec] of Object.entries(hooks)) {
        for (const [event, entries] of Object.entries(spec ?? {})) {
          if (!Array.isArray(entries)) continue;
          for (const entry of entries) {
            const handlers = Array.isArray(entry?.hooks) ? entry.hooks : [entry];
            for (const handler of handlers) {
              if (handler?.command === undefined) {
                add("error", "hooks.json", `hook "${name}" (${event}) has a handler without a command`);
                continue;
              }
              const wrapper = String(handler.command).replace(/^\.\//, "");
              if (wrapper.startsWith("hooks/") && read(wrapper) === undefined) {
                add("error", "hooks.json", `hook "${name}" (${event}) points at missing wrapper "${wrapper}"`);
              }
            }
          }
        }
      }
    } catch (err) {
      add("error", "hooks.json", `not valid JSON: ${err.message}`);
    }
  }

  return { findings, pluginJson };
}

/**
 * Run the host oracle. Returns { ran, findings, raw } — ran:false (with a
 * note in raw) when agy is not on PATH or the target is not on disk.
 */
export function runAgyValidate(targetDir, { timeoutMs = AGY_VALIDATE_TIMEOUT_MS } = {}) {
  const probe = spawnSync("agy", ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (probe.error || probe.status !== 0) {
    return { ran: false, findings: [], raw: "agy validate: skipped (agy not on PATH)" };
  }
  const version = probe.stdout.trim();
  const run = spawnSync(
    "agy",
    ["plugin", "validate", targetDir, "--strict", "--json"],
    { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
  );
  const stdout = run.stdout ?? "";
  let parsed = null;
  try {
    const start = stdout.indexOf("{");
    parsed = start >= 0 ? JSON.parse(stdout.slice(start)) : null;
  } catch {
    parsed = null;
  }
  const findings = (parsed?.findings ?? []).map((f) => ({
    severity: f.severity ?? "error",
    file: f.file ?? "plugin",
    message: f.message ?? String(f),
  }));
  return {
    ran: true,
    version,
    ok: run.status === 0 && findings.length === 0,
    findings,
    raw: stdout.trim(),
  };
}

/** SHA-256 of UTF-8 content, hex. */
export function sha256Text(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
