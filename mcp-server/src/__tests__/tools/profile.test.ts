import { describe, it, expect, vi } from 'vitest';
import { runProfile } from '../../tools/profile.js';
import { createMockExec, makeState } from '../helpers/mocks.js';
import type { OrchestratorState } from '../../types.js';

// ─── Helpers ──────────────────────────────────────────────────

/** Minimal exec mocks for a successful profile run. */
function baseExecCalls() {
  return [
    { cmd: 'git', args: ['remote', 'get-url', 'origin'], result: { code: 0, stdout: 'https://github.com/org/myrepo.git', stderr: '' } },
    { cmd: 'git', args: ['log', '--oneline', '--format=%H|%s|%ai|%an', '-20'], result: { code: 0, stdout: 'abc1234|feat: add foo|2024-01-01|Alice\ndef5678|fix: bar bug|2024-01-02|Bob\n', stderr: '' } },
    { cmd: 'find', args: ['.', '-maxdepth', '3', '-not', '-path', './.git/*', '-not', '-path', './node_modules/*', '-not', '-path', './.claude-orchestrator/*'], result: { code: 0, stdout: './src/index.ts\n./src/utils.ts\n./package.json\n./README.md\n', stderr: '' } },
    // Key file cats — most return "not found" (code 1 via default mock)
    { cmd: 'cat', args: ['package.json'], result: { code: 0, stdout: JSON.stringify({ name: 'myrepo', devDependencies: { vitest: '^1.0.0' } }), stderr: '' } },
    { cmd: 'cat', args: ['README.md'], result: { code: 0, stdout: '# My Repo', stderr: '' } },
    // br CLI
    { cmd: 'br', args: ['--version'], result: { code: 0, stdout: 'br 0.5.0', stderr: '' } },
    { cmd: 'br', args: ['list', '--json'], result: { code: 0, stdout: JSON.stringify([{ status: 'open', id: 'b1', title: 'open bead' }]), stderr: '' } },
    // CI detection
    { cmd: 'ls', args: ['.github/workflows'], result: { code: 1, stdout: '', stderr: 'no such file' } },
    // Docs detection
    { cmd: 'ls', args: ['docs'], result: { code: 1, stdout: '', stderr: 'no such file' } },
    // TODOs
    { cmd: 'grep', args: ['-rn', '--include=*.ts', '--include=*.js', '--include=*.py', '--include=*.go', '--include=*.rs', '-E', 'TODO|FIXME|HACK|XXX', '.', '--exclude-dir=node_modules', '--exclude-dir=.git'], result: { code: 1, stdout: '', stderr: '' } },
  ];
}

function makeCtx(execCalls = baseExecCalls(), stateOverrides: Partial<OrchestratorState> = {}) {
  const exec = createMockExec(execCalls);
  const state = makeState(stateOverrides);
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

describe('runProfile', () => {
  it('transitions phase from idle to discovering', async () => {
    const { ctx, state } = makeCtx();
    expect(state.phase).toBe('idle');

    await runProfile(ctx, { cwd: '/fake/cwd' });

    expect(state.phase).toBe('discovering');
  });

  it('sets state.repoProfile with detected repo name', async () => {
    const { ctx, state } = makeCtx();

    await runProfile(ctx, { cwd: '/fake/cwd' });

    expect(state.repoProfile).toBeDefined();
    expect(state.repoProfile!.name).toBe('myrepo');
  });

  it('detects TypeScript from .ts file extensions in find output', async () => {
    const { ctx, state } = makeCtx();

    await runProfile(ctx, { cwd: '/fake/cwd' });

    expect(state.repoProfile!.languages).toContain('TypeScript');
  });

  it('sets hasTests=true when package.json contains vitest', async () => {
    const { ctx, state } = makeCtx();

    await runProfile(ctx, { cwd: '/fake/cwd' });

    expect(state.repoProfile!.hasTests).toBe(true);
    expect(state.repoProfile!.testFramework).toBe('vitest');
  });

  it('sets hasCI=true when .github/workflows ls succeeds', async () => {
    const calls = baseExecCalls().map(c => {
      if (c.cmd === 'ls' && c.args[0] === '.github/workflows') {
        return { ...c, result: { code: 0, stdout: 'ci.yml\n', stderr: '' } };
      }
      return c;
    });
    const { ctx, state } = makeCtx(calls);

    await runProfile(ctx, { cwd: '/fake/cwd' });

    expect(state.repoProfile!.hasCI).toBe(true);
    expect(state.repoProfile!.ciPlatform).toBe('GitHub Actions');
  });

  it('calls saveState with updated state', async () => {
    const { ctx, saved } = makeCtx();

    await runProfile(ctx, { cwd: '/fake/cwd' });

    expect(saved.length).toBe(1);
    expect(saved[0].phase).toBe('discovering');
    expect(saved[0].repoProfile).toBeDefined();
  });

  it('sets state.selectedGoal when goal arg provided', async () => {
    const { ctx, state } = makeCtx();

    await runProfile(ctx, { cwd: '/fake/cwd', goal: 'Add rate limiting' });

    expect(state.selectedGoal).toBe('Add rate limiting');
  });

  it('does not set selectedGoal when goal arg is absent', async () => {
    const { ctx, state } = makeCtx();

    await runProfile(ctx, { cwd: '/fake/cwd' });

    expect(state.selectedGoal).toBeUndefined();
  });

  it('shows foundation gap warning when no AGENTS.md in keyFiles', async () => {
    const { ctx } = makeCtx();

    const result = await runProfile(ctx, { cwd: '/fake/cwd' });

    expect(result.content[0].text).toContain('No AGENTS.md found');
  });

  it('does not show AGENTS.md gap when AGENTS.md is present', async () => {
    const calls = [
      ...baseExecCalls(),
      { cmd: 'cat', args: ['AGENTS.md'], result: { code: 0, stdout: '# Agent Guidance', stderr: '' } },
    ];
    const { ctx } = makeCtx(calls);

    const result = await runProfile(ctx, { cwd: '/fake/cwd' });

    expect(result.content[0].text).not.toContain('No AGENTS.md found');
  });

  it('falls back to dirname when git remote fails', async () => {
    const calls = baseExecCalls().map(c => {
      if (c.cmd === 'git' && c.args[0] === 'remote') {
        return { ...c, result: { code: 1, stdout: '', stderr: 'fatal: no remote' } };
      }
      return c;
    });
    const { ctx, state } = makeCtx(calls);
    ctx.cwd = '/projects/my-cool-project';

    await runProfile(ctx, { cwd: '/projects/my-cool-project' });

    expect(state.repoProfile!.name).toBe('my-cool-project');
  });

  it('parses git log output into recentCommits', async () => {
    const { ctx, state } = makeCtx();

    await runProfile(ctx, { cwd: '/fake/cwd' });

    expect(state.repoProfile!.recentCommits).toHaveLength(2);
    expect(state.repoProfile!.recentCommits[0]).toEqual({
      hash: 'abc1234',
      message: 'feat: add foo',
      date: '2024-01-01',
      author: 'Alice',
    });
    expect(state.repoProfile!.recentCommits[1]).toEqual({
      hash: 'def5678',
      message: 'fix: bar bug',
      date: '2024-01-02',
      author: 'Bob',
    });
  });

  it('detects beads coordination when br --version succeeds', async () => {
    const { ctx, state } = makeCtx();

    await runProfile(ctx, { cwd: '/fake/cwd' });

    expect(state.coordinationBackend?.beads).toBe(true);
    expect(state.coordinationStrategy).toBe('beads');
  });

  it('sets coordination to bare when br --version fails', async () => {
    const calls = baseExecCalls().map(c => {
      if (c.cmd === 'br' && c.args[0] === '--version') {
        return { ...c, result: { code: 1, stdout: '', stderr: 'not found' } };
      }
      return c;
    });
    const { ctx, state } = makeCtx(calls);

    await runProfile(ctx, { cwd: '/fake/cwd' });

    expect(state.coordinationBackend?.beads).toBe(false);
    expect(state.coordinationStrategy).toBe('bare');
  });

  it('returns text with profile info and workflow roadmap', async () => {
    const { ctx } = makeCtx();

    const result = await runProfile(ctx, { cwd: '/fake/cwd' });

    const text = result.content[0].text;
    expect(text).toContain('profile');
    expect(text).toContain('discover');
    expect(text).toContain('Workflow');
    expect(text).toContain('myrepo');
  });

  it('includes goal section in output when goal provided', async () => {
    const { ctx } = makeCtx();

    const result = await runProfile(ctx, { cwd: '/fake/cwd', goal: 'Improve test coverage' });

    expect(result.content[0].text).toContain('Improve test coverage');
    expect(result.content[0].text).toContain('orch_select');
  });

  it('includes bead status when beads are open', async () => {
    const { ctx } = makeCtx();

    const result = await runProfile(ctx, { cwd: '/fake/cwd' });

    expect(result.content[0].text).toContain('Existing Beads');
    expect(result.content[0].text).toContain('1 open/in-progress');
  });

  it('detects hasDocs when docs directory exists', async () => {
    const calls = baseExecCalls().map(c => {
      if (c.cmd === 'ls' && c.args[0] === 'docs') {
        return { ...c, result: { code: 0, stdout: 'guide.md\n', stderr: '' } };
      }
      return c;
    });
    const { ctx, state } = makeCtx(calls);

    await runProfile(ctx, { cwd: '/fake/cwd' });

    expect(state.repoProfile!.hasDocs).toBe(true);
  });

  it('reports no test framework gap when package.json has no test deps', async () => {
    const calls = baseExecCalls().map(c => {
      if (c.cmd === 'cat' && c.args[0] === 'package.json') {
        return { ...c, result: { code: 0, stdout: JSON.stringify({ name: 'bare', dependencies: {} }), stderr: '' } };
      }
      return c;
    });
    const { ctx } = makeCtx(calls);

    const result = await runProfile(ctx, { cwd: '/fake/cwd' });

    expect(result.content[0].text).toContain('No test framework detected');
  });
});
