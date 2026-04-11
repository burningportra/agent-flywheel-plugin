import { describe, it, expect, vi } from 'vitest';
import { runDiscover } from '../../tools/discover.js';
import { createMockExec, makeState } from '../helpers/mocks.js';
import type { OrchestratorState, CandidateIdea, RepoProfile } from '../../types.js';

// ─── Helpers ──────────────────────────────────────────────────

function makeRepoProfile(overrides: Partial<RepoProfile> = {}): RepoProfile {
  return {
    name: 'myrepo',
    languages: ['TypeScript'],
    frameworks: [],
    structure: '',
    entrypoints: [],
    recentCommits: [],
    hasTests: true,
    hasDocs: false,
    hasCI: false,
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

function makeCtx(stateOverrides: Partial<OrchestratorState> = {}) {
  const exec = createMockExec();
  const state = makeState({ repoProfile: makeRepoProfile(), ...stateOverrides });
  const saved: OrchestratorState[] = [];
  const ctx = {
    exec,
    cwd: '/fake/cwd',
    state,
    saveState: (s: OrchestratorState) => { saved.push(structuredClone(s)); },
    clearState: () => {},
  };
  return { ctx, state, saved };
}

// ─── Tests ────────────────────────────────────────────────────

describe('runDiscover', () => {
  it('stores candidateIdeas on state', async () => {
    const { ctx, state } = makeCtx();
    const ideas = [makeIdea(), makeIdea({ id: 'idea-2', title: 'Add logging' })];

    await runDiscover(ctx, { cwd: '/fake/cwd', ideas });

    expect(state.candidateIdeas).toHaveLength(2);
    expect(state.candidateIdeas![0].title).toBe('Add rate limiting');
    expect(state.candidateIdeas![1].title).toBe('Add logging');
  });

  it('transitions phase to awaiting_selection', async () => {
    const { ctx, state } = makeCtx();

    await runDiscover(ctx, { cwd: '/fake/cwd', ideas: [makeIdea()] });

    expect(state.phase).toBe('awaiting_selection');
  });

  it('calls saveState with updated state', async () => {
    const { ctx, saved } = makeCtx();

    await runDiscover(ctx, { cwd: '/fake/cwd', ideas: [makeIdea()] });

    expect(saved.length).toBe(1);
    expect(saved[0].candidateIdeas).toHaveLength(1);
    expect(saved[0].phase).toBe('awaiting_selection');
  });

  it('returns the idea list in response text', async () => {
    const { ctx } = makeCtx();
    const ideas = [
      makeIdea({ title: 'Rate limiting', tier: 'top' }),
      makeIdea({ id: 'idea-2', title: 'Better logging', tier: 'honorable' }),
    ];

    const result = await runDiscover(ctx, { cwd: '/fake/cwd', ideas });

    const text = result.content[0].text;
    expect(text).toContain('Rate limiting');
    expect(text).toContain('Better logging');
    expect(text).toContain('orch_select');
  });

  it('includes idea count summary in output', async () => {
    const { ctx } = makeCtx();
    const ideas = [
      makeIdea({ tier: 'top' }),
      makeIdea({ id: 'idea-2', tier: 'top' }),
      makeIdea({ id: 'idea-3', tier: 'honorable' }),
    ];

    const result = await runDiscover(ctx, { cwd: '/fake/cwd', ideas });

    const text = result.content[0].text;
    expect(text).toContain('3 ideas');
    expect(text).toContain('2 top');
    expect(text).toContain('1 honorable');
  });

  it('includes scores in output when ideas have scores', async () => {
    const { ctx } = makeCtx();
    const ideas = [makeIdea({
      scores: { useful: 5, pragmatic: 4, accretive: 3, robust: 4, ergonomic: 3 },
    })];

    const result = await runDiscover(ctx, { cwd: '/fake/cwd', ideas });

    const text = result.content[0].text;
    expect(text).toContain('Score:');
    expect(text).toContain('/37.5');
  });

  it('includes rationale in output when provided', async () => {
    const { ctx } = makeCtx();
    const ideas = [makeIdea({ rationale: 'High traffic endpoints need protection' })];

    const result = await runDiscover(ctx, { cwd: '/fake/cwd', ideas });

    expect(result.content[0].text).toContain('High traffic endpoints need protection');
  });

  it('returns error when no repo profile exists', async () => {
    const { ctx } = makeCtx({ repoProfile: undefined } as any);
    // Clear the repoProfile that was set by default
    ctx.state.repoProfile = undefined;

    const result = await runDiscover(ctx, { cwd: '/fake/cwd', ideas: [makeIdea()] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No repo profile');
  });

  it('returns error when ideas array is empty', async () => {
    const { ctx } = makeCtx();

    const result = await runDiscover(ctx, { cwd: '/fake/cwd', ideas: [] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No ideas provided');
  });

  it('does not mutate state on error', async () => {
    const { ctx, state } = makeCtx();
    const originalPhase = state.phase;

    await runDiscover(ctx, { cwd: '/fake/cwd', ideas: [] });

    expect(state.phase).toBe(originalPhase);
    expect(state.candidateIdeas).toBeUndefined();
  });

  it('returns structuredContent for successful idea registration', async () => {
    const { ctx } = makeCtx();
    const ideas = [
      makeIdea({ id: 'idea-1', tier: 'top' }),
      makeIdea({ id: 'idea-2', title: 'Better logging', tier: 'honorable' }),
    ];

    const result = await runDiscover(ctx, { cwd: '/fake/cwd', ideas });

    expect(result.structuredContent).toEqual({
      tool: 'orch_discover',
      version: 1,
      status: 'ok',
      phase: 'awaiting_selection',
      nextStep: {
        type: 'call_tool',
        message: 'Present the ideas to the user, then call orch_select with the chosen goal.',
        tool: 'orch_select',
        argsSchemaHint: { goal: 'string' },
      },
      data: {
        kind: 'ideas_registered',
        totalIdeas: 2,
        topIdeas: 1,
        honorableIdeas: 1,
        ideaIds: ['idea-1', 'idea-2'],
        ideas: [
          {
            id: 'idea-1',
            title: 'Add rate limiting',
            category: 'feature',
            effort: 'medium',
            impact: 'high',
            tier: 'top',
            rationale: 'High traffic endpoints need protection',
          },
          {
            id: 'idea-2',
            title: 'Better logging',
            category: 'feature',
            effort: 'medium',
            impact: 'high',
            tier: 'honorable',
            rationale: 'High traffic endpoints need protection',
          },
        ],
      },
    });
  });

  it('returns structuredContent for discover prerequisite errors', async () => {
    const { ctx } = makeCtx({ repoProfile: undefined } as any);
    ctx.state.repoProfile = undefined;

    const result = await runDiscover(ctx, { cwd: '/fake/cwd', ideas: [makeIdea()] });

    expect(result.structuredContent).toEqual({
      tool: 'orch_discover',
      version: 1,
      status: 'error',
      phase: 'idle',
      data: {
        kind: 'error',
        error: {
          code: 'missing_prerequisite',
          message: 'Error: No repo profile found. Call orch_profile first.',
        },
      },
    });
  });
});
