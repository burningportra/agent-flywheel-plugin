import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProfile } from '../../tools/profile.js';
import { runDiscover } from '../../tools/discover.js';
import { runSelect } from '../../tools/select.js';
import { runPlan } from '../../tools/plan.js';
import { runReview } from '../../tools/review.js';
import { createMockExec, makeState } from '../helpers/mocks.js';
import type { ExecCall } from '../helpers/mocks.js';
import type { Bead, CandidateIdea, FlywheelState, RepoProfile } from '../../types.js';

function makeRepoProfile(overrides: Partial<RepoProfile> = {}): RepoProfile {
  return {
    name: 'cwd',
    languages: ['TypeScript'],
    frameworks: [],
    structure: './src/index.ts',
    entrypoints: ['src/index.ts'],
    recentCommits: [],
    hasTests: true,
    testFramework: 'Vitest',
    hasDocs: true,
    hasCI: true,
    ciPlatform: 'GitHub Actions',
    todos: [],
    keyFiles: {},
    ...overrides,
  };
}

function makeIdea(overrides: Partial<CandidateIdea> = {}): CandidateIdea {
  return {
    id: 'idea-1',
    title: 'Add rate limiting',
    description: 'Protect API endpoints from abuse',
    category: 'feature',
    effort: 'medium',
    impact: 'high',
    rationale: 'High traffic endpoints need protection',
    tier: 'top',
    ...overrides,
  };
}

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    id: 'test-bead-1',
    title: 'Add feature X',
    description: 'Implement feature X.\n\nsrc/feature.ts\nsrc/feature.test.ts',
    status: 'in_progress',
    priority: 2,
    type: 'task',
    labels: [],
    ...overrides,
  };
}

function baseProfileExecCalls(): ExecCall[] {
  const fileTree = './src/index.ts\n./src/__tests__/foo.test.ts\n./docs/guide.md\n./.github/workflows/ci.yml\n./package.json\n./README.md';
  const gitLog = 'abc1234full\x00feat: add foo\x002024-01-01\x00Alice\n';
  return [
    {
      cmd: 'git',
      args: ['rev-parse', 'HEAD'],
      result: { code: 0, stdout: 'head-sha\n', stderr: '' },
    },
    {
      cmd: 'git',
      args: ['show', 'HEAD:.pi-flywheel/profile-cache.json'],
      result: { code: 1, stdout: '', stderr: 'missing cache' },
    },
    {
      cmd: 'find',
      args: [
        '.', '-maxdepth', '4',
        '-not', '-path', '*/node_modules/*',
        '-not', '-path', '*/.git/*',
        '-not', '-path', '*/dist/*',
        '-not', '-path', '*/__pycache__/*',
        '-not', '-path', '*/.venv/*',
        '-not', '-path', '*/vendor/*',
        '-not', '-path', '*/target/*',
      ],
      result: { code: 0, stdout: fileTree, stderr: '' },
    },
    {
      cmd: 'git',
      args: ['log', '--oneline', '--no-decorate', '-n', '20', '--format=%H%x00%s%x00%ai%x00%an'],
      result: { code: 0, stdout: gitLog, stderr: '' },
    },
    {
      cmd: 'grep',
      args: [
        '-rn',
        '--include=*.ts', '--include=*.js', '--include=*.tsx', '--include=*.jsx',
        '--include=*.py', '--include=*.rs', '--include=*.go', '--include=*.rb',
        '--include=*.java', '--include=*.kt', '--include=*.swift',
        '--exclude-dir=node_modules',
        '--exclude-dir=.git',
        '--exclude-dir=dist',
        '--exclude-dir=build',
        '--exclude-dir=vendor',
        '--exclude-dir=target',
        '--exclude-dir=__pycache__',
        '--exclude-dir=.venv',
        '--exclude-dir=.pi-flywheel',
        '-E', '(TODO|FIXME|HACK|XXX):',
        '.',
      ],
      result: { code: 1, stdout: '', stderr: '' },
    },
    {
      cmd: 'head',
      args: ['-c', '4096', 'package.json'],
      result: {
        code: 0,
        stdout: JSON.stringify({ name: 'cwd', devDependencies: { vitest: '^1.0.0' } }),
        stderr: '',
      },
    },
    {
      cmd: 'head',
      args: ['-c', '4096', 'README.md'],
      result: { code: 0, stdout: '# Readme', stderr: '' },
    },
    {
      cmd: 'head',
      args: ['-c', '4096', 'docs/guide.md'],
      result: { code: 0, stdout: '# Guide', stderr: '' },
    },
    {
      cmd: 'head',
      args: ['-c', '4096', '.github/workflows/ci.yml'],
      result: { code: 0, stdout: 'name: CI', stderr: '' },
    },
    {
      cmd: 'br',
      args: ['--version'],
      result: { code: 0, stdout: 'br 0.1.0', stderr: '' },
    },
    {
      cmd: 'br',
      args: ['list', '--json'],
      result: {
        code: 0,
        stdout: JSON.stringify([
          makeBead({ id: 'bead-open', status: 'open', description: 'Open bead' }),
          makeBead({ id: 'bead-deferred', status: 'deferred', description: 'Deferred bead' }),
        ]),
        stderr: '',
      },
    },
    {
      cmd: 'git',
      args: ['show', 'HEAD:.gitignore'],
      result: { code: 1, stdout: '', stderr: 'missing' },
    },
    {
      cmd: 'git',
      args: ['hash-object', '-w', '--stdin'],
      result: { code: 0, stdout: 'blob-sha\n', stderr: '' },
    },
    {
      cmd: 'git',
      args: ['update-index', '--add', '--cacheinfo', '100644', 'blob-sha', '.pi-flywheel/profile-cache.json'],
      result: { code: 0, stdout: '', stderr: '' },
    },
  ];
}

function makeCtx(execCalls: ExecCall[] = [], stateOverrides: Partial<FlywheelState> = {}, cwd = '/fake/cwd') {
  const state = makeState(stateOverrides);
  const saved: FlywheelState[] = [];
  const ctx = {
    exec: createMockExec(execCalls),
    cwd,
    state,
    saveState: (next: FlywheelState) => { saved.push(structuredClone(next)); },
    clearState: () => {},
  };
  return { ctx, state, saved };
}

describe('structured contract and state coherence', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-11T16:42:00.000Z'));
    tmpDir = mkdtempSync(join(tmpdir(), 'structured-coherence-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps profile text, structuredContent, and persisted state in lockstep', async () => {
    const { ctx, state, saved } = makeCtx(baseProfileExecCalls());

    const result = await runProfile(ctx, { cwd: '/fake/cwd' });
    const structured = result.structuredContent as {
      phase: string;
      data: {
        selectedGoal: string | undefined;
        coordination: { backend: string; beadsAvailable: boolean };
        existingBeads: { openCount: number; deferredCount: number };
        profileSummary: { name: string; languages: string[]; hasTests: boolean; entrypoints: string[] };
      };
    };

    expect(state.phase).toBe(structured.phase);
    expect(saved.at(-1)?.phase).toBe(structured.phase);
    expect(state.repoProfile?.name).toBe(structured.data.profileSummary.name);
    expect(state.repoProfile?.languages).toEqual(structured.data.profileSummary.languages);
    expect(state.repoProfile?.entrypoints).toEqual(structured.data.profileSummary.entrypoints);
    expect(state.coordinationStrategy).toBe(structured.data.coordination.backend);
    expect(state.coordinationBackend?.beads).toBe(structured.data.coordination.beadsAvailable);
    expect(structured.data.existingBeads).toEqual({ openCount: 1, deferredCount: 1 });
    expect(result.content[0].text).toContain('Coordination: beads');
    expect(result.content[0].text).toContain('1 open/in-progress');
    expect(result.content[0].text).toContain('Call `flywheel_discover`');
  });

  it('keeps discover text, structuredContent, and persisted candidate state aligned', async () => {
    const ideas = [
      makeIdea(),
      makeIdea({ id: 'idea-2', title: 'Better logging', tier: 'honorable' }),
    ];
    const { ctx, state, saved } = makeCtx([], { repoProfile: makeRepoProfile() });

    const result = await runDiscover(ctx, { cwd: '/fake/cwd', ideas });
    const structured = result.structuredContent as {
      phase: string;
      data: {
        totalIdeas: number;
        topIdeas: number;
        honorableIdeas: number;
        ideaIds: string[];
        ideas: Array<{ id: string; title: string; tier?: string }>;
      };
    };

    expect(state.phase).toBe(structured.phase);
    expect(saved.at(-1)?.candidateIdeas?.map((idea: CandidateIdea) => idea.id)).toEqual(structured.data.ideaIds);
    expect(state.candidateIdeas?.map((idea: CandidateIdea) => idea.id)).toEqual(structured.data.ideaIds);
    expect(state.candidateIdeas?.map((idea: CandidateIdea) => idea.title)).toEqual(structured.data.ideas.map((idea: { id: string; title: string; tier?: string }) => idea.title));
    expect(structured.data.totalIdeas).toBe(state.candidateIdeas?.length);
    expect(structured.data.topIdeas).toBe(1);
    expect(structured.data.honorableIdeas).toBe(1);
    expect(result.content[0].text).toContain('Present these 2 ideas');
    expect(result.content[0].text).toContain('Add rate limiting');
    expect(result.content[0].text).toContain('Better logging');
  });

  it('returns structured invalid-input details for discover errors without mutating state', async () => {
    const { ctx, state, saved } = makeCtx([], { repoProfile: makeRepoProfile(), phase: 'discovering' });

    const result = await runDiscover(ctx, { cwd: '/fake/cwd', ideas: [] });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      tool: 'flywheel_discover',
      version: 1,
      status: 'error',
      phase: 'discovering',
      data: {
        kind: 'error',
        error: {
          code: 'invalid_input',
          message: 'Error: No ideas provided. Pass at least 3 ideas in the ideas array.',
        },
      },
    });
    expect(state.candidateIdeas).toBeUndefined();
    expect(saved).toHaveLength(0);
    expect(result.content[0].text).toContain('Pass at least 3 ideas');
  });

  it('keeps select text, structuredContent, and persisted state aligned', async () => {
    const { ctx, state, saved } = makeCtx([], {
      repoProfile: makeRepoProfile(),
      constraints: ['must be backward compatible'],
      phase: 'awaiting_selection',
    });

    const result = await runSelect(ctx, { cwd: '/fake/cwd', goal: '  Add tests  ' });
    const structured = result.structuredContent as {
      phase: string;
      goal: string;
      data: { goal: string; constraints: string[]; workflowOptions: string[]; hasRepoProfile: boolean };
    };

    expect(state.phase).toBe(structured.phase);
    expect(state.selectedGoal).toBe(structured.goal);
    expect(saved.at(-1)?.selectedGoal).toBe(structured.data.goal);
    expect(saved.at(-1)?.constraints).toEqual(structured.data.constraints);
    expect(structured.data.workflowOptions).toEqual(['plan-first', 'deep-plan', 'direct-to-beads']);
    expect(structured.data.hasRepoProfile).toBe(true);
    expect(result.content[0].text).toContain('Goal selected:');
    expect(result.content[0].text).toContain('Add tests');
    expect(result.content[0].text).toContain('Option B: Deep plan');
  });

  it('returns structured plan not-found details for missing plan files', async () => {
    const { ctx, state } = makeCtx([], { selectedGoal: 'Add caching layer', phase: 'planning' }, tmpDir);

    const result = await runPlan(ctx, { cwd: tmpDir, planFile: 'missing.md' });

    expect(result.isError).toBe(true);
    expect(state.planDocument).toBeUndefined();
    expect(result.structuredContent).toEqual({
      tool: 'flywheel_plan',
      version: 1,
      status: 'error',
      phase: 'planning',
      data: {
        kind: 'error',
        error: {
          code: 'not_found',
          message: `Error: planFile not found: ${join(tmpDir, 'missing.md')}`,
          details: {
            planFile: 'missing.md',
            absolutePath: join(tmpDir, 'missing.md'),
          },
        },
      },
    });
    expect(result.content[0].text).toContain('planFile not found');
    expect(result.content[0].text).toContain(join(tmpDir, 'missing.md'));
  });

  it('keeps standard plan prompt path coherent across text, structuredContent, and state', async () => {
    const { ctx, state, saved } = makeCtx([], {
      selectedGoal: 'Add caching layer',
      repoProfile: makeRepoProfile(),
      constraints: ['must support Node 18'],
    }, tmpDir);

    const result = await runPlan(ctx, { cwd: tmpDir, mode: 'standard' });
    const structured = result.structuredContent as { phase: string; data: { planDocument: string; constraints: string[] } };

    expect(state.phase).toBe(structured.phase);
    expect(state.planDocument).toBe(structured.data.planDocument);
    expect(saved.at(-1)?.planDocument).toBe(structured.data.planDocument);
    expect(structured.data.constraints).toEqual(['must support Node 18']);
    expect(result.content[0].text).toContain(structured.data.planDocument);
    expect(result.content[0].text).toContain('Plan Document Requirements');
    expect(result.content[0].text).toContain('must support Node 18');
  });

  it('keeps large plan approval payloads size-aware and truncates preview text', async () => {
    const longLine = 'x'.repeat(30);
    const planContent = Array.from({ length: 650 }, (_, index) => `line-${index}-${longLine}`).join('\n');
    writeFileSync(join(tmpDir, 'plan.md'), planContent, 'utf8');
    const { ctx, state } = makeCtx([], {
      selectedGoal: 'Improve testing',
      phase: 'awaiting_plan_approval',
      planDocument: 'plan.md',
      planRefinementRound: 2,
    }, tmpDir);
    const { runApprove } = await import('../../tools/approve.js');

    const result = await runApprove(ctx, { cwd: tmpDir, action: 'start' });
    const structured = result.structuredContent as {
      phase: string;
      approvalTarget: string;
      data: { lineCount: number; sizeAssessment: string; planDocument: string; planRefinementRound: number };
    };

    expect(state.phase).toBe(structured.phase);
    expect(structured.approvalTarget).toBe('plan');
    expect(structured.data.lineCount).toBe(650);
    expect(structured.data.sizeAssessment).toBe('detailed');
    expect(structured.data.planDocument).toBe('plan.md');
    expect(structured.data.planRefinementRound).toBe(0);
    expect(result.content[0].text).toContain('Plan length: 650 lines.');
    expect(result.content[0].text).toContain('(read full plan from file)');
    expect(result.content[0].text).not.toContain(`line-649-${longLine}`);
  });

  it('returns structured unsupported-action errors for review and leaves state untouched', async () => {
    const bead = makeBead();
    const { ctx, state, saved } = makeCtx([
      {
        cmd: 'br',
        args: ['show', bead.id, '--json'],
        result: { code: 0, stdout: JSON.stringify(bead), stderr: '' },
      },
    ], {
      selectedGoal: 'test goal',
      phase: 'reviewing',
      activeBeadIds: [bead.id],
      currentBeadId: bead.id,
      beadResults: {},
      beadReviewPassCounts: {},
    });

    const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: bead.id, action: 'ship-it' as never });

    expect(result.isError).toBe(true);
    expect(state.phase).toBe('reviewing');
    expect(saved).toHaveLength(0);
    expect(result.structuredContent).toEqual({
      tool: 'flywheel_review',
      version: 1,
      status: 'error',
      phase: 'reviewing',
      data: {
        kind: 'error',
        error: {
          code: 'unsupported_action',
          message: 'Unknown action: ship-it. Valid: hit-me, looks-good, skip',
          details: {
            beadId: bead.id,
            action: 'ship-it',
          },
        },
      },
    });
    expect(result.content[0].text).toContain('Unknown action: ship-it');
  });

  it('keeps review hit-me task payloads coherent with saved state and extracted files', async () => {
    const bead = makeBead({
      description: 'Implement feature X.\n\n`src/feature.ts`\n`src/feature.test.ts`',
    });
    const { ctx, state, saved } = makeCtx([
      {
        cmd: 'br',
        args: ['show', bead.id, '--json'],
        result: { code: 0, stdout: JSON.stringify(bead), stderr: '' },
      },
    ], {
      selectedGoal: 'test goal',
      phase: 'reviewing',
      activeBeadIds: [bead.id],
      currentBeadId: bead.id,
      beadResults: { prior: { beadId: 'prior', status: 'success', summary: 'done' } },
      beadReviewPassCounts: { [bead.id]: 2 },
    });

    const result = await runReview(ctx, { cwd: '/fake/cwd', beadId: bead.id, action: 'hit-me' });
    const structured = result.structuredContent as {
      phase: string;
      data: {
        beadId: string;
        round: number;
        files: string[];
        agentTasks: Array<{ name: string; perspective: string; task: string }>;
      };
    };

    expect(state.phase).toBe(structured.phase);
    expect(state.beadHitMeTriggered?.[bead.id]).toBe(true);
    expect(state.beadHitMeCompleted?.[bead.id]).toBe(false);
    expect(saved.at(-1)?.beadHitMeTriggered?.[bead.id]).toBe(true);
    expect(structured.data.beadId).toBe(bead.id);
    expect(structured.data.round).toBe(2);
    expect(structured.data.files).toEqual(['src/feature.ts', 'src/feature.test.ts']);
    expect(structured.data.agentTasks).toHaveLength(5);
    expect(structured.data.agentTasks[0].name).toContain(`${bead.id}-r2`);
    expect(result.content[0].text).toContain('spawn-agents');
    expect(result.content[0].text).toContain('FreshEyes');
    expect(result.content[0].text).toContain('src/feature.ts');
  });
});
