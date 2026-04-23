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
import { realpathSync } from "node:fs";
import { makeToolResult } from "./shared.js";
import { assertSafeRelativePath } from "../utils/path-safety.js";
import { emitCodex } from "../emit/codex.js";
const TOOL_NAME = "flywheel_emit_codex";
function makeEmitCodexError(code, message, opts = {}) {
    const structured = {
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
export async function runEmitCodex(ctx, args) {
    const cwd = ctx.cwd;
    // Validate pluginRoot: unrestricted fs reads from this arg would let a
    // caller exfiltrate any `<path>/skills/` tree on the host. Accept only
    // (a) cwd itself, (b) a path inside cwd, or (c) the CLAUDE_PLUGIN_ROOT
    // env value set by the plugin runtime. Compare realpaths to defeat
    // symlink escapes.
    const pluginRootResult = resolvePluginRoot(args.pluginRoot, cwd);
    if (!pluginRootResult.ok) {
        return makeEmitCodexError("invalid_input", pluginRootResult.message, {
            retryable: false,
            hint: "Omit pluginRoot (defaults to cwd), pass a path inside cwd, or set CLAUDE_PLUGIN_ROOT in the MCP server env to whitelist the plugin install path.",
            details: { reason: pluginRootResult.reason },
        });
    }
    const pluginRoot = pluginRootResult.value;
    // Sanitise targetDir through the shared path-safety module (bead mq3).
    // Accept absolute paths only when they resolve inside cwd — Codex emission
    // must never escape the project root.
    const safe = assertSafeRelativePath(args.targetDir, {
        root: cwd,
        allowAbsoluteInsideRoot: true,
    });
    if (!safe.ok) {
        return makeEmitCodexError("invalid_input", `targetDir rejected by path-safety: ${safe.message}`, {
            retryable: false,
            hint: "Pass a path inside the project root (relative or absolute). '..' segments and external absolute paths are rejected.",
            details: { reason: safe.reason },
        });
    }
    const absoluteTarget = isAbsolute(args.targetDir)
        ? args.targetDir
        : resolve(cwd, safe.value);
    try {
        const report = await emitCodex({
            pluginRoot,
            targetDir: absoluteTarget,
        });
        const structured = {
            tool: TOOL_NAME,
            version: 1,
            status: "ok",
            phase: "idle",
            data: { kind: "emit_codex_report", report },
        };
        const text = renderEmitCodexText(report);
        return makeToolResult(text, structured);
    }
    catch (err) {
        return makeEmitCodexError("internal_error", err?.message ?? String(err), {
            retryable: true,
            hint: "Check that <pluginRoot>/skills exists and that <targetDir> is writable.",
        });
    }
}
/**
 * Resolve + validate `pluginRoot`.
 *
 * Accepts:
 *   - `undefined` → defaults to `cwd`.
 *   - A path inside `cwd` (relative or absolute).
 *   - The value of `process.env.CLAUDE_PLUGIN_ROOT` — the plugin-install
 *     path set by Claude Code when the MCP server runs as a plugin.
 *
 * Rejects everything else. Uses `realpathSync` on inputs where the path
 * exists, so a symlink inside cwd that points outside is rejected.
 */
function resolvePluginRoot(input, cwd) {
    const rawRoot = input ?? cwd;
    let absRoot;
    try {
        absRoot = isAbsolute(rawRoot) ? rawRoot : resolve(cwd, rawRoot);
    }
    catch (err) {
        return {
            ok: false,
            reason: "resolve_failed",
            message: `pluginRoot resolve failed: ${err?.message ?? String(err)}`,
        };
    }
    let realRoot = absRoot;
    try {
        realRoot = realpathSync(absRoot);
    }
    catch {
        // Non-existent paths pass through — the downstream skills walk will
        // produce a clean "no skills/" error instead of a misleading path msg.
    }
    let realCwd = cwd;
    try {
        realCwd = realpathSync(cwd);
    }
    catch {
        // cwd should always exist; fall back to the raw value.
    }
    const envRoot = process.env.CLAUDE_PLUGIN_ROOT;
    const allowedRoots = [realCwd];
    if (envRoot && envRoot.length > 0) {
        try {
            allowedRoots.push(realpathSync(envRoot));
        }
        catch {
            allowedRoots.push(envRoot);
        }
    }
    for (const allowed of allowedRoots) {
        if (realRoot === allowed)
            return { ok: true, value: realRoot };
        if (realRoot.startsWith(allowed + "/"))
            return { ok: true, value: realRoot };
    }
    return {
        ok: false,
        reason: "outside_allowed_roots",
        message: "pluginRoot must be inside cwd or match CLAUDE_PLUGIN_ROOT — refusing to read skills from an arbitrary filesystem location.",
    };
}
function renderEmitCodexText(r) {
    const lines = [];
    lines.push(`flywheel_emit_codex — wrote ${r.skillPaths.length} skill files`);
    lines.push(`  AGENTS.md: ${r.agentsPath}`);
    if (r.skipped.length > 0) {
        lines.push(`  skipped (${r.skipped.length}):`);
        for (const s of r.skipped)
            lines.push(`    - ${s.dir}: ${s.reason}`);
    }
    return lines.join("\n");
}
//# sourceMappingURL=emit-codex.js.map