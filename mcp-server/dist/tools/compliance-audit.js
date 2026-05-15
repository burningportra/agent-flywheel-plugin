import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { storeComplianceScore } from '../cass-helpers.js';
import { recordErrorCode } from '../telemetry.js';
import { makeOkToolResult, makeToolError } from './shared.js';
export const ComplianceAuditArgsSchema = z.object({
    cwd: z.string().min(1),
    beadIds: z.array(z.string()),
    mode: z.enum(['single-bead', 'standard']).optional(),
    threshold: z.number().optional(),
    parallelism: z.number().optional(),
    skipEnv: z.string().optional(),
});
const ComplianceResultBeadSchema = z.object({
    id: z.string(),
    score: z.number(),
    passed: z.boolean(),
    scorecard_path: z.string(),
    rubric_breakdown: z.record(z.string(), z.string()).optional(),
    top_failures: z.array(z.string()).optional(),
}).strict();
const ComplianceResultSchema = z.object({
    schema_version: z.literal(1),
    pass_utc: z.string(),
    mode: z.literal('flywheel-gate'),
    threshold: z.number(),
    beads: z.array(ComplianceResultBeadSchema),
    session_id: z.string().nullable().optional(),
}).strict();
const ComplianceManifestBeadSchema = z.object({
    score: z.number(),
    verdict: z.string().optional(),
    gate: z.string().optional(),
}).passthrough();
const ComplianceManifestSchema = z.object({
    pass_id: z.string(),
    pass_started_at: z.string().optional(),
    mode: z.string().optional(),
    score_threshold: z.number().optional(),
    target_beads: z.array(z.string()).optional(),
    results: z.record(z.string(), ComplianceManifestBeadSchema),
    session_id: z.string().nullable().optional(),
}).passthrough();
function zodIssuesText(error) {
    return error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
}
function parseLegacyResultJson(resultJsonPath, latestPassDir) {
    try {
        const rawResult = JSON.parse(readFileSync(resultJsonPath, 'utf8'));
        const schemaResult = ComplianceResultSchema.safeParse(rawResult);
        if (!schemaResult.success) {
            const issues = zodIssuesText(schemaResult.error);
            return {
                ok: false,
                text: `result.json schema validation failed: ${issues}`,
                errors: { parse: issues },
            };
        }
        return {
            ok: true,
            value: { parsedResult: schemaResult.data, latestPassDir },
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            text: `result.json parse failed: ${message}`,
            errors: { parse: message },
        };
    }
}
function parseManifestJson(manifestJsonPath, latestPassDir, threshold) {
    try {
        const rawManifest = JSON.parse(readFileSync(manifestJsonPath, 'utf8'));
        const schemaResult = ComplianceManifestSchema.safeParse(rawManifest);
        if (!schemaResult.success) {
            const issues = zodIssuesText(schemaResult.error);
            return {
                ok: false,
                text: `manifest.json schema validation failed: ${issues}`,
                errors: { parse: issues },
            };
        }
        const manifest = schemaResult.data;
        const advisoryErrors = {};
        if (manifest.score_threshold !== undefined && manifest.score_threshold !== threshold) {
            advisoryErrors.threshold_mismatch =
                `manifest score_threshold ${manifest.score_threshold} ignored; using requested threshold ${threshold}`;
        }
        const orderedBeadIds = [
            ...(manifest.target_beads ?? []).filter((beadId) => manifest.results[beadId] !== undefined),
            ...Object.keys(manifest.results).filter((beadId) => !(manifest.target_beads ?? []).includes(beadId)),
        ];
        const beads = orderedBeadIds.map((beadId) => {
            const result = manifest.results[beadId];
            const normalizedGate = result.gate?.toUpperCase();
            const passed = normalizedGate === 'PASS' || (normalizedGate === undefined && result.score >= threshold);
            return {
                id: beadId,
                score: result.score,
                passed,
                scorecard_path: `beads/${beadId}/scorecard.md`,
                top_failures: passed
                    ? undefined
                    : [
                        result.verdict ?? 'Compliance gate failed',
                        ...(result.gate ? [`gate:${result.gate}`] : []),
                    ],
            };
        });
        return {
            ok: true,
            value: {
                parsedResult: {
                    schema_version: 1,
                    pass_utc: manifest.pass_started_at ?? manifest.pass_id,
                    mode: 'flywheel-gate',
                    threshold,
                    beads,
                    session_id: manifest.session_id ?? null,
                },
                latestPassDir,
                advisoryErrors: Object.keys(advisoryErrors).length > 0 ? advisoryErrors : undefined,
            },
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            text: `manifest.json parse failed: ${message}`,
            errors: { parse: message },
        };
    }
}
function complianceOutcome(status, startedAt, overrides = {}) {
    return {
        kind: 'compliance_audit_outcome',
        status,
        passed: [],
        failed: [],
        passUtc: null,
        errors: {},
        durationMs: Date.now() - startedAt,
        ...overrides,
    };
}
function okComplianceResult(text, startedAt, overrides = {}) {
    return makeOkToolResult('flywheel_compliance_audit', 'reviewing', text, complianceOutcome(overrides.status ?? 'ok', startedAt, overrides));
}
function errorComplianceResult(text, startedAt, errors) {
    return makeOkToolResult('flywheel_compliance_audit', 'reviewing', text, complianceOutcome('error', startedAt, { errors }));
}
function isTimeoutError(err) {
    if (err instanceof Error && /abort|timed?\s*out|timeout/i.test(err.message)) {
        return true;
    }
    if (!err || typeof err !== 'object') {
        return false;
    }
    const record = err;
    return record.timedOut === true
        || record.code === 'ETIMEDOUT'
        || record.name === 'AbortError'
        || record.signal === 'SIGTERM';
}
function readLatestComplianceResult(cwd, threshold) {
    const passesRoot = join(cwd, 'beads_compliance_audit', 'passes');
    if (!existsSync(passesRoot)) {
        return {
            ok: false,
            text: 'Skill ran but produced no passes directory.',
            errors: { parse: `passes directory missing: ${passesRoot}` },
        };
    }
    let subdirs;
    try {
        subdirs = readdirSync(passesRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => {
            const fullPath = join(passesRoot, entry.name);
            return { name: entry.name, mtime: statSync(fullPath).mtimeMs };
        })
            .sort((a, b) => b.mtime - a.mtime);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            text: `Could not inspect pass directories: ${message}`,
            errors: { parse: message },
        };
    }
    if (subdirs.length === 0) {
        return {
            ok: false,
            text: 'No pass directories found.',
            errors: { parse: 'no pass dirs' },
        };
    }
    const latestPassDir = join(passesRoot, subdirs[0].name);
    const manifestJsonPath = join(latestPassDir, 'manifest.json');
    const resultJsonPath = join(latestPassDir, 'result.json');
    if (existsSync(manifestJsonPath)) {
        return parseManifestJson(manifestJsonPath, latestPassDir, threshold);
    }
    if (existsSync(resultJsonPath)) {
        return parseLegacyResultJson(resultJsonPath, latestPassDir);
    }
    {
        return {
            ok: false,
            text: 'manifest.json missing in latest pass.',
            errors: {
                parse: `manifest.json not found at ${manifestJsonPath}; legacy result.json not found at ${resultJsonPath}`,
            },
        };
    }
}
async function finalizeComplianceAudit(ctx, args, threshold, startedAt, parsedResult, latestPassDir, options = {}) {
    const passed = [];
    const failed = [];
    for (const bead of parsedResult.beads) {
        const reportPath = join(latestPassDir, bead.scorecard_path);
        if (bead.passed) {
            passed.push({ beadId: bead.id, score: bead.score, reportPath });
        }
        else {
            failed.push({
                beadId: bead.id,
                score: bead.score,
                reportPath,
                reasons: bead.top_failures ?? [],
            });
        }
    }
    const errors = { ...(options.initialErrors ?? {}) };
    const parsedBeadIds = new Set(parsedResult.beads.map((bead) => bead.id));
    const timeoutMissingBeadIds = new Set(options.timeoutMissingBeadIds ?? []);
    for (const beadId of options.timeoutMissingBeadIds ?? []) {
        errors[beadId] = 'timeout';
        failed.push({
            beadId,
            score: 0,
            reportPath: join(latestPassDir, 'REPORT.md'),
            reasons: ['timeout'],
        });
    }
    for (const beadId of args.beadIds) {
        if (parsedBeadIds.has(beadId) || timeoutMissingBeadIds.has(beadId))
            continue;
        errors[beadId] = 'missing from skill output';
        failed.push({
            beadId,
            score: 0,
            reportPath: join(latestPassDir, 'REPORT.md'),
            reasons: ['missing from skill output'],
        });
    }
    for (const bead of failed) {
        try {
            const updateResult = await ctx.exec('br', ['update', bead.beadId, '--status', 'open'], { cwd: args.cwd, timeout: 10000, signal: ctx.signal });
            if (updateResult.code !== 0) {
                const errorKey = errors[bead.beadId] ? `${bead.beadId}:reopen` : bead.beadId;
                errors[errorKey] = `br update failed (exit ${updateResult.code}): ${(updateResult.stderr || updateResult.stdout).slice(0, 500)}`;
                continue;
            }
            const commentBody = `Compliance audit reopened - score ${bead.score}/1000. See ${bead.reportPath}`;
            const commentResult = await ctx.exec('br', ['comments', 'add', bead.beadId, '--message', commentBody], { cwd: args.cwd, timeout: 10000, signal: ctx.signal });
            if (commentResult.code !== 0) {
                errors[`${bead.beadId}:comment`] = `br comment failed (exit ${commentResult.code}): ${(commentResult.stderr || commentResult.stdout).slice(0, 500)}`;
            }
        }
        catch (err) {
            const errorKey = errors[bead.beadId] ? `${bead.beadId}:reopen` : bead.beadId;
            errors[errorKey] = err instanceof Error ? err.message : String(err);
        }
    }
    for (const bead of failed) {
        recordErrorCode('compliance_false_closed', {
            hashable: bead.beadId,
        });
    }
    let gitHead = 'unknown';
    try {
        const gitResult = await ctx.exec('git', ['rev-parse', 'HEAD'], { cwd: args.cwd, timeout: 5000, signal: ctx.signal });
        const trimmed = gitResult.stdout.trim();
        if (gitResult.code === 0 && trimmed.length > 0) {
            gitHead = trimmed;
        }
        else {
            errors.gitHead = `git rev-parse HEAD failed (exit ${gitResult.code}): ${(gitResult.stderr || gitResult.stdout || 'empty stdout').slice(0, 500)}`;
        }
    }
    catch (err) {
        errors.gitHead = err instanceof Error ? err.message : String(err);
    }
    for (const bead of parsedResult.beads) {
        try {
            storeComplianceScore(args.cwd, {
                beadId: bead.id,
                score: bead.score,
                threshold,
                passed: bead.passed,
                rubric: bead.rubric_breakdown ?? {},
                passUtc: parsedResult.pass_utc,
                sessionId: process.env.FW_SESSION_ID ?? null,
                gitHead,
            });
        }
        catch (err) {
            errors[`cass:${bead.id}`] = err instanceof Error ? err.message : String(err);
        }
    }
    const timedOut = (options.timeoutMissingBeadIds?.length ?? 0) > 0;
    const text = timedOut
        ? `Compliance audit timed out with partial result: ${passed.length} passed, ${failed.length} failed.`
        : `Compliance audit complete: ${passed.length} passed, ${failed.length} failed.`;
    return okComplianceResult(text, startedAt, {
        passed,
        failed,
        passUtc: parsedResult.pass_utc,
        errors,
    });
}
export async function runComplianceAudit(ctx, rawArgs) {
    const startedAt = Date.now();
    const parsed = ComplianceAuditArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ');
        return makeToolError('flywheel_compliance_audit', ctx.state.phase ?? 'reviewing', 'invalid_input', `Error: invalid compliance audit arguments: ${issues}`, { hint: 'Pass { cwd, beadIds, mode?, threshold?, parallelism?, skipEnv? } per the tool inputSchema.' });
    }
    const args = parsed.data;
    // Empty wave — no-op success.
    if (args.beadIds.length === 0) {
        return okComplianceResult('No beads to audit.', startedAt);
    }
    // Skip-env override (emergency unblock).
    const overrideEnv = args.skipEnv ?? process.env.FW_COMPLIANCE_OVERRIDE;
    if (overrideEnv && overrideEnv.length > 0) {
        return okComplianceResult(`Compliance audit skipped via FW_COMPLIANCE_OVERRIDE=${overrideEnv}.`, startedAt, { status: 'skipped' });
    }
    const threshold = args.threshold ?? 700;
    const parallelism = Math.max(1, Math.min(args.parallelism ?? 5, 5));
    const skillPrompt = [
        '/beads-compliance-and-completion-verification',
        '--mode',
        'flywheel-gate',
        '--beads',
        args.beadIds.join(','),
        '--threshold',
        String(threshold),
        '--parallelism',
        String(parallelism),
    ].join(' ');
    try {
        const spawnResult = await ctx.exec('claude', [
            '-p',
            '--permission-mode',
            'bypassPermissions',
            skillPrompt,
        ], { cwd: args.cwd, timeout: 15 * 60 * 1000, signal: ctx.signal });
        if (spawnResult.code !== 0) {
            const stderr = spawnResult.stderr.slice(0, 500);
            return errorComplianceResult(`Skill spawn failed (exit ${spawnResult.code}): ${stderr.slice(0, 200)}`, startedAt, { spawn: `exit ${spawnResult.code}: ${stderr}` });
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isTimeoutError(err)) {
            const latestResult = readLatestComplianceResult(args.cwd, threshold);
            if (!latestResult.ok) {
                return errorComplianceResult(`Skill spawn timed out; ${latestResult.text}`, startedAt, { spawn: message, ...latestResult.errors });
            }
            const parsedBeadIds = new Set(latestResult.value.parsedResult.beads.map((bead) => bead.id));
            const timeoutMissingBeadIds = args.beadIds.filter((beadId) => !parsedBeadIds.has(beadId));
            return finalizeComplianceAudit(ctx, args, threshold, startedAt, latestResult.value.parsedResult, latestResult.value.latestPassDir, {
                initialErrors: { ...(latestResult.value.advisoryErrors ?? {}), spawn: message },
                timeoutMissingBeadIds,
            });
        }
        return errorComplianceResult(`Skill spawn threw: ${message}`, startedAt, { spawn: message });
    }
    const latestResult = readLatestComplianceResult(args.cwd, threshold);
    if (!latestResult.ok) {
        return errorComplianceResult(latestResult.text, startedAt, latestResult.errors);
    }
    return finalizeComplianceAudit(ctx, args, threshold, startedAt, latestResult.value.parsedResult, latestResult.value.latestPassDir, { initialErrors: latestResult.value.advisoryErrors });
}
//# sourceMappingURL=compliance-audit.js.map