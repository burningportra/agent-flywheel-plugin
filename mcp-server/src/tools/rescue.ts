import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { z } from 'zod';

import { pickAgentName } from '../adapters/agent-names.js';
import {
  buildRescuePacket,
  formatRescueEventForMemory,
  MAX_TEXT_FIELD_LENGTH,
  renderRescuePromptForCodex,
  type RescuePacket,
  type RescuePhase,
} from '../codex-handoff.js';
import {
  classifyExecError,
  DEFAULT_HINTS,
  DEFAULT_RETRYABLE,
  DEFAULT_TRY_THIS,
  FlywheelErrorCodeSchema,
  FlywheelStructuredErrorSchema,
  errMsg,
  type FlywheelErrorCode,
} from '../errors.js';
import type { McpToolResult, ToolContext } from '../types.js';
import { runMemory } from './memory-tool.js';
import { makeToolResult } from './shared.js';

const TOOL_NAME = 'flywheel_rescue' as const;
const RESCUE_PHASES = ['plan', 'impl', 'review'] as const satisfies readonly RescuePhase[];
const GIT_DIFF_TIMEOUT_MS = 10_000;

const RescueErrorEnvelopeSchema = z
  .object({
    code: FlywheelErrorCodeSchema,
    message: z.string().max(MAX_TEXT_FIELD_LENGTH).optional(),
    hint: z.string().max(MAX_TEXT_FIELD_LENGTH).optional(),
  })
  .passthrough();

export const RescueInputSchema = z.object({
  cwd: z.string().min(1),
  phase: z.enum(RESCUE_PHASES),
  beadId: z.string().min(1).max(200).optional(),
  errorEnvelope: RescueErrorEnvelopeSchema.optional(),
  notes: z.string().max(MAX_TEXT_FIELD_LENGTH).optional(),
});

export type RescueArgs = z.infer<typeof RescueInputSchema>;

interface PhasePolicy {
  artifactExtension: 'diff' | 'md';
  defaultNextStep: string;
  label: string;
}

const PHASE_POLICIES: Record<RescuePhase, PhasePolicy> = {
  plan: {
    artifactExtension: 'md',
    label: 'planning',
    defaultNextStep:
      'Re-plan the failing section with explicit acceptance criteria; if blocked, surface one clarifying question.',
  },
  impl: {
    artifactExtension: 'diff',
    label: 'implementation',
    defaultNextStep:
      'Apply a minimal fixup without rewriting the bead, then run the repository build and tests.',
  },
  review: {
    artifactExtension: 'md',
    label: 'review',
    defaultNextStep:
      'Read the consolidated review evidence and return one accept-or-request-change verdict with blocking concerns.',
  },
};

export interface RescueToolData {
  packet: RescuePacket;
  codexPrompt: string;
  memoryLine: string;
}

export interface RescueSuccessEnvelope {
  tool: typeof TOOL_NAME;
  version: 1;
  status: 'ok';
  phase: string;
  data: RescueToolData;
}

export interface RescueErrorEnvelope {
  tool: typeof TOOL_NAME;
  version: 1;
  status: 'error';
  phase: string;
  data: {
    kind: 'error';
    error: {
      code: FlywheelErrorCode;
      message: string;
      retryable: boolean;
      hint: string;
      try_this: string;
      cause?: string;
      details?: Record<string, unknown>;
      timestamp: string;
    };
  };
}

type RescueToolResult = McpToolResult<RescueSuccessEnvelope | RescueErrorEnvelope>;

type ArtifactFailure = {
  ok: false;
  code: FlywheelErrorCode;
  message: string;
  retryable?: boolean;
  hint?: string;
  cause?: string;
};

type ArtifactResult = { ok: true; relativePath: string } | ArtifactFailure;
type DiffResult = { ok: true; diff: string } | ArtifactFailure;

function makeRescueError(
  ctx: ToolContext,
  code: FlywheelErrorCode,
  message: string,
  options: {
    retryable?: boolean;
    hint?: string;
    cause?: string;
    details?: Record<string, unknown>;
  } = {},
): RescueToolResult {
  const structured: RescueErrorEnvelope = {
    tool: TOOL_NAME,
    version: 1,
    status: 'error',
    phase: ctx.state.phase,
    data: {
      kind: 'error',
      error: {
        code,
        message,
        retryable: options.retryable ?? DEFAULT_RETRYABLE[code],
        hint: options.hint ?? DEFAULT_HINTS[code],
        try_this: DEFAULT_TRY_THIS[code],
        ...(options.cause ? { cause: options.cause } : {}),
        ...(options.details ? { details: options.details } : {}),
        timestamp: new Date().toISOString(),
      },
    },
  };
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: structured,
    isError: true,
  };
}

function sanitizeArtifactSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'unassigned';
}

async function readWorkingTreeDiff(ctx: ToolContext): Promise<DiffResult> {
  let result;
  try {
    result = await ctx.exec('git', ['diff'], {
      cwd: ctx.cwd,
      timeout: GIT_DIFF_TIMEOUT_MS,
      signal: ctx.signal,
    });
  } catch (error: unknown) {
    const classified = classifyExecError(error);
    return {
      ok: false,
      code: classified.code,
      message: 'Unable to capture the working-tree diff for the rescue artifact.',
      retryable: classified.retryable,
      hint: 'Run `git diff` in the project directory, resolve the failure, then retry flywheel_rescue.',
      cause: classified.cause,
    };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      code: 'cli_failure',
      message: `Unable to capture the working-tree diff: ${result.stderr.trim() || `git diff exited ${result.code}`}`,
      retryable: true,
      hint: 'Run `git diff` in the project directory, resolve the failure, then retry flywheel_rescue.',
      cause: result.stderr.trim() || undefined,
    };
  }
  return { ok: true, diff: result.stdout };
}

function rescueGoal(ctx: ToolContext, phase: RescuePhase, beadId: string | undefined): string {
  if (ctx.state.selectedGoal?.trim()) return ctx.state.selectedGoal.trim();
  const policy = PHASE_POLICIES[phase];
  return beadId
    ? `Recover ${policy.label} for bead ${beadId}`
    : `Recover the stalled ${policy.label} phase`;
}

async function materializeArtifact(
  ctx: ToolContext,
  args: RescueArgs,
  beadId: string | undefined,
): Promise<ArtifactResult> {
  if (args.phase === 'plan' && ctx.state.planDocument?.trim()) {
    return { ok: true, relativePath: ctx.state.planDocument.trim() };
  }

  const policy = PHASE_POLICIES[args.phase];
  const artifactDir = join(ctx.cwd, '.pi-flywheel', 'rescue');
  const stem = `${args.phase}-${sanitizeArtifactSegment(beadId ?? 'unassigned')}-${Date.now()}`;
  const relativePath = `.pi-flywheel/rescue/${stem}.${policy.artifactExtension}`;
  const absolutePath = join(artifactDir, `${stem}.${policy.artifactExtension}`);

  let content: string;
  if (args.phase === 'plan') {
    content = [
      '# Planning rescue context',
      '',
      `Goal: ${rescueGoal(ctx, args.phase, beadId)}`,
      `Error: ${args.errorEnvelope?.message ?? '(no error message supplied)'}`,
      `Hint: ${args.errorEnvelope?.hint ?? '(none)'}`,
      `Notes: ${args.notes?.trim() || '(none)'}`,
      '',
    ].join('\n');
  } else {
    const diffResult = await readWorkingTreeDiff(ctx);
    if (!diffResult.ok) return diffResult;
    if (args.phase === 'impl') {
      content = diffResult.diff || '# No working-tree diff was available.\n';
    } else {
      const reviews = beadId ? (ctx.state.beadReviews?.[beadId] ?? []) : [];
      content = [
        '# Review rescue context',
        '',
        `Bead: ${beadId ?? '(not supplied)'}`,
        `Notes: ${args.notes?.trim() || '(none)'}`,
        '',
        '## Recorded review evidence',
        '',
        reviews.length > 0 ? JSON.stringify(reviews, null, 2) : '(none recorded)',
        '',
        '## Working-tree diff',
        '',
        '```diff',
        diffResult.diff,
        '```',
        '',
      ].join('\n');
    }
  }

  try {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
    return { ok: true, relativePath };
  } catch (error: unknown) {
    return {
      ok: false,
      code: 'internal_error',
      message: `Unable to write the rescue artifact at ${relativePath}.`,
      retryable: true,
      hint: 'Check that .pi-flywheel/rescue is writable, then retry flywheel_rescue.',
      cause: errMsg(error),
    };
  }
}

function memoryFailureResult(
  ctx: ToolContext,
  result: McpToolResult,
  artifactPath: string,
): RescueToolResult {
  const parsed = FlywheelStructuredErrorSchema.safeParse(result.structuredContent);
  if (parsed.success) {
    const error = parsed.data.data.error;
    return makeRescueError(
      ctx,
      error.code,
      `Rescue packet created, but CASS persistence failed: ${error.message}`,
      {
        retryable: error.retryable,
        hint: error.hint,
        cause: error.cause,
        details: { ...error.details, artifactPath },
      },
    );
  }
  return makeRescueError(
    ctx,
    'cli_failure',
    'Rescue packet created, but CASS persistence failed.',
    {
      retryable: true,
      hint: 'Run flywheel_memory with operation="store" and the returned memory line, then retry flywheel_rescue.',
      details: { artifactPath },
    },
  );
}

export async function runRescue(
  ctx: ToolContext,
  input: unknown,
): Promise<RescueToolResult> {
  const parsed = RescueInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return makeRescueError(
      ctx,
      'invalid_input',
      `flywheel_rescue: ${issue?.message ?? 'invalid input'}`,
      {
        retryable: false,
        hint: 'Pass cwd plus phase="plan", "impl", or "review". beadId, errorEnvelope, and notes are optional.',
        details: { field: issue?.path.join('.') },
      },
    );
  }

  const args = parsed.data;
  const beadId = (args.beadId ?? ctx.state.currentBeadId) || undefined;
  const artifact = await materializeArtifact(ctx, args, beadId);
  if (!artifact.ok) {
    return makeRescueError(ctx, artifact.code, artifact.message, {
      retryable: artifact.retryable,
      hint: artifact.hint,
      cause: artifact.cause,
    });
  }

  const errorEnvelope = args.errorEnvelope;
  const packet = buildRescuePacket({
    phase: args.phase,
    goal: rescueGoal(ctx, args.phase, beadId),
    artifact_path: artifact.relativePath,
    error_code: errorEnvelope?.code ?? 'internal_error',
    hint: errorEnvelope?.hint ?? '',
    recent_tool_calls: errorEnvelope
      ? [
          {
            ts: new Date().toISOString(),
            name: `${args.phase}_stall`,
            outcome: 'error',
            summary:
              errorEnvelope.message ??
              (errorEnvelope.hint ??
                `${PHASE_POLICIES[args.phase].label} phase stalled`),
          },
        ]
      : [],
    proposed_next_step:
      args.notes?.trim() || PHASE_POLICIES[args.phase].defaultNextStep,
  });
  const adapted = renderRescuePromptForCodex(packet, {
    coordinatorName: 'Coordinator',
    projectKey: basename(ctx.cwd),
    rescueAgentName: pickAgentName(
      `rescue:${args.phase}:${beadId ?? basename(ctx.cwd)}`,
    ),
  });
  const codexPrompt = `${adapted.prompt}${'\n'.repeat(adapted.trailingNewlines)}`;
  const memoryLine = formatRescueEventForMemory(packet);
  const memoryResult = await runMemory(ctx, {
    cwd: ctx.cwd,
    operation: 'store',
    content: memoryLine,
  });
  if (memoryResult.isError) {
    return memoryFailureResult(ctx, memoryResult, artifact.relativePath);
  }

  const data: RescueToolData = { packet, codexPrompt, memoryLine };
  const structured: RescueSuccessEnvelope = {
    tool: TOOL_NAME,
    version: 1,
    status: 'ok',
    phase: ctx.state.phase,
    data,
  };
  return makeToolResult(
    `flywheel_rescue: phase=${args.phase} artifact=${packet.artifact_path} prompt_chars=${codexPrompt.length} memory=stored`,
    structured,
  );
}
