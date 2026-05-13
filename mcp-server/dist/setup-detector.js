/**
 * T3.1 (v3.16.0 noob-onboarding) — parallel pre-flight detector for
 * `/flywheel-setup`. Replaces the prior per-tool sequential probe with
 * a single `Promise.all` sweep that returns a structured `InstallPlan`
 * partitioned into five buckets the skill body can present in a single
 * AskUserQuestion prompt.
 *
 * Pure, read-only, no mutations. Default check implementations rely on
 * shell-level binaries (`command -v <name>`), a HEAD request against
 * agent-mail's `/health/liveness`, parsing `ntm config show`, and a
 * filesystem read of `~/.claude.json`. Every probe is injectable for
 * tests via the `Probes` parameter — tests bypass the OS by passing
 * deterministic implementations.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { rename, symlink, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
/**
 * Names of the ACFS-stack CLIs the flywheel detects. Order is preserved
 * in the resulting `install` / `skip` buckets so the skill can render a
 * stable list to the user.
 */
export const REQUIRED_CLIS = ['br', 'bv', 'cm', 'dcg', 'ntm'];
const DEFAULT_PROBES = {
    hasCli: defaultHasCli,
    isAgentMailAlive: defaultIsAgentMailAlive,
    isMcpRegistered: defaultIsMcpRegistered,
    getNtmBase: defaultGetNtmBase,
};
export async function detectInstallState(opts) {
    const probes = { ...DEFAULT_PROBES, ...(opts.probes ?? {}) };
    const cliChecks = REQUIRED_CLIS.map((cli) => probes.hasCli(cli));
    const [cliResults, agentMailOk, mcpRegistered, ntmBase] = await Promise.all([
        Promise.all(cliChecks),
        probes.isAgentMailAlive(),
        probes.isMcpRegistered(),
        probes.getNtmBase(),
    ]);
    const plan = {
        install: [],
        register: [],
        start: [],
        configure: [],
        skip: [],
    };
    REQUIRED_CLIS.forEach((cli, idx) => {
        (cliResults[idx] ? plan.skip : plan.install).push(cli);
    });
    if (!agentMailOk)
        plan.start.push('agent-mail HTTP');
    else
        plan.skip.push('agent-mail HTTP');
    if (!mcpRegistered)
        plan.register.push('agent-flywheel MCP server');
    else
        plan.skip.push('agent-flywheel MCP server');
    if (ntmBase) {
        const expected = path.join(ntmBase, path.basename(opts.cwd));
        if (!existsSync(expected)) {
            plan.configure.push(`projects_base symlink: ${expected}`);
        }
        else {
            plan.skip.push(`projects_base symlink: ${expected}`);
        }
    }
    return plan;
}
/**
 * T3.2 — Render an `InstallPlan` as a fixed-shape bulleted list for the
 * `/flywheel-setup` Step 2 consent prompt. Pure stringifier; do not call
 * from probing code.
 *
 * The Skip row is omitted entirely when nothing is already configured, so
 * fresh-machine plans do not show a noisy empty "Skip" line.
 */
export function renderPlan(plan) {
    const lines = ['Install plan:'];
    lines.push(plan.install.length
        ? `  • Install ${plan.install.length} tools: ${plan.install.join(', ')}`
        : '  • Install: (none)');
    lines.push(plan.register.length
        ? `  • Register: ${plan.register.join(', ')}`
        : '  • Register: (none)');
    lines.push(plan.configure.length
        ? `  • Symlink: ${plan.configure.join(', ')}`
        : '  • Symlink: (none)');
    lines.push(plan.start.length
        ? `  • Start: ${plan.start.join(', ')}`
        : '  • Start: (none)');
    if (plan.skip.length) {
        lines.push(`  • Skip (already configured): ${plan.skip.join(', ')}`);
    }
    return lines.join('\n');
}
/**
 * T3.2 — True when the plan has zero actionable items. `skip` does not
 * count: a skip-only plan means everything is already configured, so the
 * setup skill should short-circuit to "already configured, run doctor."
 */
export function isPlanEmpty(plan) {
    return (plan.install.length +
        plan.register.length +
        plan.start.length +
        plan.configure.length ===
        0);
}
/**
 * Walks an `InstallPlan` in a fixed order: `install` → `register` →
 * `configure` (symlinks) → `start` (services). Does NOT short-circuit on
 * a failed step — the caller (skills/flywheel-setup) decides retry, skip,
 * or abort, which lets the operator finish symlinking even when a brew
 * install hiccups. Returns one `BatchResult` per planned action; empty
 * buckets contribute nothing.
 */
export async function executeBatch(plan, exec) {
    const results = [];
    for (const tool of plan.install)
        results.push(await exec.installTool(tool));
    for (const name of plan.register)
        results.push(await exec.registerMcp(name));
    for (const cfg of plan.configure)
        results.push(await exec.symlink(cfg));
    for (const _svc of plan.start)
        results.push(await exec.startAgentMail());
    return results;
}
/**
 * Symlink helper for the `configure` bucket. Accepts either a raw absolute
 * path or a `"projects_base symlink: <abs-target>"` plan-line and creates
 * `<target>` pointing at `cwd`. Idempotent — if `target` already exists,
 * returns `ok` with `note: "already symlinked"`.
 */
export async function performSymlink(cwd, spec) {
    const target = spec.startsWith("projects_base symlink:")
        ? spec.slice("projects_base symlink:".length).trim()
        : spec.trim();
    if (existsSync(target)) {
        return { status: "ok", step: "symlink", target, note: "already symlinked" };
    }
    try {
        await symlink(cwd, target);
        return { status: "ok", step: "symlink", target };
    }
    catch (err) {
        return {
            status: "error",
            step: "symlink",
            target,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
/**
 * Step 4 of `/flywheel-setup`. Invokes the injected doctor once, then
 * stringifies the report into either a success banner or a list of
 * failing checks (yellow + red) with each one's `hint` surfaced inline.
 * Falls back to a generic "see /flywheel-doctor" pointer when a check has
 * no hint of its own.
 */
export async function runPostFlight(opts) {
    const report = await opts.doctor({ cwd: opts.cwd });
    if (report.overall === "green") {
        return "✓ Setup complete. Run /agent-flywheel:start to begin.";
    }
    const failing = report.checks.filter((c) => c.severity !== "green");
    return [
        `⚠ Setup left ${failing.length} issue(s):`,
        ...failing.map((c) => `  • ${c.name}: ${c.message ?? "(no message)"}\n    Try: ${c.hint ?? "see /flywheel-doctor"}`),
    ].join("\n");
}
/**
 * Idempotent MCP-server registration: merges `mcpServers["agent-flywheel"]`
 * into `~/.claude.json` via atomic tmp+rename. Existing `mcpServers` keys
 * are preserved. If the key is already present, returns `ok` with
 * `note: "already registered"`.
 */
export async function registerMcpAtomic(opts) {
    const target = opts?.configPath ?? path.join(os.homedir(), ".claude.json");
    const pluginRoot = opts?.pluginRoot ?? process.env.CLAUDE_PLUGIN_ROOT ?? "";
    let cfg = {};
    try {
        const raw = await readFile(target, "utf8");
        cfg = JSON.parse(raw);
    }
    catch {
        /* missing or unparseable file — treat as empty */
    }
    cfg.mcpServers ??= {};
    if (cfg.mcpServers["agent-flywheel"]) {
        return { status: "ok", step: "registerMcp", note: "already registered" };
    }
    cfg.mcpServers["agent-flywheel"] = {
        command: "node",
        args: [path.join(pluginRoot, "mcp-server/dist/index.js")],
    };
    const tmp = `${target}.tmp.${process.pid}`;
    try {
        await writeFile(tmp, JSON.stringify(cfg, null, 2));
        await rename(tmp, target);
        return { status: "ok", step: "registerMcp", target };
    }
    catch (err) {
        return {
            status: "error",
            step: "registerMcp",
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
async function defaultHasCli(bin) {
    try {
        execSync(`command -v ${bin}`, { stdio: 'ignore' });
        return true;
    }
    catch {
        return false;
    }
}
async function defaultIsAgentMailAlive() {
    return new Promise((resolve) => {
        const req = http.request({
            host: '127.0.0.1',
            port: 8765,
            path: '/health/liveness',
            method: 'GET',
            timeout: 1500,
        }, (res) => {
            res.resume();
            resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
        req.end();
    });
}
async function defaultIsMcpRegistered() {
    const candidates = [
        path.join(os.homedir(), '.claude.json'),
        path.join(os.homedir(), '.config', 'claude', 'config.json'),
    ];
    for (const file of candidates) {
        try {
            if (!existsSync(file))
                continue;
            const raw = readFileSync(file, 'utf8');
            if (/agent-flywheel/.test(raw))
                return true;
        }
        catch {
            /* fall through */
        }
    }
    return false;
}
async function defaultGetNtmBase() {
    try {
        const out = execSync('ntm config show', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 2000,
        });
        const match = out.match(/projects_base\s*[=:]\s*"?([^"\n]+)"?/);
        return match?.[1]?.trim() ?? null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=setup-detector.js.map