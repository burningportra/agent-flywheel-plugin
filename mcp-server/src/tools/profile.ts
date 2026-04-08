import type { ToolContext, McpToolResult, OrchestratorState, RepoProfile, ScanResult } from '../types.js';
import { formatRepoProfile } from './shared.js';

interface ProfileArgs {
  cwd: string;
  goal?: string;
}

/**
 * orch_profile — Scan the current repo and build a profile.
 *
 * Runs git log, finds key files, detects language/framework/CI/test tooling.
 * Detects the br CLI (beads) for coordination backend.
 * Returns a structured profile and discovery instructions.
 */
export async function runProfile(ctx: ToolContext, args: ProfileArgs): Promise<McpToolResult> {
  const { exec, cwd, state, saveState } = ctx;

  state.phase = 'profiling';

  // ── Collect repo signals ──────────────────────────────────────
  const profile = await buildRepoProfile(exec, cwd);

  // ── Detect coordination backends ──────────────────────────────
  const brResult = await exec('br', ['--version'], { cwd, timeout: 5000 });
  const hasBeads = brResult.code === 0;

  const coordinationBackend = {
    beads: hasBeads,
    agentMail: false, // agent-mail detection out of scope for MCP
    sophia: false,
  };
  const coordinationStrategy = hasBeads ? 'beads' : 'bare';

  state.repoProfile = profile;
  state.coordinationBackend = coordinationBackend;
  state.coordinationStrategy = coordinationStrategy as OrchestratorState['coordinationStrategy'];
  state.coordinationMode ??= 'worktree';
  if (args.goal) state.selectedGoal = args.goal;
  state.phase = 'discovering';
  saveState(state);

  // ── Foundation gaps ───────────────────────────────────────────
  const foundationGaps: string[] = [];
  const hasAgentsMd = profile.keyFiles && Object.keys(profile.keyFiles).some(f => f.toLowerCase().includes('agents.md'));
  if (!hasAgentsMd) foundationGaps.push('- No AGENTS.md found. Consider creating one for agent guidance.');
  if (!profile.hasTests) foundationGaps.push('- No test framework detected.');
  if (!profile.hasCI) foundationGaps.push('- No CI tooling detected.');
  if (profile.recentCommits.length === 0) foundationGaps.push('- No git history detected.');
  const foundationWarning = foundationGaps.length > 0
    ? `\n\n### Foundation Gaps\n${foundationGaps.join('\n')}`
    : '';

  // ── Beads status ──────────────────────────────────────────────
  let beadStatus = '';
  if (hasBeads) {
    const brListResult = await exec('br', ['list', '--json'], { cwd, timeout: 10000 });
    if (brListResult.code === 0) {
      try {
        const beads: any[] = JSON.parse(brListResult.stdout);
        const open = beads.filter((b: any) => b.status === 'open' || b.status === 'in_progress');
        const deferred = beads.filter((b: any) => b.status === 'deferred');
        if (open.length > 0 || deferred.length > 0) {
          beadStatus = `\n\n### Existing Beads\n- ${open.length} open/in-progress\n- ${deferred.length} deferred`;
          if (open.length > 0) {
            beadStatus += `\n\nTo work on existing beads, call \`orch_approve_beads\` with action="start".`;
          }
        }
      } catch { /* parse failure ok */ }
    }
  }

  const coordLine = hasBeads
    ? `Coordination: beads (br CLI detected)`
    : `Coordination: bare (no beads CLI detected — run \`br init\` to enable task tracking)`;

  const roadmap = `**Workflow:** profile → discover → select → plan → approve_beads → implement → review`;

  const goalSection = args.goal
    ? `\n\n### Goal\n${args.goal}\n\nSince a goal was provided, you can skip discovery and call \`orch_select\` directly with this goal, or call \`orch_discover\` to generate alternatives.`
    : `\n\n### Next Step\nCall \`orch_discover\` with 5-15 project ideas based on this profile.`;

  const formatted = formatRepoProfile(profile);

  const text = `${roadmap}\n\n${coordLine}${foundationWarning}${beadStatus}${goalSection}\n\n---\n\n${formatted}`;

  return { content: [{ type: 'text', text }] };
}

// ─── Repo scanning ────────────────────────────────────────────

async function buildRepoProfile(
  exec: ToolContext['exec'],
  cwd: string
): Promise<RepoProfile> {
  const profile: RepoProfile = {
    name: '',
    languages: [],
    frameworks: [],
    structure: '',
    entrypoints: [],
    recentCommits: [],
    hasTests: false,
    hasDocs: false,
    hasCI: false,
    todos: [],
    keyFiles: {},
  };

  // Name from git remote or directory
  const remoteResult = await exec('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 5000 });
  if (remoteResult.code === 0) {
    const url = remoteResult.stdout.trim();
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    if (match) profile.name = match[1];
  }
  if (!profile.name) {
    const parts = cwd.split('/');
    profile.name = parts[parts.length - 1] || 'project';
  }

  // Recent commits
  const gitLogResult = await exec(
    'git', ['log', '--oneline', '--format=%H|%s|%ai|%an', '-20'],
    { cwd, timeout: 10000 }
  );
  if (gitLogResult.code === 0) {
    for (const line of gitLogResult.stdout.trim().split('\n').filter(Boolean)) {
      const [hash, message, date, author] = line.split('|');
      if (hash && message) {
        profile.recentCommits.push({ hash: hash.slice(0, 7), message, date: date || '', author: author || '' });
      }
    }
  }

  // File structure
  const findResult = await exec(
    'find', ['.', '-maxdepth', '3', '-not', '-path', './.git/*', '-not', '-path', './node_modules/*', '-not', '-path', './.claude-orchestrator/*'],
    { cwd, timeout: 10000 }
  );
  if (findResult.code === 0) {
    profile.structure = findResult.stdout.slice(0, 3000);
  }

  // Language detection from file extensions
  const extensions: Record<string, number> = {};
  for (const line of (findResult.stdout || '').split('\n')) {
    const match = line.match(/\.([a-z]+)$/);
    if (match) extensions[match[1]] = (extensions[match[1]] || 0) + 1;
  }
  const langMap: Record<string, string> = {
    ts: 'TypeScript', js: 'JavaScript', py: 'Python', rs: 'Rust',
    go: 'Go', java: 'Java', rb: 'Ruby', cs: 'C#', cpp: 'C++', c: 'C',
    swift: 'Swift', kt: 'Kotlin', php: 'PHP',
  };
  profile.languages = Object.entries(extensions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ext]) => langMap[ext])
    .filter(Boolean) as string[];

  // Framework detection from key files
  const keyFileNames = [
    'package.json', 'Cargo.toml', 'go.mod', 'requirements.txt', 'pyproject.toml',
    'CLAUDE.md', 'AGENTS.md', 'README.md', 'README',
    '.github/workflows', 'Makefile', 'Dockerfile', 'docker-compose.yml',
  ];
  for (const name of keyFileNames) {
    const catResult = await exec('cat', [name], { cwd, timeout: 3000 });
    if (catResult.code === 0 && catResult.stdout.trim()) {
      profile.keyFiles[name] = catResult.stdout.slice(0, 500);
    }
  }

  // Package manager detection
  if (profile.keyFiles['package.json']) {
    profile.packageManager = 'npm';
    const pkg = tryParse(profile.keyFiles['package.json']);
    if (pkg) {
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['next']) profile.frameworks.push('Next.js');
      if (deps['react']) profile.frameworks.push('React');
      if (deps['vue']) profile.frameworks.push('Vue');
      if (deps['express']) profile.frameworks.push('Express');
      if (deps['fastify']) profile.frameworks.push('Fastify');
      if (deps['jest'] || deps['vitest'] || deps['mocha']) {
        profile.hasTests = true;
        profile.testFramework = deps['jest'] ? 'jest' : deps['vitest'] ? 'vitest' : 'mocha';
      }
    }
  }

  // CI detection
  if (profile.keyFiles['.github/workflows']) {
    profile.hasCI = true;
    profile.ciPlatform = 'GitHub Actions';
  }
  const lsResult = await exec('ls', ['.github/workflows'], { cwd, timeout: 3000 });
  if (lsResult.code === 0 && lsResult.stdout.trim()) {
    profile.hasCI = true;
    profile.ciPlatform = 'GitHub Actions';
  }

  // Docs detection
  const docsResult = await exec('ls', ['docs'], { cwd, timeout: 3000 });
  if (docsResult.code === 0) profile.hasDocs = true;

  // TODOs
  const todoResult = await exec(
    'grep', ['-rn', '--include=*.ts', '--include=*.js', '--include=*.py', '--include=*.go', '--include=*.rs',
              '-E', 'TODO|FIXME|HACK|XXX', '.', '--exclude-dir=node_modules', '--exclude-dir=.git'],
    { cwd, timeout: 10000 }
  );
  if (todoResult.code === 0) {
    for (const line of todoResult.stdout.split('\n').slice(0, 20)) {
      const match = line.match(/^(.+):(\d+):.*(TODO|FIXME|HACK|XXX)[:\s]+(.+)$/);
      if (match) {
        profile.todos.push({
          file: match[1],
          line: parseInt(match[2], 10),
          text: match[4].trim().slice(0, 100),
          type: match[3] as 'TODO' | 'FIXME' | 'HACK' | 'XXX',
        });
      }
    }
  }

  return profile;
}

function tryParse(json: string): any {
  try { return JSON.parse(json); } catch { return null; }
}
