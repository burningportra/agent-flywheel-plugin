import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { listTemplates } from '../bead-templates.js';
import { computeDurationStats } from '../calibration-store.js';
import { parseBrList, type BrListRow } from '../br-parser.js';
import { FlywheelError, classifyExecError } from '../errors.js';
import type { ExecFn } from '../exec.js';
import { createLogger } from '../logger.js';
import { EFFORT_TO_MINUTES, type EstimatedEffort } from '../types.js';

const log = createLogger('calibrate');

export const CalibrateInputSchema = z.object({
  cwd: z.string().min(1),
  sinceDays: z.number().int().min(1).max(365).optional().default(90),
});
export type CalibrateInput = z.infer<typeof CalibrateInputSchema>;

export interface CalibrationRow {
  templateId: string;
  templateVersion?: number;
  estimatedEffort: EstimatedEffort | null;
  estimatedMinutes: number;
  sampleCount: number;
  meanMinutes: number;
  medianMinutes: number;
  p95Minutes: number;
  ratio: number;
  lowConfidence: boolean;
  proxyStartedCount: number;
}

export interface CalibrationReport {
  cwd: string;
  sinceDays: number;
  generatedAt: string;
  totalBeadsConsidered: number;
  droppedBeads: number;
  rows: CalibrationRow[];
  untemplated: { count: number };
}

const BR_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 5_000;
const GIT_FANOUT_CAP = 200;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const UNTEMPLATED_KEY = '__untemplated__';

interface GroupedSample {
  durationMinutes: number;
  proxyStarted: boolean;
}

interface TemplateKey {
  id: string;
  version?: number;
}

function parseTemplateRef(template: string | undefined): TemplateKey {
  if (!template) return { id: UNTEMPLATED_KEY };
  const at = template.lastIndexOf('@');
  if (at === -1) return { id: template };
  const id = template.slice(0, at);
  const versionStr = template.slice(at + 1);
  const version = Number.parseInt(versionStr, 10);
  return Number.isFinite(version) ? { id, version } : { id: template };
}

function lookupEffort(id: string, version?: number): { effort: EstimatedEffort | null; resolvedVersion?: number } {
  if (id === UNTEMPLATED_KEY) return { effort: null };
  const all = listTemplates().filter((t) => t.id === id);
  if (all.length === 0) return { effort: null };
  const match = version === undefined
    ? all.reduce((acc, t) => (t.version > acc.version ? t : acc))
    : all.find((t) => t.version === version);
  if (!match) return { effort: null };
  return { effort: match.estimatedEffort ?? null, resolvedVersion: match.version };
}

async function getStartedTs(
  beadId: string,
  exec: ExecFn,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const res = await exec(
      'git',
      ['log', `--grep=${beadId}`, '--format=%aI', '--reverse', '-1'],
      { timeout: GIT_TIMEOUT_MS, signal },
    );
    if (res.code !== 0) return null;
    const ts = res.stdout.trim().split(/\r?\n/)[0]?.trim();
    return ts && ts.length > 0 ? ts : null;
  } catch {
    return null;
  }
}

function atomicWriteJson(targetPath: string, payload: unknown): void {
  const dir = join(targetPath, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, targetPath);
}

export async function runCalibrate(
  args: CalibrateInput,
  exec: ExecFn,
  signal: AbortSignal,
): Promise<CalibrationReport> {
  const { cwd, sinceDays } = args;

  let brResult: { code: number; stdout: string; stderr: string };
  try {
    brResult = await exec(
      'br',
      ['list', '--json', '--status', 'closed'],
      { timeout: BR_TIMEOUT_MS, cwd, signal },
    );
  } catch (err) {
    const classified = classifyExecError(err);
    throw new FlywheelError({
      code: classified.code,
      message: `br list --json --status closed failed: ${classified.cause}`,
      cause: classified.cause,
      retryable: classified.retryable,
    });
  }

  if (brResult.code !== 0) {
    throw new FlywheelError({
      code: 'cli_failure',
      message: `br list exited with code ${brResult.code}: ${brResult.stderr.slice(0, 500)}`,
      cause: brResult.stderr.slice(0, 500),
    });
  }

  const { rows } = parseBrList(brResult.stdout);

  const cutoffMs = Date.now() - sinceDays * MS_PER_DAY;
  const inWindow: BrListRow[] = [];
  for (const row of rows) {
    if (!row.created_ts) continue;
    const createdMs = Date.parse(row.created_ts);
    if (!Number.isFinite(createdMs)) continue;
    if (createdMs < cutoffMs) continue;
    inWindow.push(row);
  }

  let droppedBeads = 0;
  let gitFanoutCount = 0;
  const groups = new Map<string, { samples: GroupedSample[]; templateKey: TemplateKey }>();

  for (const bead of inWindow) {
    if (!bead.closed_ts) {
      droppedBeads++;
      continue;
    }
    const closedMs = Date.parse(bead.closed_ts);
    if (!Number.isFinite(closedMs)) {
      droppedBeads++;
      continue;
    }

    let startedTs: string | null = null;
    let proxyStarted = true;

    if (gitFanoutCount < GIT_FANOUT_CAP) {
      gitFanoutCount++;
      const fromGit = await getStartedTs(bead.id, exec, signal);
      if (fromGit) {
        startedTs = fromGit;
        proxyStarted = false;
      }
    }

    if (!startedTs) {
      startedTs = bead.created_ts ?? null;
      proxyStarted = true;
    }

    if (!startedTs) {
      droppedBeads++;
      continue;
    }

    const startedMs = Date.parse(startedTs);
    if (!Number.isFinite(startedMs)) {
      droppedBeads++;
      continue;
    }

    const durationMinutes = (closedMs - startedMs) / MS_PER_MINUTE;
    if (durationMinutes < 0) {
      droppedBeads++;
      continue;
    }

    const templateKey = parseTemplateRef(bead.template);
    const groupKey = templateKey.version === undefined
      ? templateKey.id
      : `${templateKey.id}@${templateKey.version}`;

    const existing = groups.get(groupKey);
    if (existing) {
      existing.samples.push({ durationMinutes, proxyStarted });
    } else {
      groups.set(groupKey, {
        samples: [{ durationMinutes, proxyStarted }],
        templateKey,
      });
    }
  }

  const untemplatedGroup = groups.get(UNTEMPLATED_KEY);
  const untemplatedCount = untemplatedGroup?.samples.length ?? 0;

  const calibrationRows: CalibrationRow[] = [];
  for (const [groupKey, group] of groups) {
    if (group.templateKey.id === UNTEMPLATED_KEY) continue;

    const { effort, resolvedVersion } = lookupEffort(
      group.templateKey.id,
      group.templateKey.version,
    );
    const estimatedMinutes = effort ? EFFORT_TO_MINUTES[effort] : 0;

    const durations = group.samples.map((s) => s.durationMinutes);
    const stats = computeDurationStats(durations);
    const proxyStartedCount = group.samples.reduce(
      (acc, s) => acc + (s.proxyStarted ? 1 : 0),
      0,
    );

    const ratio = estimatedMinutes > 0 && Number.isFinite(stats.meanMinutes)
      ? stats.meanMinutes / estimatedMinutes
      : 0;

    calibrationRows.push({
      templateId: group.templateKey.id,
      templateVersion: group.templateKey.version ?? resolvedVersion,
      estimatedEffort: effort,
      estimatedMinutes,
      sampleCount: stats.count,
      meanMinutes: stats.meanMinutes,
      medianMinutes: stats.medianMinutes,
      p95Minutes: stats.p95Minutes,
      ratio,
      lowConfidence: stats.count < 5,
      proxyStartedCount,
    });

    void groupKey;
  }

  calibrationRows.sort((a, b) => b.ratio - a.ratio);

  const report: CalibrationReport = {
    cwd,
    sinceDays,
    generatedAt: new Date().toISOString(),
    totalBeadsConsidered: inWindow.length,
    droppedBeads,
    rows: calibrationRows,
    untemplated: { count: untemplatedCount },
  };

  try {
    const reportPath = join(cwd, '.pi-flywheel', 'calibration.json');
    atomicWriteJson(reportPath, report);
  } catch (err) {
    log.warn('failed to write calibration report', { err: String(err) });
  }

  return report;
}
