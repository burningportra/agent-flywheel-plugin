import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { runPlan } from '../tools/plan.js';
import { checkWaveVerification, runAdvanceWave } from '../tools/advance-wave.js';
import {
  buildAntiRationalizationRules,
  buildPreCompletionQualityGate,
} from '../adapters/completion-attestation-prompt.js';
import {
  computePatchId,
  writeCompletionReport,
  type CompletionReportV1,
  type VerificationBlock,
} from '../completion-report.js';
import { makeExec, type ExecFn } from '../exec.js';
import type { CheckpointState } from '../state.js';
import type { Bead, FlywheelState } from '../types.js';
import { createMockExec, makeState, type ExecCall } from './helpers/mocks.js';

vi.mock('../memory.js', () => ({ readMemory: () => '' }));

const realExec = makeExec();
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ─── flywheel_plan poteto prerequisites ───────────────────

describe('flywheel_plan poteto prerequisites', () => {
  const GOAL = 'Add caching layer';
  const SLUG = 'add-caching-layer';
  const PLAN = '# Plan\n\nDo the thing.\n';

  function makeCtx(cwd: string, stateOverrides: Partial<CheckpointState> = {}) {
    const state: CheckpointState = makeState({ selectedGoal: GOAL, ...stateOverrides });
    const saved: CheckpointState[] = [];
    const ctx = {
      exec: createMockExec(),
      cwd,
      state,
      saveState: (s: FlywheelState) => { saved.push(structuredClone(s)); },
      clearState: () => {},
    };
    return { ctx, state, saved };
  }

  async function writeDoc(cwd: string, rel: string, body = '# doc\n'): Promise<void> {
    await mkdir(path.dirname(path.join(cwd, rel)), { recursive: true });
    await writeFile(path.join(cwd, rel), body, 'utf8');
  }

  function errorOf(result: Awaited<ReturnType<typeof runPlan>>) {
    return (result.structuredContent as { data: { error: { code: string; details?: Record<string, unknown> } } }).data.error;
  }

  it('refuses poteto planning without the interrogation and ADR docs, and records nothing', async () => {
    const cwd = await makeTempDir('fw-poteto-plan-');
    const { ctx, state, saved } = makeCtx(cwd);

    const result = await runPlan(ctx, { cwd, poteto: true, planContent: PLAN });

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: 'poteto_prerequisite_missing',
      details: {
        missing: [`docs/specs/${SLUG}-interrogation.md`, `docs/architecture/${SLUG}-adr.md`],
      },
    });
    expect(state.potetoMode).toBeUndefined();
    expect(saved).toEqual([]);
  });

  it('names only the missing doc, and treats an empty file as missing', async () => {
    const cwd = await makeTempDir('fw-poteto-plan-');
    await writeDoc(cwd, `docs/specs/${SLUG}-interrogation.md`);
    await writeDoc(cwd, `docs/architecture/${SLUG}-adr.md`, '');
    const { ctx } = makeCtx(cwd);

    const result = await runPlan(ctx, { cwd, poteto: true, planContent: PLAN });

    expect(errorOf(result)).toMatchObject({
      code: 'poteto_prerequisite_missing',
      details: { missing: [`docs/architecture/${SLUG}-adr.md`] },
    });
  });

  it('turns poteto mode on and records the doc paths once both exist', async () => {
    const cwd = await makeTempDir('fw-poteto-plan-');
    await writeDoc(cwd, `docs/specs/${SLUG}-interrogation.md`);
    await writeDoc(cwd, `docs/architecture/${SLUG}-adr.md`);
    const { ctx, state, saved } = makeCtx(cwd);

    const result = await runPlan(ctx, { cwd, poteto: true, planContent: PLAN });

    expect(result.isError).toBeFalsy();
    expect(state).toMatchObject({
      potetoMode: true,
      interrogationDocPath: `docs/specs/${SLUG}-interrogation.md`,
      architectureDocPath: `docs/architecture/${SLUG}-adr.md`,
    });
    expect(saved[0]).toMatchObject({ potetoMode: true });
  });

  it('accepts docs at the paths the checkpoint already records', async () => {
    const cwd = await makeTempDir('fw-poteto-plan-');
    await writeDoc(cwd, 'notes/interrogation.md');
    await writeDoc(cwd, 'notes/adr.md');
    const { ctx, state } = makeCtx(cwd, {
      interrogationDocPath: 'notes/interrogation.md',
      architectureDocPath: 'notes/adr.md',
    });

    const result = await runPlan(ctx, { cwd, poteto: true, planContent: PLAN });

    expect(result.isError).toBeFalsy();
    expect(state.potetoMode).toBe(true);
    expect(state.interrogationDocPath).toBe('notes/interrogation.md');
  });

  it('refuses a research checklist with a false or missing area', async () => {
    const cwd = await makeTempDir('fw-poteto-plan-');
    const { ctx, state } = makeCtx(cwd);

    const result = await runPlan(ctx, {
      cwd,
      planContent: PLAN,
      preCodeResearch: { architecture: true, dependencies: false, security: true },
    });

    expect(errorOf(result)).toMatchObject({
      code: 'pre_code_research_incomplete',
      details: { incomplete: ['dependencies', 'performance'] },
    });
    expect(state.preCodeResearch).toBeUndefined();
  });

  it('records the research as complete when every area is done', async () => {
    const cwd = await makeTempDir('fw-poteto-plan-');
    const { ctx, state } = makeCtx(cwd);

    const result = await runPlan(ctx, {
      cwd,
      planContent: PLAN,
      preCodeResearch: { architecture: true, dependencies: true, security: true, performance: true },
    });

    expect(result.isError).toBeFalsy();
    expect(state.preCodeResearch?.complete).toBe(true);
  });
});

// ─── Verification gate (real git) ─────────────────────────

const BEAD = 'demo-abc';

async function makeRepo() {
  const repo = await makeTempDir('fw-poteto-gate-');
  const git = async (...args: string[]): Promise<string> => {
    const result = await realExec(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd: repo, timeout: 10_000 },
    );
    if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = async (file: string, content: string, message: string): Promise<string> => {
    await writeFile(path.join(repo, file), content, 'utf8');
    await git('add', file);
    await git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  await git('init', '-q');
  return { repo, git, commit };
}

function report(beadId: string, verification?: VerificationBlock): CompletionReportV1 {
  return {
    version: 1,
    beadId,
    agentName: 'Implementer',
    status: 'closed',
    changedFiles: ['a.txt'],
    commits: ['abc1234'],
    ubs: { ran: true, summary: 'clean', findingsFixed: 0, deferredBeadIds: [] },
    verify: [{ command: 'npm test', exitCode: 0, summary: 'ok' }],
    selfReview: { ran: true, summary: 'ok' },
    beadClosedVerified: true,
    reservationsReleased: true,
    ...(verification ? { verification } : {}),
    createdAt: '2026-10-21T20:00:00.000Z',
  };
}

async function verifiedBlock(repo: string, baseSha: string, headSha: string): Promise<VerificationBlock> {
  const patchId = await computePatchId(realExec, repo, baseSha, headSha);
  if (!patchId) throw new Error('expected a non-empty range');
  return {
    verdict: 'verified',
    baseSha,
    headSha,
    patchId,
    verifier: 'IndependentVerifier',
    verifiedAt: '2026-10-21T20:30:00.000Z',
    evidence: ['Verify, unit: exit 0'],
  };
}

async function ledgerRows(repo: string): Promise<string[][]> {
  try {
    const raw = await readFile(path.join(repo, '.pi-flywheel/ledger.tsv'), 'utf8');
    return raw.trim().split('\n').slice(1).map((line) => line.split('\t'));
  } catch {
    return [];
  }
}

describe('checkWaveVerification', () => {
  let repo: string;
  let commit: Awaited<ReturnType<typeof makeRepo>>['commit'];
  let git: Awaited<ReturnType<typeof makeRepo>>['git'];
  let base: string;

  beforeEach(async () => {
    ({ repo, commit, git } = await makeRepo());
    await commit('b.txt', 'b\n', 'seed b');
    base = await commit('a.txt', 'a\n', 'seed a');
  });

  const check = (beadIds: string[]) => checkWaveVerification({ exec: realExec, cwd: repo, beadIds });

  it('reports a missing report, a pending verdict, and a failed verdict, most severe first', async () => {
    const head = await commit('a.txt', 'a\nchange\n', `feat: change (${BEAD})`);
    const block = await verifiedBlock(repo, base, head);
    await writeCompletionReport(repo, report('pending', { ...block, verdict: 'needs-verification' }));
    await writeCompletionReport(repo, report('failed', { ...block, verdict: 'verification-failed' }));

    const result = await check(['absent', 'pending', 'failed']);

    expect(result.failures.map((f) => [f.beadId, f.code])).toEqual([
      ['failed', 'verification_failed'],
      ['absent', 'verification_missing'],
      ['pending', 'verification_missing'],
    ]);
    expect(await ledgerRows(repo)).toEqual([]);
  });

  it('passes a verdict whose head is on HEAD, even with later commits from other beads', async () => {
    const head = await commit('a.txt', 'a\nchange\n', `feat: change (${BEAD})`);
    await writeCompletionReport(repo, report(BEAD, await verifiedBlock(repo, base, head)));
    await commit('b.txt', 'b\nother bead\n', 'feat: other bead');

    const result = await check([BEAD]);

    expect(result).toEqual({ checked: [BEAD], failures: [], rebased: [] });
    expect(await ledgerRows(repo)).toEqual([]);
  });

  it('carries the verdict across a rebase that keeps the same diff, and logs the move', async () => {
    const head = await commit('a.txt', 'a\nchange\n', `feat: change (${BEAD})`);
    await writeCompletionReport(repo, report(BEAD, await verifiedBlock(repo, base, head)));
    await git('checkout', '-q', '-b', 'rebased', base);
    const upstream = await commit('b.txt', 'b\nupstream\n', 'upstream work');
    await git('cherry-pick', head);
    const newHead = await git('rev-parse', 'HEAD');

    const result = await check([BEAD]);

    expect(result.failures).toEqual([]);
    expect(result.rebased).toEqual([{ beadId: BEAD, fromHeadSha: head, toHeadSha: newHead }]);
    const rows = await ledgerRows(repo);
    expect(rows).toHaveLength(1);
    expect(rows[0].slice(1, 5)).toEqual([BEAD, 'verified', upstream, newHead]);
  });

  it('voids the verdict when the bead was amended after verification', async () => {
    const head = await commit('a.txt', 'a\nchange\n', `feat: change (${BEAD})`);
    await writeCompletionReport(repo, report(BEAD, await verifiedBlock(repo, base, head)));
    await writeFile(path.join(repo, 'a.txt'), 'a\nchange\nunverified edit\n', 'utf8');
    await git('commit', '-q', '--amend', '-a', '--no-edit');

    const result = await check([BEAD]);

    expect(result.failures).toMatchObject([{ beadId: BEAD, code: 'verification_sha_drift' }]);
    const rows = await ledgerRows(repo);
    expect(rows).toHaveLength(1);
    expect(rows[0][2]).toBe('needs-verification');
  });

  it('voids a verdict whose recorded patch id does not match the verified range', async () => {
    const head = await commit('a.txt', 'a\nchange\n', `feat: change (${BEAD})`);
    const block = await verifiedBlock(repo, base, head);
    await writeCompletionReport(repo, report(BEAD, { ...block, patchId: 'f'.repeat(40) }));

    const result = await check([BEAD]);

    expect(result.failures).toMatchObject([{ beadId: BEAD, code: 'verification_sha_drift' }]);
  });

  it('voids the verdict when the verified commits left HEAD and nothing names the bead', async () => {
    const head = await commit('a.txt', 'a\nchange\n', `feat: change (${BEAD})`);
    await writeCompletionReport(repo, report(BEAD, await verifiedBlock(repo, base, head)));
    await git('reset', '-q', '--hard', base);

    const result = await check([BEAD]);

    expect(result.failures).toMatchObject([
      { beadId: BEAD, code: 'verification_sha_drift', message: expect.stringContaining('not on HEAD') },
    ]);
  });
});

// ─── flywheel_advance_wave wiring ─────────────────────────

describe('flywheel_advance_wave verification gate', () => {
  const origRequired = process.env.FW_VERIFICATION_REQUIRED;
  const origAttestation = process.env.FW_ATTESTATION_REQUIRED;

  beforeEach(() => {
    delete process.env.FW_VERIFICATION_REQUIRED;
    delete process.env.FW_ATTESTATION_REQUIRED;
  });

  afterEach(() => {
    if (origRequired === undefined) delete process.env.FW_VERIFICATION_REQUIRED;
    else process.env.FW_VERIFICATION_REQUIRED = origRequired;
    if (origAttestation === undefined) delete process.env.FW_ATTESTATION_REQUIRED;
    else process.env.FW_ATTESTATION_REQUIRED = origAttestation;
  });

  function closedBead(id: string): Bead {
    return { id, title: id, description: id, status: 'closed', priority: 2, type: 'task', labels: [] };
  }

  /** br answers from fixtures; git (and the `sh` that pipes it into patch-id) runs for real. */
  function makeCtx(repo: string, stateOverrides: Partial<CheckpointState> = {}) {
    const mocked = createMockExec([
      {
        cmd: 'br',
        args: ['show', BEAD, '--json'],
        result: { code: 0, stdout: JSON.stringify(closedBead(BEAD)), stderr: '' },
      },
      { cmd: 'br', args: ['ready', '--limit', '0', '--json'], result: { code: 0, stdout: '[]', stderr: '' } },
    ] satisfies ExecCall[]);
    const exec: ExecFn = (cmd, args, opts) =>
      (cmd === 'git' || cmd === 'sh' ? realExec(cmd, args, opts) : mocked(cmd, args, opts));
    const state: CheckpointState = makeState({ selectedGoal: 'demo', phase: 'implementing', ...stateOverrides });
    return { exec, cwd: repo, state, saveState: () => {}, clearState: () => {} };
  }

  function errorCode(result: Awaited<ReturnType<typeof runAdvanceWave>>): string | undefined {
    return (result.structuredContent as { data: { error?: { code: string } } }).data.error?.code;
  }

  it('leaves the gate off without poteto mode or FW_VERIFICATION_REQUIRED', async () => {
    const { repo, commit } = await makeRepo();
    await commit('a.txt', 'a\n', `feat (${BEAD})`);
    await writeCompletionReport(repo, report(BEAD));

    const result = await runAdvanceWave(makeCtx(repo), { cwd: repo, closedBeadIds: [BEAD] });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { data: Record<string, unknown> }).data.verificationGate).toBeUndefined();
  });

  it('blocks with verification_missing under FW_VERIFICATION_REQUIRED=1', async () => {
    process.env.FW_VERIFICATION_REQUIRED = '1';
    const { repo, commit } = await makeRepo();
    await commit('a.txt', 'a\n', `feat (${BEAD})`);
    await writeCompletionReport(repo, report(BEAD));

    const result = await runAdvanceWave(makeCtx(repo), { cwd: repo, closedBeadIds: [BEAD] });

    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe('verification_missing');
  });

  it('advances in poteto mode once the bead carries a current verified verdict', async () => {
    const { repo, commit } = await makeRepo();
    const base = await commit('b.txt', 'b\n', 'seed');
    const head = await commit('a.txt', 'a\n', `feat (${BEAD})`);
    await writeCompletionReport(repo, report(BEAD, await verifiedBlock(repo, base, head)));

    const result = await runAdvanceWave(makeCtx(repo, { potetoMode: true }), { cwd: repo, closedBeadIds: [BEAD] });

    expect(result.isError, result.content[0].text).toBeFalsy();
    const data = (result.structuredContent as { data: Record<string, unknown> }).data;
    expect(data.verificationGate).toEqual({ checked: [BEAD], rebased: [] });
    expect(result.content[0].text).toContain('Verification gate: 1 bead(s) verified against HEAD');
  });

  it('blocks in poteto mode with verification_sha_drift after an unverified edit', async () => {
    const { repo, git, commit } = await makeRepo();
    const base = await commit('b.txt', 'b\n', 'seed');
    const head = await commit('a.txt', 'a\n', `feat (${BEAD})`);
    await writeCompletionReport(repo, report(BEAD, await verifiedBlock(repo, base, head)));
    await writeFile(path.join(repo, 'a.txt'), 'a\nsneaky\n', 'utf8');
    await git('commit', '-q', '--amend', '-a', '--no-edit');

    const result = await runAdvanceWave(makeCtx(repo, { potetoMode: true }), { cwd: repo, closedBeadIds: [BEAD] });

    expect(errorCode(result)).toBe('verification_sha_drift');
  });
});

// ─── Implementer prompt guardrails ────────────────────────

describe('anti-rationalization prompt rules', () => {
  it('always forbids unproven pre-existing claims, solo scope cuts, and skipped Verify commands', () => {
    const rules = buildAntiRationalizationRules();
    expect(rules).toContain('## ANTI-RATIONALIZATION RULES');
    expect(rules).toContain('ran the same command at the base SHA');
    expect(rules).toContain('AskUserQuestion');
    expect(rules).toContain('`Verify, unit:`, `Verify, live:`, and `Verify, perf:`');
    expect(rules).not.toContain('do not verify your own bead');
  });

  it('forbids self-verification only in poteto mode', () => {
    expect(buildAntiRationalizationRules({ potetoMode: true })).toContain('do not verify your own bead');
  });

  it('puts the rules ahead of the quality gate in every implementer prompt', () => {
    const plain = buildPreCompletionQualityGate({ beadId: 'b-1', agentName: 'A' });
    expect(plain.indexOf('## ANTI-RATIONALIZATION RULES')).toBeLessThan(plain.indexOf('## PRE-COMPLETION QUALITY GATE'));
    expect(plain).not.toContain('do not verify your own bead');

    const poteto = buildPreCompletionQualityGate({ beadId: 'b-1', agentName: 'A', potetoMode: true });
    expect(poteto).toContain('do not verify your own bead');
  });
});
