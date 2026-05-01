import type { McpToolResult, ToolContext, AdvanceWaveArgs, Bead } from '../types.js';
import type { VerifyBeadsOutcome } from './verify-beads.js';
import { runVerifyBeads } from './verify-beads.js';
import { readyBeads } from '../beads.js';
import { recommendComposition } from '../swarm.js';
import { classifyBeadComplexity, type BeadComplexity } from '../model-routing.js';
import { allocateAgentNames } from '../adapters/agent-names.js';
import { adaptPromptForClaude } from '../adapters/claude-prompt.js';
import { adaptPromptForCodex } from '../adapters/codex-prompt.js';
import { adaptPromptForGemini } from '../adapters/gemini-prompt.js';
import type { BeadDispatchContext, AdaptedPrompt } from '../adapters/codex-prompt.js';
import { makeOkToolResult, makeToolError } from './shared.js';
import { classifyExecError } from '../errors.js';
import { createLogger } from '../logger.js';
import * as path from 'node:path';

const log = createLogger('advance-wave');

const LANES = ['cc', 'cod', 'gem'] as const;
type Lane = typeof LANES[number];

const LANE_ADAPTERS: Record<Lane, (ctx: BeadDispatchContext) => AdaptedPrompt> = {
  cc: adaptPromptForClaude,
  cod: adaptPromptForCodex,
  gem: adaptPromptForGemini,
};

export interface AdvanceWaveOutcome {
  verification: VerifyBeadsOutcome;
  nextWave: {
    beadIds: string[];
    prompts: Array<{ beadId: string; lane: Lane; prompt: string }>;
    complexity: Record<string, BeadComplexity>;
  } | null;
  waveComplete: boolean;
  /**
   * Stage 1 attestation rollout flag. `true` when one or more closed beads
   * have missing or invalid completion attestation AND the
   * `FW_ATTESTATION_REQUIRED` env var is NOT set. Surfaces the warning to
   * the caller without blocking advance.
   *
   * When `FW_ATTESTATION_REQUIRED=1`, missing/invalid evidence becomes a
   * hard error (`attestation_missing` / `attestation_invalid`) instead.
   */
  needsEvidence: boolean;
}

function isAttestationRequired(): boolean {
  // Treat any non-empty value besides "0"/"false" as enabled. Empty / unset
  // means warn-only (Stage 1 default — duel-agreed: PI2 reveal-phase
  // concession that hard-blocking on day-one breaks in-flight workflows).
  const v = process.env.FW_ATTESTATION_REQUIRED?.trim().toLowerCase();
  return v != null && v !== '' && v !== '0' && v !== 'false';
}

function okResult(phase: string, text: string, data: AdvanceWaveOutcome): McpToolResult {
  return makeOkToolResult('flywheel_advance_wave', phase, text, data);
}

function beadToDispatchContext(
  bead: Bead,
  complexity: BeadComplexity,
  agentName: string,
  coordinatorName: string,
  projectKey: string,
): BeadDispatchContext {
  const descLines = bead.description.split('\n');
  const acceptance = descLines
    .filter((l) => /^\s*[-*]\s/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);

  return {
    beadId: bead.id,
    title: bead.title,
    description: bead.description,
    acceptance: acceptance.length > 0 ? acceptance : ['Complete the bead as described.'],
    complexity,
    relevantFiles: [],
    priorArtBeads: [],
    agentName,
    coordinatorName,
    projectKey,
  };
}

export async function runAdvanceWave(
  ctx: ToolContext,
  args: AdvanceWaveArgs,
): Promise<McpToolResult> {
  const { exec, cwd, state, signal } = ctx;

  if (!Array.isArray(args.closedBeadIds) || args.closedBeadIds.length === 0) {
    return makeToolError(
      'flywheel_advance_wave',
      state.phase,
      'invalid_input',
      'Error: closedBeadIds must be a non-empty array of bead IDs from the completed wave.',
      { hint: 'Pass closedBeadIds as a non-empty string array — the wave of beads to verify before advancing.' },
    );
  }

  // Step 1: verify the completed wave
  const verifyResult = await runVerifyBeads(ctx, { cwd, beadIds: args.closedBeadIds });
  const verification = (verifyResult.structuredContent as any)?.data as VerifyBeadsOutcome | undefined;

  if (!verification || verifyResult.isError) {
    return verifyResult;
  }

  if (verification.unclosedNoCommit.length > 0) {
    const stragglerIds = verification.unclosedNoCommit.map((s) => s.id);
    const outcome: AdvanceWaveOutcome = {
      verification,
      nextWave: null,
      waveComplete: false,
      needsEvidence: false,
    };
    const lines = [
      `Wave incomplete: ${verification.unclosedNoCommit.length} bead(s) still open without commits.`,
      ...stragglerIds.map((id) => `  - ${id}`),
      'Resolve these before advancing to the next wave.',
    ];
    return okResult(state.phase, lines.join('\n'), outcome);
  }

  // Step 1.5: attestation gate (Stage 1 — warn-only by default).
  // `FW_ATTESTATION_REQUIRED=1` flips to hard-block.
  const required = isAttestationRequired();
  if (verification.invalidEvidence.length > 0 && required) {
    const ids = verification.invalidEvidence.map((e) => e.beadId);
    const summary = verification.invalidEvidence
      .map((e) => `${e.beadId}: ${e.code}`)
      .join('; ');
    return makeToolError(
      'flywheel_advance_wave',
      state.phase,
      'attestation_invalid',
      `Cannot advance wave — ${verification.invalidEvidence.length} bead(s) have invalid completion attestation: ${summary}`,
      {
        hint: 'Re-read the offending CompletionReport JSON, fix the schema or invariant violation (e.g. status=closed without beadClosedVerified=true), and rewrite the file before re-invoking flywheel_advance_wave.',
        details: { beadIds: ids, invalidEvidence: verification.invalidEvidence },
      },
    );
  }
  if (verification.missingEvidence.length > 0 && required) {
    return makeToolError(
      'flywheel_advance_wave',
      state.phase,
      'attestation_missing',
      `Cannot advance wave — ${verification.missingEvidence.length} closed bead(s) missing completion attestation: ${verification.missingEvidence.join(', ')}`,
      {
        hint: 'Each closed bead must have a `.pi-flywheel/completion/<beadId>.json` file matching CompletionReportSchemaV1. Have the implementor write the report (see mcp-server/src/completion-report.ts) before re-invoking.',
        details: { beadIds: verification.missingEvidence },
      },
    );
  }
  const needsEvidence =
    !required &&
    (verification.missingEvidence.length > 0 || verification.invalidEvidence.length > 0);

  // Step 2: get ready beads for the next wave
  let ready: Bead[];
  try {
    ready = await readyBeads(exec, cwd);
  } catch (err: unknown) {
    const classified = classifyExecError(err);
    log.error('readyBeads threw', { err: String(err), code: classified.code });
    return makeToolError(
      'flywheel_advance_wave',
      state.phase,
      classified.code,
      `Error reading next frontier: ${classified.cause}`,
      {
        retryable: classified.retryable,
        hint: 'Check that br CLI is installed and operational, then retry.',
      },
    );
  }

  if (ready.length === 0) {
    const outcome: AdvanceWaveOutcome = {
      verification,
      nextWave: null,
      waveComplete: true,
      needsEvidence,
    };
    return okResult(state.phase, 'Wave verified. Queue drained — no more beads to dispatch.', outcome);
  }

  // Step 3: determine wave size from composition tier
  const composition = recommendComposition(ready.length);
  const maxWave = args.maxNextWave ?? composition.total;
  const waveCandidates = ready.slice(0, maxWave);

  // Step 4: classify complexity + allocate names
  const complexityMap: Record<string, BeadComplexity> = {};
  for (const bead of waveCandidates) {
    complexityMap[bead.id] = classifyBeadComplexity(bead).complexity;
  }

  const projectKey = path.basename(cwd);
  const coordinatorName = 'Coordinator';
  const agentNames = allocateAgentNames(waveCandidates.length, projectKey);

  // Step 5: render per-lane prompts round-robin
  const prompts: Array<{ beadId: string; lane: Lane; prompt: string }> = [];
  for (let i = 0; i < waveCandidates.length; i++) {
    const bead = waveCandidates[i];
    const lane = LANES[i % LANES.length];
    const dispatchCtx = beadToDispatchContext(
      bead,
      complexityMap[bead.id],
      agentNames[i],
      coordinatorName,
      projectKey,
    );
    const adapted = LANE_ADAPTERS[lane](dispatchCtx);
    prompts.push({ beadId: bead.id, lane, prompt: adapted.prompt });
  }

  const outcome: AdvanceWaveOutcome = {
    verification,
    nextWave: {
      beadIds: waveCandidates.map((b) => b.id),
      prompts,
      complexity: complexityMap,
    },
    waveComplete: true,
    needsEvidence,
  };

  const lines = [
    `Wave verified (${verification.verified.length}/${args.closedBeadIds.length} closed).`,
  ];
  if (needsEvidence) {
    if (verification.missingEvidence.length > 0) {
      lines.push(`⚠️  ${verification.missingEvidence.length} bead(s) advanced without completion attestation (Stage 1 warn-only — set FW_ATTESTATION_REQUIRED=1 to block).`);
    }
    if (verification.invalidEvidence.length > 0) {
      lines.push(`⚠️  ${verification.invalidEvidence.length} bead(s) advanced with invalid completion attestation (Stage 1 warn-only — set FW_ATTESTATION_REQUIRED=1 to block).`);
    }
  }
  lines.push(`Next wave: ${waveCandidates.length} bead(s) dispatched across ${LANES.length} lanes.`);
  lines.push(...waveCandidates.map((b, i) => `  - ${b.id} → ${LANES[i % LANES.length]} (${complexityMap[b.id]})`));

  return okResult(state.phase, lines.join('\n'), outcome);
}
