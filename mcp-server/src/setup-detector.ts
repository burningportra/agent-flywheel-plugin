/**
 * T3.1 (v3.16.0 noob-onboarding) — parallel pre-flight detector for
 * `/flywheel-setup`. Replaces the prior per-tool sequential probe with
 * a single `Promise.all` sweep that returns a structured `InstallPlan`
 * partitioned into five buckets the skill body can present in a single
 * AskUserQuestion prompt.
 *
 * Pure, read-only, no mutations. Default check implementations rely on
 * shell-level binaries (`command -v <name>`), a HEAD request against
 * agent-mail's `/health/liveness`, parsing `ntm config show`, and a
 * filesystem read of `~/.claude.json`. Every probe is injectable for
 * tests via the `Probes` parameter — tests bypass the OS by passing
 * deterministic implementations.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';

export type InstallPlan = {
  install: string[];
  register: string[];
  start: string[];
  configure: string[];
  skip: string[];
};

/**
 * Names of the ACFS-stack CLIs the flywheel detects. Order is preserved
 * in the resulting `install` / `skip` buckets so the skill can render a
 * stable list to the user.
 */
export const REQUIRED_CLIS = ['br', 'bv', 'cm', 'dcg', 'ntm'] as const;
export type RequiredCli = (typeof REQUIRED_CLIS)[number];

export type Probes = {
  hasCli: (bin: RequiredCli) => Promise<boolean>;
  isAgentMailAlive: () => Promise<boolean>;
  isMcpRegistered: () => Promise<boolean>;
  getNtmBase: () => Promise<string | null>;
};

const DEFAULT_PROBES: Probes = {
  hasCli: defaultHasCli,
  isAgentMailAlive: defaultIsAgentMailAlive,
  isMcpRegistered: defaultIsMcpRegistered,
  getNtmBase: defaultGetNtmBase,
};

export async function detectInstallState(
  opts: { cwd: string; probes?: Partial<Probes> },
): Promise<InstallPlan> {
  const probes: Probes = { ...DEFAULT_PROBES, ...(opts.probes ?? {}) };

  const cliChecks = REQUIRED_CLIS.map((cli) => probes.hasCli(cli));
  const [cliResults, agentMailOk, mcpRegistered, ntmBase] = await Promise.all([
    Promise.all(cliChecks),
    probes.isAgentMailAlive(),
    probes.isMcpRegistered(),
    probes.getNtmBase(),
  ]);

  const plan: InstallPlan = {
    install: [],
    register: [],
    start: [],
    configure: [],
    skip: [],
  };

  REQUIRED_CLIS.forEach((cli, idx) => {
    (cliResults[idx] ? plan.skip : plan.install).push(cli);
  });

  if (!agentMailOk) plan.start.push('agent-mail HTTP');
  else plan.skip.push('agent-mail HTTP');

  if (!mcpRegistered) plan.register.push('agent-flywheel MCP server');
  else plan.skip.push('agent-flywheel MCP server');

  if (ntmBase) {
    const expected = path.join(ntmBase, path.basename(opts.cwd));
    if (!existsSync(expected)) {
      plan.configure.push(`projects_base symlink: ${expected}`);
    } else {
      plan.skip.push(`projects_base symlink: ${expected}`);
    }
  }

  return plan;
}

async function defaultHasCli(bin: RequiredCli): Promise<boolean> {
  try {
    execSync(`command -v ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function defaultIsAgentMailAlive(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: 8765,
        path: '/health/liveness',
        method: 'GET',
        timeout: 1500,
      },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 500);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function defaultIsMcpRegistered(): Promise<boolean> {
  const candidates = [
    path.join(os.homedir(), '.claude.json'),
    path.join(os.homedir(), '.config', 'claude', 'config.json'),
  ];
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const raw = readFileSync(file, 'utf8');
      if (/agent-flywheel/.test(raw)) return true;
    } catch {
      /* fall through */
    }
  }
  return false;
}

async function defaultGetNtmBase(): Promise<string | null> {
  try {
    const out = execSync('ntm config show', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    const match = out.match(/projects_base\s*[=:]\s*"?([^"\n]+)"?/);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}
