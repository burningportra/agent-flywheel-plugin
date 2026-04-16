import { describe, it, expect } from 'vitest';
import { runProfile } from '../../tools/profile.js';
import { createMockExec, makeState } from '../helpers/mocks.js';
// ─── Helpers ──────────────────────────────────────────────────
/**
 * profileRepo uses:
 *   - find with -maxdepth 4 + many exclusions
 *   - git log --no-decorate -n 20 --format=%H\0%s\0%ai\0%an
 *   - grep for TODOs
 *   - head -c 4096 <file> for key files
 *
 * The repo name comes from cwd.split("/").pop().
 */
function makeFindArgs(stdout) {
    return {
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
        result: { code: 0, stdout, stderr: '' },
    };
}
function makeGitLogArgs(stdout) {
    return {
        cmd: 'git',
        args: ['log', '--oneline', '--no-decorate', '-n', '20', '--format=%H%x00%s%x00%ai%x00%an'],
        result: { code: 0, stdout, stderr: '' },
    };
}
function makeHeadArgs(file, stdout) {
    return {
        cmd: 'head',
        args: ['-c', '4096', file],
        result: { code: 0, stdout, stderr: '' },
    };
}
function makeTodosArgs(stdout = '', code = 1) {
    return {
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
        result: { code, stdout, stderr: '' },
    };
}
// File tree with TypeScript files, test dir, docs dir, and .github/workflows
const BASE_FILE_TREE = './src/index.ts\n./src/utils.ts\n./src/__tests__/foo.test.ts\n./docs/guide.md\n./.github/workflows/ci.yml\n./package.json\n./README.md';
// git log with null-byte delimiters
const BASE_GIT_LOG = 'abc1234full\x00feat: add foo\x002024-01-01\x00Alice\ndef5678full\x00fix: bar bug\x002024-01-02\x00Bob\n';
const BASE_PACKAGE_JSON = JSON.stringify({
    name: 'myrepo',
    devDependencies: { vitest: '^1.0.0' },
});
/** Minimal exec mocks for a successful profile run using profileRepo patterns. */
function baseExecCalls() {
    return [
        // profileRepo collectors (run in parallel)
        makeFindArgs(BASE_FILE_TREE),
        makeGitLogArgs(BASE_GIT_LOG),
        makeTodosArgs('', 1),
        // Key files via head -c 4096
        makeHeadArgs('README.md', '# My Repo'),
        makeHeadArgs('CLAUDE.md', ''), // not present — default mock returns code:1 fine
        makeHeadArgs('AGENTS.md', ''), // not present
        makeHeadArgs('package.json', BASE_PACKAGE_JSON),
        makeHeadArgs('Cargo.toml', ''),
        makeHeadArgs('pyproject.toml', ''),
        makeHeadArgs('go.mod', ''),
        makeHeadArgs('Gemfile', ''),
        makeHeadArgs('Makefile', ''),
        makeHeadArgs('Dockerfile', ''),
        makeHeadArgs('docker-compose.yml', ''),
        makeHeadArgs('.github/workflows/ci.yml', 'name: CI'),
        makeHeadArgs('.github/workflows/ci.yaml', ''),
        makeHeadArgs('.gitlab-ci.yml', ''),
        makeHeadArgs('tsconfig.json', ''),
        makeHeadArgs('vite.config.ts', ''),
        makeHeadArgs('webpack.config.js', ''),
        makeHeadArgs('jest.config.ts', ''),
        makeHeadArgs('jest.config.js', ''),
        makeHeadArgs('vitest.config.ts', ''),
        makeHeadArgs('.eslintrc.json', ''),
        makeHeadArgs('.prettierrc', ''),
        makeHeadArgs('README', ''),
        // bestPracticesGuides
        makeHeadArgs('BEST_PRACTICES.md', ''),
        makeHeadArgs('docs/best-practices.md', ''),
        makeHeadArgs('docs/BEST_PRACTICES.md', ''),
        makeHeadArgs('best_practices.md', ''),
        makeHeadArgs('CONTRIBUTING.md', ''),
        makeHeadArgs('ARCHITECTURE.md', ''),
        makeHeadArgs('docs/architecture.md', ''),
        // br CLI
        { cmd: 'br', args: ['--version'], result: { code: 0, stdout: 'br 0.5.0', stderr: '' } },
        { cmd: 'br', args: ['list', '--json'], result: { code: 0, stdout: JSON.stringify([{ status: 'open', id: 'b1', title: 'open bead', description: 'Test bead', priority: 2, type: 'task', labels: [] }]), stderr: '' } },
    ];
}
function makeCtx(execCalls = baseExecCalls(), stateOverrides = {}) {
    const exec = createMockExec(execCalls);
    const state = makeState(stateOverrides);
    const saved = [];
    const ctx = {
        exec,
        cwd: '/fake/cwd',
        state,
        saveState: (s) => { saved.push(structuredClone(s)); },
        clearState: () => { },
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
        // profileRepo derives name from cwd.split("/").pop()
        ctx.cwd = '/projects/myrepo';
        await runProfile(ctx, { cwd: '/projects/myrepo' });
        expect(state.repoProfile).toBeDefined();
        expect(state.repoProfile.name).toBe('myrepo');
    });
    it('detects TypeScript from .ts file extensions in find output', async () => {
        const { ctx, state } = makeCtx();
        await runProfile(ctx, { cwd: '/fake/cwd' });
        expect(state.repoProfile.languages).toContain('TypeScript');
    });
    it('sets hasTests=true when file tree contains test directory', async () => {
        const { ctx, state } = makeCtx();
        // BASE_FILE_TREE includes ./src/__tests__/foo.test.ts
        await runProfile(ctx, { cwd: '/fake/cwd' });
        expect(state.repoProfile.hasTests).toBe(true);
    });
    it('detects vitest as testFramework when vitest.config.ts present', async () => {
        const calls = baseExecCalls().map(c => {
            if (c.cmd === 'head' && c.args[2] === 'vitest.config.ts') {
                return { ...c, result: { code: 0, stdout: 'export default {}', stderr: '' } };
            }
            return c;
        });
        const { ctx, state } = makeCtx(calls);
        await runProfile(ctx, { cwd: '/fake/cwd' });
        expect(state.repoProfile.testFramework).toBe('Vitest');
    });
    it('sets hasCI=true when .github/workflows appears in file tree', async () => {
        const { ctx, state } = makeCtx();
        // BASE_FILE_TREE includes .github/workflows/ci.yml
        await runProfile(ctx, { cwd: '/fake/cwd' });
        expect(state.repoProfile.hasCI).toBe(true);
        expect(state.repoProfile.ciPlatform).toBe('GitHub Actions');
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
        const calls = baseExecCalls().map(c => {
            if (c.cmd === 'head' && c.args[2] === 'AGENTS.md') {
                return { ...c, result: { code: 0, stdout: '# Agent Guidance', stderr: '' } };
            }
            return c;
        });
        const { ctx } = makeCtx(calls);
        const result = await runProfile(ctx, { cwd: '/fake/cwd' });
        expect(result.content[0].text).not.toContain('No AGENTS.md found');
    });
    it('falls back to dirname when cwd is the path', async () => {
        const { ctx, state } = makeCtx();
        ctx.cwd = '/projects/my-cool-project';
        await runProfile(ctx, { cwd: '/projects/my-cool-project' });
        expect(state.repoProfile.name).toBe('my-cool-project');
    });
    it('parses git log output into recentCommits', async () => {
        const { ctx, state } = makeCtx();
        await runProfile(ctx, { cwd: '/fake/cwd' });
        expect(state.repoProfile.recentCommits).toHaveLength(2);
        expect(state.repoProfile.recentCommits[0]).toEqual({
            hash: 'abc1234',
            message: 'feat: add foo',
            date: '2024-01-01',
            author: 'Alice',
        });
        expect(state.repoProfile.recentCommits[1]).toEqual({
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
        // Use a cwd that ends in 'myrepo' so name is 'myrepo'
        const calls = baseExecCalls();
        const exec = createMockExec(calls);
        const state = makeState();
        const ctx = {
            exec,
            cwd: '/projects/myrepo',
            state,
            saveState: (_s) => { },
            clearState: () => { },
        };
        const result = await runProfile(ctx, { cwd: '/projects/myrepo' });
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
        expect(result.content[0].text).toContain('flywheel_select');
    });
    it('includes bead status when beads are open', async () => {
        const { ctx } = makeCtx();
        const result = await runProfile(ctx, { cwd: '/fake/cwd' });
        expect(result.content[0].text).toContain('Existing Beads');
        expect(result.content[0].text).toContain('1 open/in-progress');
    });
    it('detects hasDocs when docs directory appears in file tree', async () => {
        const { ctx, state } = makeCtx();
        // BASE_FILE_TREE includes ./docs/guide.md which contains "docs/"
        await runProfile(ctx, { cwd: '/fake/cwd' });
        expect(state.repoProfile.hasDocs).toBe(true);
    });
    it('reports no test framework gap when package.json has no test deps', async () => {
        const noTestFileTree = './src/index.ts\n./package.json\n./README.md';
        const calls = baseExecCalls().map(c => {
            if (c.cmd === 'find') {
                return { ...c, result: { code: 0, stdout: noTestFileTree, stderr: '' } };
            }
            if (c.cmd === 'head' && c.args[2] === 'package.json') {
                return { ...c, result: { code: 0, stdout: JSON.stringify({ name: 'bare', dependencies: {} }), stderr: '' } };
            }
            return c;
        });
        const { ctx } = makeCtx(calls);
        const result = await runProfile(ctx, { cwd: '/fake/cwd' });
        expect(result.content[0].text).toContain('No test framework detected');
    });
    it('returns structuredContent for successful profile scans', async () => {
        const { ctx } = makeCtx();
        const result = await runProfile(ctx, { cwd: '/fake/cwd' });
        expect(result.structuredContent).toEqual({
            tool: 'flywheel_profile',
            version: 1,
            status: 'ok',
            phase: 'discovering',
            nextStep: {
                type: 'call_tool',
                message: 'Call flywheel_discover with candidate ideas based on the repo profile.',
                tool: 'flywheel_discover',
                argsSchemaHint: { ideas: 'CandidateIdea[]' },
            },
            data: {
                kind: 'profile_ready',
                fromCache: false,
                selectedGoal: undefined,
                coordination: {
                    backend: 'beads',
                    beadsAvailable: true,
                },
                foundationGaps: ['- No AGENTS.md found. Consider creating one for agent guidance.'],
                existingBeads: {
                    openCount: 1,
                    deferredCount: 0,
                },
                profileSummary: {
                    name: 'cwd',
                    languages: ['TypeScript'],
                    frameworks: [],
                    hasTests: true,
                    hasDocs: true,
                    hasCI: true,
                    testFramework: 'Vitest',
                    ciPlatform: 'GitHub Actions',
                    entrypoints: ['src/index.ts'],
                },
            },
        });
    });
    it('returns a choice-style nextStep when a goal is already provided', async () => {
        const { ctx } = makeCtx();
        const result = await runProfile(ctx, { cwd: '/fake/cwd', goal: 'Improve test coverage' });
        expect(result.structuredContent).toEqual({
            tool: 'flywheel_profile',
            version: 1,
            status: 'ok',
            phase: 'discovering',
            nextStep: {
                type: 'present_choices',
                message: 'A goal was provided. Either proceed directly to flywheel_select or run flywheel_discover to generate alternatives.',
                options: [
                    {
                        id: 'select-provided-goal',
                        label: 'Use the provided goal',
                        description: 'Skip discovery and continue with flywheel_select using the supplied goal.',
                        tool: 'flywheel_select',
                        args: { goal: 'Improve test coverage' },
                    },
                    {
                        id: 'discover-alternatives',
                        label: 'Discover alternatives',
                        description: 'Generate alternative goals with flywheel_discover before selecting one.',
                        tool: 'flywheel_discover',
                        args: { ideas: 'CandidateIdea[]' },
                    },
                ],
            },
            data: {
                kind: 'profile_ready',
                fromCache: false,
                selectedGoal: 'Improve test coverage',
                coordination: {
                    backend: 'beads',
                    beadsAvailable: true,
                },
                foundationGaps: ['- No AGENTS.md found. Consider creating one for agent guidance.'],
                existingBeads: {
                    openCount: 1,
                    deferredCount: 0,
                },
                profileSummary: {
                    name: 'cwd',
                    languages: ['TypeScript'],
                    frameworks: [],
                    hasTests: true,
                    hasDocs: true,
                    hasCI: true,
                    testFramework: 'Vitest',
                    ciPlatform: 'GitHub Actions',
                    entrypoints: ['src/index.ts'],
                },
            },
        });
    });
});
//# sourceMappingURL=profile.test.js.map