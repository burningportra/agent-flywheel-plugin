import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import type { McpToolResult, ToolContext } from '../types.js';
import { makeOkToolResult, makeToolError } from './shared.js';

export const ComplianceAuditArgsSchema = z.object({
  cwd: z.string().min(1),
  beadIds: z.array(z.string()),
  mode: z.enum(['single-bead', 'standard']).optional(),
  threshold: z.number().optional(),
  parallelism: z.number().optional(),
  skipEnv: z.string().optional(),
});

export type ComplianceAuditArgs = z.infer<typeof ComplianceAuditArgsSchema>;

export interface ComplianceAuditOutcome {
  status: 'ok' | 'skipped' | 'error';
  passed: Array<{ beadId: string; score: number; reportPath: string }>;
  failed: Array<{ beadId: string; score: number; reportPath: string; reasons: string[] }>;
  passUtc: string | null;
  errors: Record<string, string>;
  durationMs: number;
}

const ComplianceResultBeadSchema = z.object({
  id: z.string(),
  score: z.number(),
  passed: z.boolean(),
  scorecard_path: z.string(),
  top_failures: z.array(z.string()).optional(),
}).passthrough();

const ComplianceResultSchema = z.object({
  pass_utc: z.string().nullable().optional(),
  beads: z.array(ComplianceResultBeadSchema).optional(),
}).passthrough();

function complianceOutcome(
  status: ComplianceAuditOutcome['status'],
  startedAt: number,
  overrides: Partial<ComplianceAuditOutcome> = {},
): ComplianceAuditOutcome & { kind: 'compliance_audit_outcome' } {
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

function okComplianceResult(
  text: string,
  startedAt: number,
  overrides: Partial<ComplianceAuditOutcome> = {},
): McpToolResult {
  return makeOkToolResult(
    'flywheel_compliance_audit',
    'reviewing',
    text,
    complianceOutcome(overrides.status ?? 'ok', startedAt, overrides),
  );
}

function errorComplianceResult(
  text: string,
  startedAt: number,
  errors: Record<string, string>,
): McpToolResult {
  return makeOkToolResult(
    'flywheel_compliance_audit',
    'reviewing',
    text,
    complianceOutcome('error', startedAt, { errors }),
  );
}

export async function runComplianceAudit(
  ctx: ToolContext,
  rawArgs: unknown,
): Promise<McpToolResult> {
  const startedAt = Date.now();
  const parsed = ComplianceAuditArgsSchema.safeParse(rawArgs);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    return makeToolError(
      'flywheel_compliance_audit',
      ctx.state.phase ?? 'reviewing',
      'invalid_input',
      `Error: invalid compliance audit arguments: ${issues}`,
      { hint: 'Pass { cwd, beadIds, mode?, threshold?, parallelism?, skipEnv? } per the tool inputSchema.' },
    );
  }

  const args = parsed.data;

  // Empty wave — no-op success.
  if (args.beadIds.length === 0) {
    return okComplianceResult('No beads to audit.', startedAt);
  }

  // Skip-env override (emergency unblock).
  const overrideEnv = args.skipEnv ?? process.env.FW_COMPLIANCE_OVERRIDE;
  if (overrideEnv && overrideEnv.length > 0) {
    return okComplianceResult(
      `Compliance audit skipped via FW_COMPLIANCE_OVERRIDE=${overrideEnv}.`,
      startedAt,
      { status: 'skipped' },
    );
  }

  const threshold = args.threshold ?? 700;
  const parallelism = Math.max(1, Math.min(args.parallelism ?? 5, 5));

  try {
    const spawnResult = await ctx.exec(
      'claude',
      [
        '--skill',
        'beads-compliance-and-completion-verification',
        '--',
        '--mode',
        'flywheel-gate',
        '--beads',
        args.beadIds.join(','),
        '--threshold',
        String(threshold),
        '--parallelism',
        String(parallelism),
      ],
      { cwd: args.cwd, timeout: 15 * 60 * 1000, signal: ctx.signal },
    );
    if (spawnResult.code !== 0) {
      const stderr = spawnResult.stderr.slice(0, 500);
      return errorComplianceResult(
        `Skill spawn failed (exit ${spawnResult.code}): ${stderr.slice(0, 200)}`,
        startedAt,
        { spawn: `exit ${spawnResult.code}: ${stderr}` },
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return errorComplianceResult(
      `Skill spawn threw: ${message}`,
      startedAt,
      { spawn: message },
    );
  }

  const passesRoot = join(args.cwd, 'beads_compliance_audit', 'passes');
  if (!existsSync(passesRoot)) {
    return errorComplianceResult(
      'Skill ran but produced no passes directory.',
      startedAt,
      { parse: `passes directory missing: ${passesRoot}` },
    );
  }

  let subdirs: Array<{ name: string; mtime: number }>;
  try {
    subdirs = readdirSync(passesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const fullPath = join(passesRoot, entry.name);
        return { name: entry.name, mtime: statSync(fullPath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return errorComplianceResult(
      `Could not inspect pass directories: ${message}`,
      startedAt,
      { parse: message },
    );
  }

  if (subdirs.length === 0) {
    return errorComplianceResult(
      'No pass directories found.',
      startedAt,
      { parse: 'no pass dirs' },
    );
  }

  const latestPassDir = join(passesRoot, subdirs[0].name);
  const resultJsonPath = join(latestPassDir, 'result.json');

  if (!existsSync(resultJsonPath)) {
    return errorComplianceResult(
      'result.json missing in latest pass.',
      startedAt,
      { parse: `result.json not found at ${resultJsonPath}` },
    );
  }

  let parsedResult: z.infer<typeof ComplianceResultSchema>;
  try {
    const rawResult = JSON.parse(readFileSync(resultJsonPath, 'utf8')) as unknown;
    const schemaResult = ComplianceResultSchema.safeParse(rawResult);
    if (!schemaResult.success) {
      const issues = schemaResult.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      return errorComplianceResult(
        `result.json schema validation failed: ${issues}`,
        startedAt,
        { parse: issues },
      );
    }
    parsedResult = schemaResult.data;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return errorComplianceResult(
      `result.json parse failed: ${message}`,
      startedAt,
      { parse: message },
    );
  }

  const passed: ComplianceAuditOutcome['passed'] = [];
  const failed: ComplianceAuditOutcome['failed'] = [];
  for (const bead of parsedResult.beads ?? []) {
    const reportPath = join(latestPassDir, bead.scorecard_path);
    if (bead.passed) {
      passed.push({ beadId: bead.id, score: bead.score, reportPath });
    } else {
      failed.push({
        beadId: bead.id,
        score: bead.score,
        reportPath,
        reasons: bead.top_failures ?? [],
      });
    }
  }

  // TODO(Task 7): side effects (br update, telemetry, CASS)
  return okComplianceResult(
    `Compliance audit complete: ${passed.length} passed, ${failed.length} failed.`,
    startedAt,
    {
      passed,
      failed,
      passUtc: parsedResult.pass_utc ?? null,
      errors: {},
    },
  );
}
