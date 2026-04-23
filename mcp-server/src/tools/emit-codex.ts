/**
 * flywheel_emit_codex — MCP tool handler (bead `agent-flywheel-plugin-zbx`).
 *
 * Sanitises `targetDir` via `utils/path-safety`, then delegates to
 * `emit/codex.ts`. Reports the AGENTS.md path and per-skill files written.
 *
 * Single-target by design: do NOT generalise into a registry. If a future
 * target is requested, that requires a separate design doc + bead.
 *
 * Note: this tool intentionally does NOT extend `FlywheelToolName` in
 * `types.ts` (forbidden by bead scope — types.ts is owned by another bead).
 * The MCP error envelope is therefore constructed directly rather than via
 * `makeToolError`, which narrows on `FlywheelToolName`.
 */

import { isAbsolute, resolve } from "node:path";

import type { McpToolResult, ToolContext } from "../types.js";
import { makeToolResult } from "./shared.js";
import { assertSafeRelativePath } from "../utils/path-safety.js";
import { emitCodex, type EmitCodexReport } from "../emit/codex.js";

const TOOL_NAME = "flywheel_emit_codex" as const;

export interface EmitCodexArgs {
  cwd: string;
  targetDir: string;
  /**
   * Optional: explicit plugin root (where `skills/` lives). Defaults to
   * `cwd` — useful when the MCP server is invoked from the plugin checkout.
   */
  pluginRoot?: string;
}

type EmitCodexStructured = {
  tool: typeof TOOL_NAME;
  version: 1;
  status: "ok";
  phase: "idle";
  data: {
    kind: "emit_codex_report";
    report: EmitCodexReport;
  };
};

type EmitCodexErrorStructured = {
  tool: typeof TOOL_NAME;
  version: 1;
  status: "error";
  phase: "idle";
  data: {
    kind: "error";
    error: {
      code: "invalid_input" | "internal_error";
      message: string;
      retryable: boolean;
      hint?: string;
      details?: Record<string, unknown>;
      timestamp: string;
    };
  };
};

function makeEmitCodexError(
  code: EmitCodexErrorStructured["data"]["error"]["code"],
  message: string,
  opts: { retryable?: boolean; hint?: string; details?: Record<string, unknown> } = {},
): McpToolResult<EmitCodexErrorStructured> {
  const structured: EmitCodexErrorStructured = {
    tool: TOOL_NAME,
    version: 1,
    status: "error",
    phase: "idle",
    data: {
      kind: "error",
      error: {
        code,
        message,
        retryable: opts.retryable ?? false,
        hint: opts.hint,
        details: opts.details,
        timestamp: new Date().toISOString(),
      },
    },
  };
  return {
    content: [{ type: "text", text: message }],
    structuredContent: structured,
    isError: true,
  };
}

export async function runEmitCodex(
  ctx: ToolContext,
  args: EmitCodexArgs,
): Promise<McpToolResult> {
  const cwd = ctx.cwd;
  const pluginRoot = args.pluginRoot ?? cwd;

  // Sanitise targetDir through the shared path-safety module (bead mq3).
  // Accept absolute paths only when they resolve inside cwd — Codex emission
  // must never escape the project root.
  const safe = assertSafeRelativePath(args.targetDir, {
    root: cwd,
    allowAbsoluteInsideRoot: true,
  });
  if (!safe.ok) {
    return makeEmitCodexError(
      "invalid_input",
      `targetDir rejected by path-safety: ${safe.message}`,
      {
        retryable: false,
        hint:
          "Pass a path inside the project root (relative or absolute). '..' segments and external absolute paths are rejected.",
        details: { reason: safe.reason },
      },
    );
  }

  const absoluteTarget = isAbsolute(args.targetDir)
    ? args.targetDir
    : resolve(cwd, safe.value);

  try {
    const report = await emitCodex({
      pluginRoot,
      targetDir: absoluteTarget,
    });
    const structured: EmitCodexStructured = {
      tool: TOOL_NAME,
      version: 1,
      status: "ok",
      phase: "idle",
      data: { kind: "emit_codex_report", report },
    };
    const text = renderEmitCodexText(report);
    return makeToolResult(text, structured);
  } catch (err: unknown) {
    return makeEmitCodexError(
      "internal_error",
      (err as Error)?.message ?? String(err),
      {
        retryable: true,
        hint:
          "Check that <pluginRoot>/skills exists and that <targetDir> is writable.",
      },
    );
  }
}

function renderEmitCodexText(r: EmitCodexReport): string {
  const lines: string[] = [];
  lines.push(`flywheel_emit_codex — wrote ${r.skillPaths.length} skill files`);
  lines.push(`  AGENTS.md: ${r.agentsPath}`);
  if (r.skipped.length > 0) {
    lines.push(`  skipped (${r.skipped.length}):`);
    for (const s of r.skipped) lines.push(`    - ${s.dir}: ${s.reason}`);
  }
  return lines.join("\n");
}
