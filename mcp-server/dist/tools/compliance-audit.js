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
}).passthrough();
const ComplianceResultSchema = z.object({
    pass_utc: z.string().nullable().optional(),
    beads: z.array(ComplianceResultBeadSchema).optional(),
}).passthrough();
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
        return errorComplianceResult(`Skill spawn threw: ${message}`, startedAt, { spawn: message });
    }
    const passesRoot = join(args.cwd, 'beads_compliance_audit', 'passes');
    if (!existsSync(passesRoot)) {
        return errorComplianceResult('Skill ran but produced no passes directory.', startedAt, { parse: `passes directory missing: ${passesRoot}` });
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
        return errorComplianceResult(`Could not inspect pass directories: ${message}`, startedAt, { parse: message });
    }
    if (subdirs.length === 0) {
        return errorComplianceResult('No pass directories found.', startedAt, { parse: 'no pass dirs' });
    }
    const latestPassDir = join(passesRoot, subdirs[0].name);
    const resultJsonPath = join(latestPassDir, 'result.json');
    if (!existsSync(resultJsonPath)) {
        return errorComplianceResult('result.json missing in latest pass.', startedAt, { parse: `result.json not found at ${resultJsonPath}` });
    }
    let parsedResult;
    try {
        const rawResult = JSON.parse(readFileSync(resultJsonPath, 'utf8'));
        const schemaResult = ComplianceResultSchema.safeParse(rawResult);
        if (!schemaResult.success) {
            const issues = schemaResult.error.issues
                .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
                .join('; ');
            return errorComplianceResult(`result.json schema validation failed: ${issues}`, startedAt, { parse: issues });
        }
        parsedResult = schemaResult.data;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorComplianceResult(`result.json parse failed: ${message}`, startedAt, { parse: message });
    }
    const passed = [];
    const failed = [];
    for (const bead of parsedResult.beads ?? []) {
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
    const errors = {};
    for (const bead of failed) {
        try {
            const updateResult = await ctx.exec('br', ['update', bead.beadId, '--status', 'open'], { cwd: args.cwd, timeout: 10000, signal: ctx.signal });
            if (updateResult.code !== 0) {
                errors[bead.beadId] = `br update failed (exit ${updateResult.code}): ${(updateResult.stderr || updateResult.stdout).slice(0, 500)}`;
                continue;
            }
            const commentBody = `Compliance audit reopened - score ${bead.score}/1000. See ${bead.reportPath}`;
            const commentResult = await ctx.exec('br', ['comments', 'add', bead.beadId, '--message', commentBody], { cwd: args.cwd, timeout: 10000, signal: ctx.signal });
            if (commentResult.code !== 0) {
                errors[`${bead.beadId}:comment`] = `br comment failed (exit ${commentResult.code}): ${(commentResult.stderr || commentResult.stdout).slice(0, 500)}`;
            }
        }
        catch (err) {
            errors[bead.beadId] = err instanceof Error ? err.message : String(err);
        }
    }
    if (failed.length > 0) {
        recordErrorCode('compliance_false_closed', {
            hashable: failed.map((bead) => bead.beadId).join(','),
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
    for (const bead of parsedResult.beads ?? []) {
        try {
            storeComplianceScore(args.cwd, {
                beadId: bead.id,
                score: bead.score,
                threshold,
                passed: bead.passed,
                rubric: bead.rubric_breakdown ?? {},
                passUtc: parsedResult.pass_utc ?? '',
                sessionId: process.env.FW_SESSION_ID ?? null,
                gitHead,
            });
        }
        catch (err) {
            errors[`cass:${bead.id}`] = err instanceof Error ? err.message : String(err);
        }
    }
    return okComplianceResult(`Compliance audit complete: ${passed.length} passed, ${failed.length} failed.`, startedAt, {
        passed,
        failed,
        passUtc: parsedResult.pass_utc ?? null,
        errors,
    });
}
//# sourceMappingURL=compliance-audit.js.map