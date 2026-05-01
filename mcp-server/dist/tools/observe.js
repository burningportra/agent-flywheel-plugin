/**
 * flywheel_observe — single-call session-state snapshot (T6, claude-orchestrator-29i).
 *
 * Source: 3-way duel consensus winner (avg 852, full report at
 * `docs/duels/2026-04-30.md`, plan at `docs/plans/2026-04-30-duel-winners.md`).
 *
 * Quoting the duel synthesis: "Doctor probes; status renders; observe snapshots."
 * This tool MUST NOT become a second `flywheel_doctor` or third `flywheel_status`.
 * It snapshots existing primitives in one round-trip.
 *
 * Hard rules (all 3 duel agents agreed; do NOT relax):
 *   1. Idempotent.
 *   2. Non-mutating — never writes checkpoint, never `saveState`, never any fs write.
 *   3. Doctor data either cached or short-budgeted (< 1.5s total tool runtime).
 *   4. Every external probe degrades gracefully — mark sub-section
 *      `unavailable: true` rather than failing the whole call.
 */
import { z } from 'zod';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readCheckpoint } from '../checkpoint.js';
import { runDoctorChecks } from './doctor.js';
import { parseBrList } from '../br-parser.js';
import { createLogger } from '../logger.js';
import { makeToolResult } from './shared.js';
import { classifyExecError, makeFlywheelErrorResult } from '../errors.js';
const log = createLogger('observe');
// ─── Constants ────────────────────────────────────────────────────────────
/** Per-probe timeout budget. Keeps the tool inside the 1.5s wall-clock target. */
const PROBE_TIMEOUT_MS = 1000;
/** Doctor cache TTL — fresh fetch only if older. */
const DOCTOR_CACHE_TTL_MS = 60_000;
/** Cap on filesystem-glob results so a runaway working tree can't blow up the envelope. */
const ARTIFACT_HARD_CAP = 50;
// ─── Schema ───────────────────────────────────────────────────────────────
const SeveritySchema = z.enum(['info', 'warn', 'red']);
const HintSchema = z.object({
    severity: SeveritySchema,
    message: z.string(),
    nextAction: z.string().optional(),
});
const GitSectionSchema = z.object({
    unavailable: z.literal(true).optional(),
    branch: z.string().optional(),
    head: z.string().optional(),
    dirty: z.boolean().optional(),
    untracked: z.array(z.string()).optional(),
    warning: z.string().optional(),
});
const CheckpointSectionSchema = z.object({
    exists: z.boolean(),
    phase: z.string().optional(),
    selectedGoal: z.string().optional(),
    planDocument: z.string().optional(),
    activeBeadIds: z.array(z.string()).optional(),
    warnings: z.array(z.string()),
});
const BeadCountsSchema = z.object({
    open: z.number().int().nonnegative(),
    in_progress: z.number().int().nonnegative(),
    closed: z.number().int().nonnegative(),
    deferred: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
});
const BeadReadyRowSchema = z.object({
    id: z.string(),
    title: z.string(),
    priority: z.number().int(),
});
const BeadsSectionSchema = z.object({
    initialized: z.boolean(),
    unavailable: z.literal(true).optional(),
    warning: z.string().optional(),
    counts: BeadCountsSchema,
    ready: z.array(BeadReadyRowSchema),
});
const AgentMailSectionSchema = z.object({
    reachable: z.boolean(),
    unreadCount: z.number().int().nonnegative().optional(),
    warning: z.string().optional(),
});
const NtmPaneSchema = z.object({
    name: z.string(),
    type: z.string().optional(),
    status: z.string().optional(),
});
const NtmSectionSchema = z.object({
    available: z.boolean(),
    panes: z.array(NtmPaneSchema).optional(),
    warning: z.string().optional(),
});
const ArtifactsSectionSchema = z.object({
    wizard: z.array(z.string()),
    flywheelScratch: z.array(z.string()),
    truncated: z.boolean().optional(),
});
export const FlywheelObserveReportSchema = z.object({
    version: z.literal(1),
    cwd: z.string(),
    timestamp: z.string(),
    elapsedMs: z.number().int().nonnegative(),
    git: GitSectionSchema,
    checkpoint: CheckpointSectionSchema,
    beads: BeadsSectionSchema,
    agentMail: AgentMailSectionSchema,
    ntm: NtmSectionSchema,
    artifacts: ArtifactsSectionSchema,
    hints: z.array(HintSchema),
    doctor: z
        .object({
        cached: z.boolean(),
        ageMs: z.number().int().nonnegative().optional(),
        overall: z.enum(['green', 'yellow', 'red']).optional(),
        unavailable: z.literal(true).optional(),
    })
        .optional(),
});
const doctorCache = new Map();
/** Test/internal hook — flush the cache. Not exported via the tool envelope. */
export function _resetDoctorCache() {
    doctorCache.clear();
}
// ─── Probe helpers (each must degrade gracefully) ─────────────────────────
async function probeGit(ctx) {
    try {
        const [branchR, headR, statusR] = await Promise.allSettled([
            ctx.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
                timeout: PROBE_TIMEOUT_MS,
                cwd: ctx.cwd,
                signal: ctx.signal,
            }),
            ctx.exec('git', ['rev-parse', 'HEAD'], {
                timeout: PROBE_TIMEOUT_MS,
                cwd: ctx.cwd,
                signal: ctx.signal,
            }),
            ctx.exec('git', ['status', '--porcelain'], {
                timeout: PROBE_TIMEOUT_MS,
                cwd: ctx.cwd,
                signal: ctx.signal,
            }),
        ]);
        const allFailed = branchR.status === 'rejected' &&
            headR.status === 'rejected' &&
            statusR.status === 'rejected';
        if (allFailed) {
            return { unavailable: true, warning: 'git probes failed' };
        }
        const branch = branchR.status === 'fulfilled' && branchR.value.code === 0
            ? branchR.value.stdout.trim()
            : undefined;
        const head = headR.status === 'fulfilled' && headR.value.code === 0
            ? headR.value.stdout.trim()
            : undefined;
        let dirty;
        let untracked;
        if (statusR.status === 'fulfilled' && statusR.value.code === 0) {
            const lines = statusR.value.stdout
                .split('\n')
                .map((l) => l.trimEnd())
                .filter(Boolean);
            dirty = lines.length > 0;
            untracked = lines
                .filter((l) => l.startsWith('??'))
                .map((l) => l.slice(3))
                .slice(0, ARTIFACT_HARD_CAP);
        }
        return { branch, head, dirty, untracked };
    }
    catch (err) {
        log.warn('git probe failed', { err: String(err) });
        return { unavailable: true, warning: 'git probe threw' };
    }
}
function readCheckpointSection(cwd) {
    try {
        const result = readCheckpoint(cwd);
        if (!result) {
            return { exists: false, warnings: [] };
        }
        const state = result.envelope.state;
        return {
            exists: true,
            phase: state.phase,
            selectedGoal: state.selectedGoal,
            planDocument: state.planDocument,
            activeBeadIds: state.activeBeadIds,
            warnings: result.warnings,
        };
    }
    catch (err) {
        log.warn('checkpoint read failed', { err: String(err) });
        return {
            exists: false,
            warnings: [`checkpoint read threw: ${String(err)}`],
        };
    }
}
async function probeBeads(ctx) {
    const emptyCounts = {
        open: 0,
        in_progress: 0,
        closed: 0,
        deferred: 0,
        total: 0,
    };
    let listResult;
    try {
        listResult = await ctx.exec('br', ['list', '--json', '--deferred'], { timeout: PROBE_TIMEOUT_MS, cwd: ctx.cwd, signal: ctx.signal });
    }
    catch (err) {
        return {
            initialized: false,
            unavailable: true,
            warning: `br unavailable: ${err instanceof Error ? err.message : String(err)}`,
            counts: emptyCounts,
            ready: [],
        };
    }
    if (listResult.code !== 0) {
        return {
            initialized: false,
            unavailable: true,
            warning: `br list exited ${listResult.code}: ${listResult.stderr.slice(0, 200)}`,
            counts: emptyCounts,
            ready: [],
        };
    }
    let parsed;
    try {
        parsed = parseBrList(listResult.stdout);
    }
    catch (err) {
        return {
            initialized: true,
            warning: `br list parse failed: ${err instanceof Error ? err.message : String(err)}`,
            counts: emptyCounts,
            ready: [],
        };
    }
    const counts = { ...emptyCounts };
    for (const row of parsed.rows) {
        counts.total += 1;
        const status = row.status;
        if (status === 'open' || status === 'in_progress' || status === 'closed' || status === 'deferred') {
            counts[status] += 1;
        }
    }
    // "ready" beads: open + no unmet dependencies. We approximate via `br ready`
    // — falling back to "all open" if the subcommand is unavailable so we never
    // fail the whole tool.
    let ready = [];
    try {
        const readyResult = await ctx.exec('br', ['ready', '--json'], { timeout: PROBE_TIMEOUT_MS, cwd: ctx.cwd, signal: ctx.signal });
        if (readyResult.code === 0) {
            const readyParsed = parseBrList(readyResult.stdout);
            ready = readyParsed.rows.slice(0, ARTIFACT_HARD_CAP).map((r) => ({
                id: r.id,
                title: r.title,
                priority: r.priority ?? 0,
            }));
        }
    }
    catch {
        // ready is optional — degrade silently.
    }
    return {
        initialized: true,
        counts,
        ready,
        ...(parsed.rejected > 0
            ? { warning: `${parsed.rejected} bead row(s) rejected by parser` }
            : {}),
    };
}
async function probeAgentMail(ctx) {
    // Lightweight liveness probe via curl — keeps us off the agent-mail RPC
    // path which has its own retry/timeout policy. We deliberately do NOT call
    // a tool that mutates server state.
    try {
        const result = await ctx.exec('curl', [
            '-s',
            '-o',
            '/dev/null',
            '-w',
            '%{http_code}',
            '--max-time',
            '1',
            'http://127.0.0.1:8765/health/liveness',
        ], { timeout: PROBE_TIMEOUT_MS, cwd: ctx.cwd, signal: ctx.signal });
        if (result.code !== 0) {
            return { reachable: false, warning: `curl exited ${result.code}` };
        }
        const status = result.stdout.trim();
        if (status !== '200') {
            return { reachable: false, warning: `liveness HTTP ${status}` };
        }
        return { reachable: true };
    }
    catch (err) {
        return {
            reachable: false,
            warning: `agent-mail probe failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
async function probeNtm(ctx) {
    try {
        const which = await ctx.exec('which', ['ntm'], {
            timeout: PROBE_TIMEOUT_MS,
            cwd: ctx.cwd,
            signal: ctx.signal,
        });
        if (which.code !== 0 || !which.stdout.trim()) {
            return { available: false };
        }
    }
    catch {
        return { available: false };
    }
    // ntm panes are best-effort — list when supported, ignore failures.
    try {
        const list = await ctx.exec('ntm', ['list', '--json'], {
            timeout: PROBE_TIMEOUT_MS,
            cwd: ctx.cwd,
            signal: ctx.signal,
        });
        if (list.code === 0 && list.stdout.trim()) {
            try {
                const parsed = JSON.parse(list.stdout);
                const panes = Array.isArray(parsed) ? parsed : [];
                const cleaned = panes
                    .slice(0, ARTIFACT_HARD_CAP)
                    .map((p) => {
                    if (p && typeof p === 'object') {
                        const o = p;
                        return {
                            name: typeof o.name === 'string' ? o.name : String(o.id ?? '?'),
                            type: typeof o.type === 'string' ? o.type : undefined,
                            status: typeof o.status === 'string' ? o.status : undefined,
                        };
                    }
                    return { name: String(p) };
                });
                return { available: true, panes: cleaned };
            }
            catch {
                return { available: true, warning: 'ntm list output not JSON' };
            }
        }
    }
    catch {
        // available but list errored — leave panes undefined.
    }
    return { available: true };
}
function probeArtifacts(cwd) {
    const wizard = [];
    const scratch = [];
    let truncated = false;
    try {
        const entries = readdirSync(cwd, { withFileTypes: true });
        for (const e of entries) {
            if (wizard.length >= ARTIFACT_HARD_CAP) {
                truncated = true;
                break;
            }
            if (e.isFile() && /^WIZARD_.*\.md$/.test(e.name)) {
                wizard.push(e.name);
            }
        }
    }
    catch (err) {
        log.warn('artifact glob failed', { err: String(err) });
    }
    for (const name of ['.simplify-ledger', 'refactor', '.pi-flywheel']) {
        try {
            if (existsSync(join(cwd, name))) {
                const st = statSync(join(cwd, name));
                scratch.push(st.isDirectory() ? `${name}/` : name);
            }
        }
        catch {
            // ignore — graceful degrade
        }
    }
    return {
        wizard,
        flywheelScratch: scratch,
        ...(truncated ? { truncated: true } : {}),
    };
}
async function getCachedOrFreshDoctor(ctx, now) {
    const entry = doctorCache.get(ctx.cwd);
    if (entry && now - entry.ts < DOCTOR_CACHE_TTL_MS) {
        return {
            cached: true,
            ageMs: now - entry.ts,
            overall: entry.report.overall,
        };
    }
    // Doctor budget: leave headroom inside the 1.5s wall-clock target.
    // Budget runs the doctor but with a tight ceiling — partial reports are OK.
    try {
        const report = await runDoctorChecks(ctx.cwd, ctx.signal, {
            totalBudgetMs: 800,
            perCheckTimeoutMs: 400,
            exec: ctx.exec,
        });
        doctorCache.set(ctx.cwd, { ts: now, report });
        return { cached: false, ageMs: 0, overall: report.overall };
    }
    catch (err) {
        log.warn('doctor probe failed', { err: String(err) });
        return { cached: false, unavailable: true };
    }
}
// ─── Hints derivation ─────────────────────────────────────────────────────
function deriveHints(report) {
    const hints = [];
    if (report.checkpoint.exists && report.checkpoint.warnings.length > 0) {
        for (const w of report.checkpoint.warnings) {
            hints.push({
                severity: 'warn',
                message: `checkpoint warning: ${w}`,
                nextAction: 'inspect .pi-flywheel/checkpoint.json or run flywheel_doctor',
            });
        }
    }
    if (report.beads.unavailable) {
        hints.push({
            severity: 'warn',
            message: 'br CLI unavailable — bead state cannot be observed',
            nextAction: 'install/update br (beads_rust) and rerun observe',
        });
    }
    else if (report.beads.initialized && report.beads.ready.length > 0) {
        const top = report.beads.ready[0];
        hints.push({
            severity: 'info',
            message: `${report.beads.ready.length} bead(s) ready to dispatch (top: ${top.id})`,
            nextAction: 'spawn an implementor via /flywheel-swarm or NTM',
        });
    }
    if (!report.agentMail.reachable) {
        hints.push({
            severity: 'warn',
            message: `agent-mail unreachable${report.agentMail.warning ? `: ${report.agentMail.warning}` : ''}`,
            nextAction: 'start agent-mail (am serve-http) or check port 8765',
        });
    }
    if (report.artifacts.wizard.length > 0) {
        hints.push({
            severity: 'info',
            message: `${report.artifacts.wizard.length} WIZARD_*.md duel artifact(s) present`,
            nextAction: 'route into docs/duels/ if synthesizing, or run /flywheel-cleanup if older than 7d',
        });
    }
    if (report.git.dirty) {
        hints.push({
            severity: 'info',
            message: 'working tree is dirty',
            nextAction: 'review uncommitted changes before phase transitions',
        });
    }
    if (report.doctor?.overall === 'red') {
        hints.push({
            severity: 'red',
            message: 'flywheel_doctor reports red overall',
            nextAction: 'run flywheel_doctor for details, then flywheel_remediate',
        });
    }
    // TODO(T7, claude-orchestrator-2r8): once the Completion Evidence schema
    // lands (T1, claude-orchestrator-2j1), surface missing/stale
    // `.pi-flywheel/completion/<beadId>.json` here as warn/info hints. The
    // hook point is intentionally inside this function so attestation hints
    // appear alongside other observability hints, not as a separate channel.
    return hints;
}
// ─── Rendering ────────────────────────────────────────────────────────────
function glyphForHint(severity) {
    switch (severity) {
        case 'info':
            return '[i]';
        case 'warn':
            return '[!]';
        case 'red':
            return '[X]';
    }
}
function renderObserveText(report) {
    const lines = [];
    lines.push(`flywheel observe — ${report.cwd} (${report.elapsedMs}ms${report.doctor?.cached ? ', doctor cached' : ''})`);
    if (report.git.unavailable) {
        lines.push(`  git: unavailable`);
    }
    else {
        const dirtyMark = report.git.dirty ? ' (dirty)' : '';
        lines.push(`  git: ${report.git.branch ?? '(detached)'} @ ${report.git.head?.slice(0, 7) ?? '?'}${dirtyMark}`);
    }
    lines.push(`  checkpoint: ${report.checkpoint.exists ? `phase=${report.checkpoint.phase}` : 'none'}`);
    if (report.beads.unavailable) {
        lines.push(`  beads: unavailable (${report.beads.warning})`);
    }
    else {
        lines.push(`  beads: ${report.beads.counts.total} total | ${report.beads.counts.open} open, ${report.beads.counts.in_progress} in-progress, ${report.beads.counts.closed} closed | ${report.beads.ready.length} ready`);
    }
    lines.push(`  agent-mail: ${report.agentMail.reachable ? 'reachable' : `unreachable${report.agentMail.warning ? ' — ' + report.agentMail.warning : ''}`}`);
    lines.push(`  ntm: ${report.ntm.available ? `available${report.ntm.panes ? ` (${report.ntm.panes.length} panes)` : ''}` : 'not on PATH'}`);
    lines.push(`  artifacts: ${report.artifacts.wizard.length} WIZARD_*.md, scratch=[${report.artifacts.flywheelScratch.join(', ') || 'none'}]`);
    if (report.doctor && !report.doctor.unavailable) {
        lines.push(`  doctor: ${report.doctor.overall ?? '?'}${report.doctor.cached ? ` (cached ${Math.round((report.doctor.ageMs ?? 0) / 1000)}s)` : ' (fresh)'}`);
    }
    if (report.hints.length > 0) {
        lines.push('');
        lines.push('hints:');
        for (const h of report.hints) {
            lines.push(`  ${glyphForHint(h.severity)} ${h.message}${h.nextAction ? ` → ${h.nextAction}` : ''}`);
        }
    }
    return lines.join('\n');
}
/**
 * Build a session-state snapshot in one MCP round-trip.
 *
 * Read-only. Never mutates checkpoint, never calls `saveState`, never writes
 * any file on disk. Aggregates existing primitives via Promise.allSettled
 * so a single probe failing degrades that section to `unavailable: true`
 * rather than failing the whole call.
 */
export async function runObserve(ctx, args) {
    const startMs = Date.now();
    void args;
    try {
        const [git, beads, agentMail, ntm, doctor] = await Promise.all([
            probeGit(ctx),
            probeBeads(ctx),
            probeAgentMail(ctx),
            probeNtm(ctx),
            getCachedOrFreshDoctor(ctx, startMs),
        ]);
        const checkpoint = readCheckpointSection(ctx.cwd);
        const artifacts = probeArtifacts(ctx.cwd);
        const elapsedMs = Date.now() - startMs;
        const partial = {
            version: 1,
            cwd: ctx.cwd,
            timestamp: new Date(startMs).toISOString(),
            elapsedMs,
            git,
            checkpoint,
            beads,
            agentMail,
            ntm,
            artifacts,
            doctor,
        };
        const hints = deriveHints(partial);
        const report = { ...partial, hints };
        const validated = FlywheelObserveReportSchema.safeParse(report);
        if (!validated.success) {
            log.warn('observe report failed self-validation', {
                issues: validated.error.issues.length,
            });
            // Self-validation failure is a programming error — surface as red hint
            // but still return the report so callers can recover.
            report.hints.push({
                severity: 'red',
                message: 'observe report failed schema validation (programming error)',
                nextAction: 'file a bug — report shape drifted from FlywheelObserveReportSchema',
            });
        }
        const structured = {
            tool: 'flywheel_observe',
            version: 1,
            status: 'ok',
            phase: 'observe',
            data: { kind: 'observe_report', report },
        };
        return makeToolResult(renderObserveText(report), structured);
    }
    catch (err) {
        // The tool is wrapped in graceful-degrade probes, so reaching here means
        // the orchestration layer itself failed. Classify and return a structured
        // error envelope without crashing the MCP transport.
        const classified = classifyExecError(err);
        return makeFlywheelErrorResult('flywheel_observe', 'observe', {
            code: classified.code,
            message: err instanceof Error ? err.message : String(err),
            retryable: classified.retryable,
            hint: 'observe orchestration failed unexpectedly — rerun flywheel_observe or set FW_LOG_LEVEL=debug to capture the cause.',
            cause: classified.cause,
        });
    }
}
//# sourceMappingURL=observe.js.map