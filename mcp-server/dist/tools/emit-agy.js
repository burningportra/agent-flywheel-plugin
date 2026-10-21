/**
 * flywheel_emit_agy — check, write, or prune the Antigravity port of this
 * plugin by running `scripts/sync-agy.sh --json --target <targetDir>`.
 *
 * The port normally lives outside the project, under
 * `~/.gemini/antigravity/plugins/`, so `targetDir` may sit strictly inside
 * either `cwd` or the directory holding the manifest's port target. Both
 * checks compare realpaths, so a symlink can't carry the target elsewhere.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { makeFlywheelErrorResult } from '../errors.js';
import { makeOkToolResult } from './shared.js';
import { resolveRealpathWithinRoot } from '../utils/path-safety.js';
import { describeSyncAgySummary, findSyncAgyScript, resolveAgyPortTarget, runSyncAgy, } from '../adapters/antigravity.js';
const TOOL_NAME = 'flywheel_emit_agy';
const SYNC_AGY_TIMEOUT_MS = 120_000;
const MODES = ['check', 'write', 'prune'];
function invalid(message, hint, details) {
    return makeFlywheelErrorResult(TOOL_NAME, 'idle', { code: 'invalid_input', message, hint, ...(details ? { details } : {}) });
}
/** Realpath of `absPath`'s nearest existing ancestor, with the missing tail re-appended. */
function realpathOfNearest(absPath) {
    let existing = absPath;
    const tail = [];
    while (!existsSync(existing)) {
        const parent = dirname(existing);
        if (parent === existing)
            break;
        tail.unshift(existing.slice(parent.length).replace(/^[/\\]+/, ''));
        existing = parent;
    }
    return join(realpathSync(existing), ...tail);
}
function isStrictlyInside(child, parent) {
    return child !== parent && child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}
function resolvePluginRoot(input, cwd) {
    const abs = isAbsolute(input) ? input : resolve(cwd, input);
    const roots = [{ root: cwd, rootLabel: 'cwd' }];
    const envRoot = process.env.CLAUDE_PLUGIN_ROOT;
    if (envRoot)
        roots.push({ root: envRoot, rootLabel: 'CLAUDE_PLUGIN_ROOT' });
    let message = 'pluginRoot must be inside cwd or match CLAUDE_PLUGIN_ROOT.';
    for (const { root, rootLabel } of roots) {
        const attempt = resolveRealpathWithinRoot(abs, { root, label: 'pluginRoot', rootLabel });
        if (attempt.ok)
            return { ok: true, value: attempt.realPath };
        if (attempt.reason === 'not_found' || attempt.reason === 'resolve_failed')
            message = attempt.message;
    }
    return { ok: false, message };
}
export async function runEmitAgy(ctx, args) {
    const cwd = ctx.cwd;
    const mode = args.mode ?? 'check';
    if (!MODES.includes(mode)) {
        return invalid(`mode must be one of ${MODES.join(', ')}, got ${JSON.stringify(args.mode)}.`, 'Omit mode to check for drift, or pass write or prune.');
    }
    let sync;
    if (args.pluginRoot !== undefined) {
        const root = resolvePluginRoot(args.pluginRoot, cwd);
        if (!root.ok)
            return invalid(root.message, 'Omit pluginRoot, pass a path inside cwd, or set CLAUDE_PLUGIN_ROOT.');
        const script = join(root.value, 'scripts', 'sync-agy.sh');
        sync = existsSync(script) ? { pluginRoot: root.value, script } : null;
    }
    else {
        sync = findSyncAgyScript(cwd);
    }
    if (sync === null) {
        return makeFlywheelErrorResult(TOOL_NAME, 'idle', {
            code: 'missing_prerequisite',
            message: 'scripts/sync-agy.sh was not found in pluginRoot, cwd, or the running plugin.',
            hint: 'Run this from an agent-flywheel checkout, or pass pluginRoot pointing at one.',
        });
    }
    if (typeof args.targetDir !== 'string' || args.targetDir.trim().length === 0) {
        return invalid('targetDir is required.', 'Pass the Antigravity plugin directory, e.g. ~/.gemini/antigravity/plugins/agent-flywheel.');
    }
    const portParent = dirname(resolveAgyPortTarget(sync.pluginRoot));
    let target;
    let allowed;
    try {
        target = realpathOfNearest(isAbsolute(args.targetDir) ? args.targetDir : resolve(cwd, args.targetDir));
        allowed = [realpathOfNearest(cwd), realpathOfNearest(portParent)];
    }
    catch (err) {
        return invalid(`targetDir could not be resolved: ${err.message}`, 'Pass an absolute path or one relative to cwd.');
    }
    if (!allowed.some((root) => isStrictlyInside(target, root))) {
        return invalid(`targetDir ${target} is outside cwd and the Antigravity plugins directory (${portParent}).`, `Pass a directory inside ${portParent} or inside cwd.`, { target, allowedRoots: allowed });
    }
    let run;
    try {
        run = await runSyncAgy(ctx.exec, {
            script: sync.script,
            pluginRoot: sync.pluginRoot,
            mode,
            target,
            timeout: SYNC_AGY_TIMEOUT_MS,
            signal: ctx.signal,
        });
    }
    catch (err) {
        return makeFlywheelErrorResult(TOOL_NAME, 'idle', {
            code: 'cli_failure',
            message: `sync-agy.sh --${mode} failed: ${err.message}`,
            retryable: true,
        });
    }
    if (run.report === undefined || run.code > 1) {
        return makeFlywheelErrorResult(TOOL_NAME, 'idle', {
            code: 'cli_failure',
            message: `sync-agy.sh --${mode} exited ${run.code}: ${run.stderr}`,
            details: { exitCode: run.code, target },
        });
    }
    const clean = run.code === 0;
    const state = clean ? 'in sync' : mode === 'check' ? 'drift' : 'written with findings';
    return makeOkToolResult(TOOL_NAME, 'idle', `flywheel_emit_agy (${mode}) ${target}: ${state} — ${describeSyncAgySummary(run.report.summary)}`, {
        kind: 'emit_agy_report',
        mode,
        target,
        clean,
        exitCode: run.code,
        report: run.report,
    });
}
//# sourceMappingURL=emit-agy.js.map