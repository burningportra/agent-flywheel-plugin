/**
 * Running a swarm on another Mac on the local network.
 *
 * The coordinator session, the plugin code, and the cycle state stay on this
 * Mac. The swarm's panes run in a clone on the worker, which this Mac reaches
 * over SSH; only third-party CLIs (ntm, tmux, pi, br, am, git) run there.
 * Ownership of the repo state alternates at wave boundaries:
 * {@link pushToSwarmHost} hands this checkout's commits and beads to the
 * worker before a wave, and {@link pullFromSwarmHost} brings the worker's
 * commits, bead changes, and completion reports back before the wave is
 * verified, so verification, review, and wrap-up keep reading this checkout.
 */

import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { cpus, homedir, loadavg, totalmem, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

import { writeAtomic } from './atomic-write.js';
import { errMsg } from './errors.js';
import type { ExecFn } from './exec.js';
import { userConfigPath } from './flywheel-config.js';
import { parseNtmProjectsBase } from './ntm-project.js';

export const SWARM_HOST_RELATIVE_PATH = join('.pi-flywheel', 'swarm-host.json');
/** The worker clone's branch. Its worktree tracks it through `receive.denyCurrentBranch=updateInstead`. */
export const SWARM_HOST_BRANCH = 'flywheel-offload';
export const THIS_MAC_LABEL = 'This Mac';

const SSH_OVERHEAD_MS = 8_000;
const SSH_RETRIES = 2;
const SSH_RETRY_DELAY_MS = 3_000;
/** ssh exits 255 for its own failures; these are the ones a retry can fix. */
const TRANSIENT_SSH = /timed out|Connection reset|Broken pipe|Connection closed|closed by remote|Network is unreachable|No route to host/i;
const GIT_TIMEOUT_MS = 180_000;
const KEEP_AWAKE_SECONDS = 12 * 60 * 60;
const REMOTE_PATH =
  'export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"';
/** Tools a worker needs before it can take a swarm. Lane CLIs are checked per lane. */
const REQUIRED_TOOLS = ['git', 'ntm', 'tmux', 'br', 'am', 'rsync'] as const;
const PROBED_TOOLS = [...REQUIRED_TOOLS, 'node', 'claude', 'pi', 'codex', 'caffeinate'] as const;
/**
 * Claude Code asks whether to trust a new folder and exits when nobody answers,
 * so a cc pane in a fresh clone dies at startup. This marks only that clone
 * trusted, with an atomic rewrite that refuses a file it can't parse.
 */
const TRUST_CLAUDE_FOLDER = `
const fs = require('fs'), os = require('os'), path = require('path');
const file = fs.realpathSync.native(path.join(os.homedir(), '.claude.json'));
const dir = process.argv[1];
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const entry = ((config.projects ??= {})[dir] ??= {});
if (entry.hasTrustDialogAccepted === true) { process.stdout.write('trusted'); process.exit(0); }
entry.hasTrustDialogAccepted = true;
const tmp = file + '.flywheel-' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: fs.statSync(file).mode });
fs.renameSync(tmp, file);
process.stdout.write('added');
`;

export const SwarmHostSchema = z.object({
  version: z.literal(1),
  /** Display name, e.g. "Kevin’s MacBook Air". */
  name: z.string().min(1),
  /** SSH hostname, e.g. "Kevins-MacBook-Air.local". */
  host: z.string().min(1),
  /** Last IPv4 address the hostname resolved to; used when mDNS drops the name. */
  address: z.string().nullable(),
  user: z.string().min(1),
  identityFile: z.string().nullable(),
  /** The worker clone, `<ntm projects_base>/<repo>-offload`. */
  repoPath: z.string().min(1),
  /** ntm resolves this project name to {@link repoPath} on the worker. */
  ntmProject: z.string().min(1),
  /** This checkout's branch; pulls merge into it. */
  localBranch: z.string().min(1),
  keepAwakePid: z.number().int().positive().nullable(),
  preparedAt: z.string(),
});
export type SwarmHost = z.infer<typeof SwarmHostSchema>;

export type SshTarget = Pick<SwarmHost, 'host' | 'address' | 'user' | 'identityFile'>;

const RememberedHostSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  address: z.string().nullable(),
  user: z.string().min(1),
  identityFile: z.string().nullable(),
});
const RememberedHostsSchema = z.object({
  version: z.literal(1),
  hosts: z.array(RememberedHostSchema),
});
export type HostCandidate = z.infer<typeof RememberedHostSchema>;

export interface MachineLoad {
  cores: number;
  memGB: number;
  load: number;
  onBattery: boolean;
  batteryPercent: number | null;
}

export type HostProbe =
  | (MachineLoad & {
    ok: true;
    candidate: HostCandidate;
    diskFreeGB: number | null;
    home: string;
    projectsBase: string | null;
    tools: Record<string, string | null>;
    missingTools: string[];
    agentMail: boolean;
  })
  | { ok: false; candidate: HostCandidate; reason: 'unreachable' | 'auth' | 'host_key' | 'failed'; detail: string };

export type SwarmSyncFailure = {
  ok: false;
  code: 'missing_prerequisite' | 'blocked_state' | 'cli_failure';
  reason: string;
  message: string;
  hint: string;
  details?: Record<string, unknown>;
};
export type SwarmSyncResult<T> = ({ ok: true } & T) | SwarmSyncFailure;

export interface PullSummary {
  commits: 'up_to_date' | 'fast_forward' | 'merged';
  head: string;
  beads: 'merged' | 'skipped';
  completionReports: 'copied' | 'none';
}

export interface PushSummary {
  head: string;
  beads: 'mirrored' | 'merged' | 'skipped';
}

/** How the coordinator reaches the swarm's lanes: this Mac, or the worker over SSH. */
export interface SwarmLane {
  host: SwarmHost | null;
  /** Runs lane commands (which, pi auth check, ntm, br) where the panes run. */
  exec: ExecFn;
  /** Agent Mail project key and pane working directory. */
  projectKey: string;
  /** Scopes the Pi route-probe cache to the machine whose logins it records. */
  probeScope?: string;
  /** Lane detection checks `claude auth status` where the panes run. */
  verifyClaudeLogin: boolean;
}

// ─── Record files ─────────────────────────────────────────────────────────

export async function readSwarmHost(cwd: string): Promise<SwarmHost | null> {
  try {
    const parsed = SwarmHostSchema.safeParse(JSON.parse(await readFile(join(cwd, SWARM_HOST_RELATIVE_PATH), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeSwarmHost(cwd: string, host: SwarmHost): Promise<void> {
  await writeAtomic(join(cwd, SWARM_HOST_RELATIVE_PATH), `${JSON.stringify(host, null, 2)}\n`);
}

export async function clearSwarmHost(cwd: string): Promise<void> {
  await rm(join(cwd, SWARM_HOST_RELATIVE_PATH), { force: true });
}

function rememberedHostsPath(): string {
  return join(dirname(userConfigPath()), 'swarm-hosts.json');
}

/** Hosts chosen before, so a host whose mDNS advertisement dropped still shows up. */
export async function readRememberedHosts(): Promise<HostCandidate[]> {
  try {
    const parsed = RememberedHostsSchema.safeParse(JSON.parse(await readFile(rememberedHostsPath(), 'utf8')));
    return parsed.success ? parsed.data.hosts : [];
  } catch {
    return [];
  }
}

export async function rememberHost(candidate: HostCandidate): Promise<void> {
  const others = (await readRememberedHosts()).filter((entry) => !sameHost(entry.host, candidate.host));
  const path = rememberedHostsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, `${JSON.stringify({ version: 1, hosts: [candidate, ...others] }, null, 2)}\n`);
}

function sameHost(a: string, b: string): boolean {
  return a.replace(/\.$/, '').toLowerCase() === b.replace(/\.$/, '').toLowerCase();
}

/** A ref- and filename-safe id for a host. */
export function hostSlug(host: string): string {
  return host.replace(/\.$/, '').toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
}

// ─── SSH ──────────────────────────────────────────────────────────────────

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Where to connect: an IPv4 address checked against the hostname's known_hosts key, or the hostname itself. */
interface Route {
  address: string;
  alias: string | null;
}

/**
 * Resolve the hostname now, falling back to the last address it had. mDNS
 * names drop out for seconds at a time while the machine stays reachable.
 */
export async function resolveRoute(
  target: SshTarget,
  resolve: (host: string) => Promise<string> = async (host) => (await lookup(host, { family: 4 })).address,
): Promise<Route & { resolved: string | null }> {
  const alias = target.host.toLowerCase();
  try {
    const address = await Promise.race([
      resolve(target.host),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('lookup timed out')), 3_000).unref()),
    ]);
    return { address, alias, resolved: address };
  } catch {
    return target.address
      ? { address: target.address, alias, resolved: null }
      : { address: target.host, alias: null, resolved: null };
  }
}

export function sshOptions(target: SshTarget, route: Route): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${join(homedir(), '.ssh', 'fw-%C')}`,
    '-o', 'ControlPersist=120',
    ...(target.identityFile ? ['-o', 'IdentitiesOnly=yes', '-i', target.identityFile] : []),
    ...(route.alias ? ['-o', `HostKeyAlias=${route.alias}`] : []),
  ];
}

/** The `ssh` command line git and rsync run, quoted for the shell they hand it to. */
function sshCommandLine(target: SshTarget, route: Route): string {
  return ['ssh', ...sshOptions(target, route)].map((part) => (/^[\w@%=./:-]+$/.test(part) ? part : shellQuote(part))).join(' ');
}

/** A shell script for the worker: its PATH, then `cd` into the clone when one is given. */
export function remoteScript(repoPath: string | null, body: string): string {
  return [REMOTE_PATH, ...(repoPath ? [`cd ${shellQuote(repoPath)}`] : []), body].join(' && ');
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

async function runSsh(
  local: ExecFn,
  target: SshTarget,
  route: Route,
  script: string,
  opts: { timeout?: number; signal?: AbortSignal },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const argv = [...sshOptions(target, route), `${target.user}@${route.address}`, script];
  for (let attempt = 0; ; attempt++) {
    const result = await local('ssh', argv, {
      timeout: (opts.timeout ?? 30_000) + SSH_OVERHEAD_MS,
      signal: opts.signal,
    });
    if (result.code !== 255 || attempt >= SSH_RETRIES || !TRANSIENT_SSH.test(result.stderr)) return result;
    await sleep(SSH_RETRY_DELAY_MS, opts.signal);
  }
}

/**
 * An {@link ExecFn} that runs each command on the worker, in `repoPath` when
 * one is given. `opts.cwd` is ignored: the worker has its own paths.
 */
export function makeSshExec(local: ExecFn, target: SshTarget, repoPath: string | null): ExecFn {
  let route: Promise<Route> | null = null;
  return async (cmd, args, opts = {}) => {
    route ??= resolveRoute(target);
    const script = remoteScript(repoPath, ['exec', cmd, ...args].map(shellQuote).join(' '));
    return runSsh(local, target, await route, script, { timeout: opts.timeout, signal: opts.signal });
  };
}

/** Run a shell script on the worker. */
async function remoteShell(
  local: ExecFn,
  target: SshTarget,
  route: Route,
  repoPath: string | null,
  body: string,
  opts: { timeout?: number; signal?: AbortSignal } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runSsh(local, target, route, remoteScript(repoPath, body), opts);
}

/**
 * How lane commands reach the panes. With no swarm host recorded, they run
 * here and the project key is this checkout.
 */
export async function resolveSwarmLane(cwd: string, exec: ExecFn): Promise<SwarmLane> {
  const host = await readSwarmHost(cwd);
  if (!host) return { host: null, exec, projectKey: cwd, verifyClaudeLogin: false };
  return {
    host,
    exec: makeSshExec(exec, host, host.repoPath),
    projectKey: host.repoPath,
    probeScope: hostSlug(host.host),
    verifyClaudeLogin: true,
  };
}

// ─── Discovery and probes ─────────────────────────────────────────────────

/** Instance names from `dns-sd -B` output lines such as `... Add  2  19 local.  _ssh._tcp.  Kevin’s MacBook Air`. */
export function parseDnsSdBrowse(stdout: string): string[] {
  const names = stdout.split('\n').flatMap((line) => {
    if (!/\sAdd\s/.test(line)) return [];
    const name = line.split('_ssh._tcp.')[1]?.trim();
    return name ? [name] : [];
  });
  return [...new Set(names)];
}

/** The hostname in `dns-sd -L` output: `... can be reached at Kevins-MacBook-Air.local.:22 (interface 19)`. */
export function parseDnsSdLookup(stdout: string): string | null {
  return /can be reached at ([^\s:]+?)\.?:\d+/.exec(stdout)?.[1] ?? null;
}

const defaultIdentity = (): string | null => {
  const path = join(homedir(), '.ssh', 'id_ed25519');
  return existsSync(path) ? path : null;
};

/**
 * Macs advertising SSH over Bonjour, plus hosts chosen before, minus this
 * Mac. `dns-sd` never exits on its own, so each call runs for a fixed window.
 */
export async function findHostCandidates(exec: ExecFn, signal?: AbortSignal): Promise<HostCandidate[]> {
  const user = userInfo().username;
  const identityFile = defaultIdentity();
  const remembered = await readRememberedHosts();
  let self: string | null = null;
  let discovered: HostCandidate[] = [];
  try {
    const [selfResult, browse] = await Promise.all([
      exec('scutil', ['--get', 'LocalHostName'], { timeout: 3_000, signal }),
      exec('/bin/sh', ['-c', '(dns-sd -B _ssh._tcp local. & p=$!; sleep 3; kill $p) 2>/dev/null'], { timeout: 10_000, signal }),
    ]);
    if (selfResult.code === 0 && selfResult.stdout.trim()) self = `${selfResult.stdout.trim()}.local`;
    const names = parseDnsSdBrowse(browse.stdout);
    const resolved = await Promise.all(names.map(async (name) => {
      const script = `(dns-sd -L ${shellQuote(name)} _ssh._tcp local. & p=$!; sleep 2; kill $p) 2>/dev/null`;
      const result = await exec('/bin/sh', ['-c', script], { timeout: 8_000, signal });
      const host = parseDnsSdLookup(result.stdout);
      return host ? [{ name, host, address: null, user, identityFile }] : [];
    }));
    discovered = resolved.flat();
  } catch {
    // Bonjour is macOS-only; remembered hosts still work elsewhere.
  }
  const merged: HostCandidate[] = [];
  for (const candidate of [...remembered, ...discovered]) {
    if (self && sameHost(candidate.host, self)) continue;
    if (merged.some((entry) => sameHost(entry.host, candidate.host))) continue;
    merged.push(candidate);
  }
  return merged;
}

const PROBE_SCRIPT = [
  `printf 'cores=%s\\n' "$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null)"`,
  `printf 'memBytes=%s\\n' "$(sysctl -n hw.memsize 2>/dev/null)"`,
  `printf 'load=%s\\n' "$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')"`,
  `printf 'diskKB=%s\\n' "$(df -k "$HOME" | awk 'NR==2{print $4}')"`,
  `printf 'power=%s\\n' "$(pmset -g batt 2>/dev/null | head -1)"`,
  `printf 'battery=%s\\n' "$(pmset -g batt 2>/dev/null | grep -o '[0-9]*%' | head -1)"`,
  `printf 'home=%s\\n' "$HOME"`,
  `printf 'projectsBase=%s\\n' "$(grep -m1 projects_base "$HOME/.config/ntm/config.toml" 2>/dev/null)"`,
  `for t in ${PROBED_TOOLS.join(' ')}; do printf 'tool.%s=%s\\n' "$t" "$(command -v $t 2>/dev/null)"; done`,
  `printf 'mail=%s\\n' "$(curl -s -m 3 http://127.0.0.1:8765/health/liveness 2>/dev/null)"`,
].join('; ');

function parseKeyValues(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  return values;
}

export function parseHostProbe(candidate: HostCandidate, stdout: string): Extract<HostProbe, { ok: true }> {
  const values = parseKeyValues(stdout);
  const number = (key: string): number | null => {
    const value = Number.parseFloat(values.get(key) ?? '');
    return Number.isFinite(value) ? value : null;
  };
  const home = values.get('home') ?? '';
  const rawBase = parseNtmProjectsBase(values.get('projectsBase') ?? '');
  const projectsBase = rawBase?.startsWith('~') ? `${home}${rawBase.slice(1)}` : rawBase;
  const tools = Object.fromEntries(PROBED_TOOLS.map((tool) => [tool, values.get(`tool.${tool}`) || null]));
  const battery = /(\d+)%/.exec(values.get('battery') ?? '');
  const diskKB = number('diskKB');
  const memBytes = number('memBytes');
  return {
    ok: true,
    candidate,
    cores: number('cores') ?? 1,
    memGB: memBytes === null ? 0 : Math.round(memBytes / 1024 ** 3),
    load: number('load') ?? 0,
    onBattery: /Battery Power/i.test(values.get('power') ?? ''),
    batteryPercent: battery ? Number(battery[1]) : null,
    diskFreeGB: diskKB === null ? null : Math.round(diskKB / 1024 ** 2),
    home,
    projectsBase,
    tools,
    missingTools: REQUIRED_TOOLS.filter((tool) => !tools[tool]),
    agentMail: /alive/.test(values.get('mail') ?? ''),
  };
}

function classifySshFailure(stderr: string): Extract<HostProbe, { ok: false }>['reason'] {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) return 'host_key';
  if (/Permission denied|Too many authentication failures/i.test(stderr)) return 'auth';
  if (/Could not resolve|timed out|No route|refused|unreachable/i.test(stderr)) return 'unreachable';
  return 'failed';
}

export async function probeHost(exec: ExecFn, candidate: HostCandidate, signal?: AbortSignal): Promise<HostProbe> {
  const route = await resolveRoute(candidate);
  const located = { ...candidate, address: route.resolved ?? candidate.address };
  try {
    const result = await remoteShell(exec, located, route, null, PROBE_SCRIPT, { timeout: 15_000, signal });
    if (result.code !== 0) {
      return { ok: false, candidate: located, reason: classifySshFailure(result.stderr), detail: result.stderr.trim().split('\n').pop() ?? `ssh exited ${result.code}` };
    }
    return parseHostProbe(located, result.stdout);
  } catch (err) {
    return { ok: false, candidate: located, reason: 'unreachable', detail: errMsg(err) };
  }
}

export async function probeThisMac(exec: ExecFn, signal?: AbortSignal): Promise<MachineLoad> {
  let power = '';
  try {
    power = (await exec('pmset', ['-g', 'batt'], { timeout: 3_000, signal })).stdout;
  } catch {
    power = '';
  }
  const battery = /(\d+)%/.exec(power);
  return {
    cores: cpus().length,
    memGB: Math.round(totalmem() / 1024 ** 3),
    load: loadavg()[0] ?? 0,
    onBattery: /Battery Power/i.test(power),
    batteryPercent: battery ? Number(battery[1]) : null,
  };
}

/** What a remote host can't do yet, in words the user can act on; empty when it can take a swarm. */
export function hostBlockers(probe: HostProbe): string[] {
  if (!probe.ok) {
    const name = probe.candidate.host;
    switch (probe.reason) {
      case 'auth': return [`${name} refused this Mac's SSH key. Add ~/.ssh/id_ed25519.pub to ~/.ssh/authorized_keys on that Mac.`];
      case 'host_key': return [`${name}'s host key isn't trusted yet. Run \`ssh ${probe.candidate.user}@${name}\` once in a terminal and accept it.`];
      case 'unreachable': return [`${name} didn't answer (${probe.detail}). Check that it's awake and that Remote Login is on in System Settings > General > Sharing.`];
      default: return [`ssh to ${name} failed: ${probe.detail}`];
    }
  }
  return [
    ...(probe.missingTools.length > 0 ? [`missing ${probe.missingTools.join(', ')}`] : []),
    ...(probe.projectsBase ? [] : ['ntm has no projects_base in ~/.config/ntm/config.toml']),
  ];
}

const pressure = (machine: MachineLoad): number => machine.load / Math.max(1, machine.cores);
const lowBattery = (machine: MachineLoad): boolean => machine.onBattery && (machine.batteryPercent ?? 100) < 25;

/** The usable host with the lowest load per core, when it's clearly lighter than this Mac. */
export function recommendHost(local: MachineLoad, probes: readonly HostProbe[]): HostProbe | null {
  const usable = probes.filter((probe): probe is Extract<HostProbe, { ok: true }> =>
    probe.ok && hostBlockers(probe).length === 0 && !lowBattery(probe));
  const best = [...usable].sort((a, b) => pressure(a) - pressure(b))[0];
  return best && pressure(best) + 0.25 < pressure(local) ? best : null;
}

function describeLoad(machine: MachineLoad): string {
  const battery = machine.onBattery ? `, on battery${machine.batteryPercent === null ? '' : ` at ${machine.batteryPercent}%`}` : '';
  return `${machine.cores} cores, ${machine.memGB} GB, load ${machine.load.toFixed(1)}${battery}`;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: false;
}

/**
 * The "where should the swarm run" question, or null when no other Mac can
 * take it. Labels are the hosts' names; `choose` accepts them as picks.
 */
export function buildSwarmHostQuestion(local: MachineLoad, probes: readonly HostProbe[]): AskQuestion | null {
  const usable = probes.filter((probe): probe is Extract<HostProbe, { ok: true }> => probe.ok && hostBlockers(probe).length === 0);
  if (usable.length === 0) return null;
  const recommended = recommendHost(local, usable);
  const remoteOptions = usable.slice(0, 3).map((probe) => ({
    probe,
    option: {
      label: `${probe.candidate.name}${probe === recommended ? ' (Recommended)' : ''}`,
      description: `Run the panes and their builds there (${describeLoad(probe)}). This session keeps coordinating, and the work syncs back after each wave.${probe.onBattery ? ' Keep it plugged in with the lid open.' : ''}`,
    },
  }));
  const thisMac = {
    label: `${THIS_MAC_LABEL}${recommended ? '' : ' (Recommended)'}`,
    description: `Run the swarm here, as before (${describeLoad(local)}).`,
  };
  const options = recommended
    ? [remoteOptions.find((entry) => entry.probe === recommended)!.option, thisMac, ...remoteOptions.filter((entry) => entry.probe !== recommended).map((entry) => entry.option)]
    : [thisMac, ...remoteOptions.map((entry) => entry.option)];
  return {
    question: `Where should the swarm run? This Mac: ${describeLoad(local)}. ${usable.map((probe) => `${probe.candidate.name}: ${describeLoad(probe)}.`).join(' ')}`,
    header: 'Swarm host',
    options: options.slice(0, 4),
    multiSelect: false,
  };
}

/** Match a question answer (label, with or without "(Recommended)") or a hostname to a probe. */
export function matchHostPick(pick: string, probes: readonly HostProbe[]): HostProbe | 'this_mac' | null {
  const bare = pick.replace(/\s*\(Recommended\)\s*$/i, '').trim();
  if (bare.toLowerCase() === THIS_MAC_LABEL.toLowerCase()) return 'this_mac';
  return probes.find((probe) => probe.candidate.name === bare || sameHost(probe.candidate.host, bare)) ?? null;
}

// ─── Prepare, pull, push, release ─────────────────────────────────────────

interface SyncContext {
  cwd: string;
  exec: ExecFn;
  signal?: AbortSignal;
}

const failure = (
  code: SwarmSyncFailure['code'],
  reason: string,
  message: string,
  hint: string,
  details?: Record<string, unknown>,
): SwarmSyncFailure => ({ ok: false, code, reason, message, hint, ...(details ? { details } : {}) });

function unreachable(host: SshTarget, stderr: string): SwarmSyncFailure {
  return failure(
    'missing_prerequisite',
    'host_unreachable',
    `ssh to ${host.host} failed: ${stderr.trim().split('\n').pop() ?? 'no output'}`,
    `Check that ${host.host} is awake and on this network, then call flywheel_swarm_host({ action: "sync" }). The swarm's work stays on that Mac until it syncs.`,
  );
}

/** ssh, scp, and rsync exit 255 when the connection failed; anything else is the command's own failure. */
function transportFailure(host: SshTarget, result: { code: number; stderr: string }, what: string): SwarmSyncFailure {
  if (result.code === 255 && !/No such file/i.test(result.stderr)) return unreachable(host, result.stderr);
  return failure('cli_failure', 'remote_command_failed', `${what} on ${host.host} exited ${result.code}: ${result.stderr.trim().split('\n').pop() ?? ''}`, 'Fix the error above, then call flywheel_swarm_host({ action: "sync" }).');
}

async function git(ctx: SyncContext, args: string[], timeout = 30_000) {
  return ctx.exec('git', args, { cwd: ctx.cwd, timeout, signal: ctx.signal });
}

async function currentBranch(ctx: SyncContext): Promise<string | null> {
  const result = await git(ctx, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return result.code === 0 ? result.stdout.trim() : null;
}

function remoteUrl(host: SwarmHost, route: Route): string {
  return `ssh://${host.user}@${route.address}${host.repoPath}`;
}

const hasBeads = (cwd: string): boolean => existsSync(join(cwd, '.beads', 'beads.db'));

async function brSync(exec: ExecFn, cwd: string, args: string[], signal?: AbortSignal) {
  return exec('br', ['sync', ...args], { cwd, timeout: 60_000, signal });
}

/**
 * Bring the worker's commits, bead changes, and completion reports into this
 * checkout. Commits fast-forward or merge into {@link SwarmHost.localBranch};
 * beads merge three ways with `br sync --merge --force`, so each side keeps
 * its own changes and the newer edit wins where both touched one bead.
 */
export async function pullFromSwarmHost(ctx: SyncContext, host: SwarmHost): Promise<SwarmSyncResult<PullSummary>> {
  const route = await resolveRoute(host);
  const branch = await currentBranch(ctx);
  if (branch !== host.localBranch) {
    return failure('blocked_state', 'branch_changed', `This checkout is on ${branch ?? 'a detached HEAD'}, but the swarm on ${host.name} branched from ${host.localBranch}.`, `Switch back to ${host.localBranch}, then call flywheel_swarm_host({ action: "sync" }).`);
  }

  const ref = `refs/flywheel-offload/${hostSlug(host.host)}`;
  const fetched = await git(ctx, ['-c', `core.sshCommand=${sshCommandLine(host, route)}`, 'fetch', '--no-tags', '--quiet', remoteUrl(host, route), `+refs/heads/${SWARM_HOST_BRANCH}:${ref}`], GIT_TIMEOUT_MS);
  let commits: PullSummary['commits'] = 'up_to_date';
  if (fetched.code !== 0) {
    if (!/couldn't find remote ref/i.test(fetched.stderr)) {
      return /ssh|Could not read from remote|Connection/i.test(fetched.stderr)
        ? unreachable(host, fetched.stderr)
        : failure('cli_failure', 'fetch_failed', `git fetch from ${host.name} failed: ${fetched.stderr.trim()}`, 'Fix the git error above, then call flywheel_swarm_host({ action: "sync" }).');
    }
  } else if ((await git(ctx, ['merge-base', '--is-ancestor', ref, 'HEAD'])).code !== 0) {
    if ((await git(ctx, ['merge-base', '--is-ancestor', 'HEAD', ref])).code === 0) {
      const ff = await git(ctx, ['merge', '--ff-only', '--quiet', ref], 60_000);
      if (ff.code !== 0) return failure('blocked_state', 'merge_refused', `Fast-forwarding to ${host.name}'s work failed: ${ff.stderr.trim()}`, `Commit or move the local changes git names above, then call flywheel_swarm_host({ action: "sync" }). ${host.name}'s commits are at ${ref}.`, { ref });
      commits = 'fast_forward';
    } else {
      const trial = await git(ctx, ['merge-tree', '--write-tree', '--name-only', 'HEAD', ref], 60_000);
      if (trial.code !== 0) {
        const conflicts = trial.stdout.split('\n\n')[0]?.split('\n').slice(1).filter(Boolean) ?? [];
        return failure('blocked_state', 'merge_conflict', `${host.name}'s work conflicts with this checkout in ${conflicts.length} file(s): ${conflicts.join(', ')}`, `Merge ${ref} into ${host.localBranch} by hand, then call flywheel_swarm_host({ action: "sync" }).`, { ref, conflicts });
      }
      const merge = await git(ctx, ['merge', '--no-ff', '--no-edit', '-m', `Merge swarm work from ${host.name}`, ref], 60_000);
      if (merge.code !== 0) return failure('blocked_state', 'merge_refused', `Merging ${host.name}'s work failed: ${merge.stderr.trim() || merge.stdout.trim()}`, `Commit or move the local changes git names above, then call flywheel_swarm_host({ action: "sync" }). ${host.name}'s commits are at ${ref}.`, { ref });
      commits = 'merged';
    }
  }

  let beads: PullSummary['beads'] = 'skipped';
  if (hasBeads(ctx.cwd)) {
    // A clone that hasn't had its first push has no beads to bring back.
    const flushed = await remoteShell(ctx.exec, host, route, host.repoPath, 'if [ -f .beads/beads.db ]; then br sync --flush-only >/dev/null && echo mirrored; fi', { timeout: 60_000, signal: ctx.signal });
    if (flushed.code !== 0) return transportFailure(host, flushed, 'br sync --flush-only');
    if (flushed.stdout.includes('mirrored')) {
      await brSync(ctx.exec, ctx.cwd, ['--flush-only'], ctx.signal);
      const copied = await ctx.exec('scp', ['-q', ...sshOptions(host, route), `${host.user}@${route.address}:${host.repoPath}/.beads/issues.jsonl`, join(ctx.cwd, '.beads', 'issues.jsonl')], { timeout: 60_000, signal: ctx.signal });
      if (copied.code !== 0) return transportFailure(host, copied, 'scp of the bead export');
      const merged = await brSync(ctx.exec, ctx.cwd, ['--merge', '--force'], ctx.signal);
      if (merged.code !== 0) return failure('cli_failure', 'bead_merge_failed', `br sync --merge failed: ${merged.stderr.trim() || merged.stdout.trim()}`, 'Run `br sync --status`, fix what it reports, then call flywheel_swarm_host({ action: "sync" }).');
      beads = 'merged';
    }
  }

  await mkdir(join(ctx.cwd, '.pi-flywheel', 'completion'), { recursive: true });
  const reports = await ctx.exec('rsync', ['-a', '-e', sshCommandLine(host, route), `${host.user}@${route.address}:${host.repoPath}/.pi-flywheel/completion/`, `${join(ctx.cwd, '.pi-flywheel', 'completion')}/`], { timeout: 60_000, signal: ctx.signal });
  if (reports.code !== 0 && !/No such file|does not exist/i.test(reports.stderr)) return transportFailure(host, reports, 'rsync of the completion reports');

  const head = (await git(ctx, ['rev-parse', 'HEAD'])).stdout.trim();
  return { ok: true, commits, head, beads, completionReports: reports.code === 0 ? 'copied' : 'none' };
}

/**
 * Hand this checkout's commits and beads to the worker. Pull first: the push
 * only fast-forwards, and the worker clone must have no uncommitted edits.
 */
export async function pushToSwarmHost(ctx: SyncContext, host: SwarmHost): Promise<SwarmSyncResult<PushSummary>> {
  const route = await resolveRoute(host);
  const branch = await currentBranch(ctx);
  if (branch !== host.localBranch) {
    return failure('blocked_state', 'branch_changed', `This checkout is on ${branch ?? 'a detached HEAD'}, but the swarm on ${host.name} branched from ${host.localBranch}.`, `Switch back to ${host.localBranch}, then call flywheel_swarm_host({ action: "sync" }).`);
  }
  const dirty = await remoteShell(ctx.exec, host, route, host.repoPath, `git status --porcelain --untracked-files=no -- . ${shellQuote(':(exclude).beads')}`, { timeout: 15_000, signal: ctx.signal });
  if (dirty.code === 255) return unreachable(host, dirty.stderr);
  if (dirty.stdout.trim()) {
    return failure('blocked_state', 'worker_dirty', `${host.name}'s clone has uncommitted changes:\n${dirty.stdout.trim()}`, `A pane left edits uncommitted in ${host.repoPath}. Have it commit or discard them, then call flywheel_swarm_host({ action: "sync" }).`, { files: dirty.stdout.trim().split('\n') });
  }

  const pushed = await git(ctx, ['-c', `core.sshCommand=${sshCommandLine(host, route)}`, 'push', '--quiet', remoteUrl(host, route), `HEAD:refs/heads/${SWARM_HOST_BRANCH}`], GIT_TIMEOUT_MS);
  if (pushed.code !== 0) {
    const refused = /\[remote rejected\][^\n]*\(([^)]*)\)/.exec(pushed.stderr)?.[1];
    if (refused) {
      return failure('blocked_state', 'worker_refused', `${host.name}'s clone refused the push: ${refused}.`, `Have the pane that left changes in ${host.repoPath} commit them, then call flywheel_swarm_host({ action: "sync" }).`);
    }
    if (/\[rejected\]|non-fast-forward|fetch first/i.test(pushed.stderr)) {
      return failure('blocked_state', 'push_rejected', `${host.name} has commits this checkout hasn't pulled.`, 'Call flywheel_swarm_host({ action: "sync" }), which pulls before it pushes.');
    }
    return /Could not read from remote|Connection|ssh:/i.test(pushed.stderr)
      ? unreachable(host, pushed.stderr)
      : failure('cli_failure', 'push_failed', `git push to ${host.name} failed: ${pushed.stderr.trim()}`, 'Fix the git error above, then call flywheel_swarm_host({ action: "sync" }).');
  }
  const checkout = await remoteShell(ctx.exec, host, route, host.repoPath, `[ "$(git symbolic-ref --quiet --short HEAD)" = ${SWARM_HOST_BRANCH} ] || git checkout --quiet ${SWARM_HOST_BRANCH}`, { timeout: 60_000, signal: ctx.signal });
  if (checkout.code !== 0) return failure('cli_failure', 'checkout_failed', `Checking out ${SWARM_HOST_BRANCH} on ${host.name} failed: ${checkout.stderr.trim()}`, `Inspect ${host.repoPath} on ${host.name}, then call flywheel_swarm_host({ action: "sync" }).`);

  let beads: PushSummary['beads'] = 'skipped';
  if (hasBeads(ctx.cwd)) {
    await brSync(ctx.exec, ctx.cwd, ['--flush-only'], ctx.signal);
    const remoteBeads = `${host.repoPath}/.beads`;
    const mirrored = await remoteShell(ctx.exec, host, route, null, `test -f ${shellQuote(`${remoteBeads}/beads.db`)} && echo present || mkdir -p ${shellQuote(remoteBeads)}`, { timeout: 15_000, signal: ctx.signal });
    if (mirrored.code === 255) return unreachable(host, mirrored.stderr);
    const first = !mirrored.stdout.includes('present');
    const files = first ? ['config.yaml', 'metadata.json', 'issues.jsonl'] : ['issues.jsonl'];
    const sources = files.map((file) => join(ctx.cwd, '.beads', file)).filter((path) => existsSync(path));
    const copied = await ctx.exec('scp', ['-q', ...sshOptions(host, route), ...sources, `${host.user}@${route.address}:${remoteBeads}/`], { timeout: 60_000, signal: ctx.signal });
    if (copied.code !== 0) return transportFailure(host, copied, 'scp of the bead export');
    const remoteExec = makeSshExec(ctx.exec, host, host.repoPath);
    const merged = await brSync(remoteExec, host.repoPath, first ? ['--import-only'] : ['--merge', '--force']);
    if (merged.code !== 0) return failure('cli_failure', 'bead_merge_failed', `br sync on ${host.name} failed: ${merged.stderr.trim() || merged.stdout.trim()}`, `Run \`br sync --status\` in ${host.repoPath} on ${host.name}, then call flywheel_swarm_host({ action: "sync" }).`);
    beads = first ? 'mirrored' : 'merged';
  }
  const head = (await git(ctx, ['rev-parse', 'HEAD'])).stdout.trim();
  return { ok: true, head, beads };
}

/**
 * Make `probe`'s Mac ready to host this checkout's swarm: a clone under its
 * ntm projects_base, this checkout's commits and beads, the coordinator's
 * Agent Mail identity there, and a `caffeinate` that keeps it awake.
 */
export async function prepareSwarmHost(
  ctx: SyncContext & { coordinatorName?: string },
  probe: Extract<HostProbe, { ok: true }>,
): Promise<SwarmSyncResult<{ host: SwarmHost; pull: PullSummary | null; push: PushSummary; warnings: string[] }>> {
  const blockers = hostBlockers(probe);
  if (blockers.length > 0) {
    return failure('missing_prerequisite', 'host_not_ready', `${probe.candidate.name} can't take a swarm yet: ${blockers.join('; ')}.`, `Fix that on ${probe.candidate.name}, then call flywheel_swarm_host({ action: "list" }) again.`);
  }
  const branch = await currentBranch(ctx);
  if (!branch) return failure('blocked_state', 'detached_head', 'This checkout is on a detached HEAD.', 'Check out a branch, then choose the swarm host again.');
  const top = await git(ctx, ['rev-parse', '--show-toplevel']);
  const root = top.code === 0 ? top.stdout.trim() : ctx.cwd;

  const candidate = probe.candidate;
  const route = await resolveRoute(candidate);
  const ntmProject = `${basename(root)}-offload`;
  const repoPath = `${probe.projectsBase!.replace(/\/$/, '')}/${ntmProject}`;
  const init = await remoteShell(ctx.exec, candidate, route, null, [
    `if [ -e ${shellQuote(repoPath)} ]; then`,
    `[ "$(git -C ${shellQuote(repoPath)} config --get flywheel.offload)" = true ] || { echo "not a flywheel clone" >&2; exit 3; };`,
    `else mkdir -p ${shellQuote(repoPath)} && cd ${shellQuote(repoPath)} && git init --quiet && git config receive.denyCurrentBranch updateInstead`,
    // Beads travel through br, so the clone never checks out a committed bead export: git
    // would refuse every push that changes it, and panes would commit their own copy.
    '&& git config core.sparseCheckout true && git config core.sparseCheckoutCone false && git config sparse.expectFilesOutsideOfPatterns true',
    `&& printf '/*\\n!/.beads/\\n' > .git/info/sparse-checkout && git config flywheel.offload true; fi`,
  ].join(' '), { timeout: 30_000, signal: ctx.signal });
  if (init.code === 3) {
    return failure('blocked_state', 'path_taken', `${repoPath} on ${candidate.name} exists and isn't a flywheel clone.`, `Move or rename ${repoPath} on ${candidate.name}; the flywheel never writes into a checkout it didn't create.`);
  }
  if (init.code !== 0) return transportFailure(candidate, init, 'Creating the clone');

  const host: SwarmHost = {
    version: 1,
    name: candidate.name,
    host: candidate.host,
    address: route.resolved ?? candidate.address,
    user: candidate.user,
    identityFile: candidate.identityFile,
    repoPath,
    ntmProject,
    localBranch: branch,
    keepAwakePid: null,
    preparedAt: new Date().toISOString(),
  };
  // A clone left by an earlier swarm may hold commits this checkout never pulled.
  const pull = await pullFromSwarmHost(ctx, host);
  if (!pull.ok) return pull;
  const push = await pushToSwarmHost(ctx, host);
  if (!push.ok) return push;

  const warnings: string[] = [];
  if (!probe.agentMail) warnings.push(`Agent Mail isn't answering on ${candidate.name}; start it there with \`am serve-http\` before the panes boot.`);
  if (probe.onBattery) warnings.push(`${candidate.name} is on battery${probe.batteryPercent === null ? '' : ` (${probe.batteryPercent}%)`}. Plug it in and keep the lid open; a closed lid on battery sleeps it mid-wave.`);
  if (ctx.coordinatorName) {
    const registered = await remoteShell(ctx.exec, candidate, route, repoPath, `am macros start-session --project ${shellQuote(repoPath)} --program claude-code --model coordinator --agent-name ${shellQuote(ctx.coordinatorName)} --task ${shellQuote('Coordinating a swarm from another Mac')} --json >/dev/null`, { timeout: 30_000, signal: ctx.signal });
    if (registered.code !== 0) warnings.push(`Couldn't register ${ctx.coordinatorName} in ${candidate.name}'s Agent Mail (${registered.stderr.trim().split('\n').pop() ?? `exit ${registered.code}`}); panes will auto-register it when they first write.`);
  }
  if (probe.tools.claude && probe.tools.node) {
    const trusted = await remoteShell(ctx.exec, candidate, route, null, `node -e ${shellQuote(TRUST_CLAUDE_FOLDER)} ${shellQuote(repoPath)}`, { timeout: 15_000, signal: ctx.signal });
    if (trusted.stdout.trim() === 'added') warnings.push(`Marked ${repoPath} trusted for Claude Code in ${candidate.name}'s ~/.claude.json, so cc panes start without the folder-trust prompt.`);
    else if (trusted.code !== 0) warnings.push(`Couldn't mark ${repoPath} trusted for Claude Code on ${candidate.name} (${trusted.stderr.trim().split('\n').pop() ?? `exit ${trusted.code}`}); cc panes there will stop at the folder-trust prompt until someone runs claude in that folder once.`);
  }
  const previous = await readSwarmHost(ctx.cwd);
  const previousPid = previous && sameHost(previous.host, candidate.host) ? previous.keepAwakePid : null;
  if (probe.tools.caffeinate) {
    // Choosing the same host again restarts the keep-awake rather than stacking a second one.
    const awake = await remoteShell(ctx.exec, candidate, route, null, [
      ...(previousPid ? [`{ ps -p ${previousPid} -o comm= | grep -q caffeinate && kill ${previousPid}; true; }`] : []),
      `{ nohup caffeinate -i -m -s -t ${KEEP_AWAKE_SECONDS} >/dev/null 2>&1 & echo $!; }`,
    ].join(' && '), { timeout: 15_000, signal: ctx.signal });
    const pid = Number.parseInt(awake.stdout.trim(), 10);
    if (awake.code === 0 && pid > 0) host.keepAwakePid = pid;
  }

  await writeSwarmHost(ctx.cwd, host);
  await rememberHost({ name: host.name, host: host.host, address: host.address, user: host.user, identityFile: host.identityFile });
  return { ok: true, host, pull, push, warnings };
}

/** Final pull, stop keeping the worker awake, and forget the host for this checkout. */
export async function releaseSwarmHost(
  ctx: SyncContext,
  host: SwarmHost,
  opts: { sync: boolean },
): Promise<SwarmSyncResult<{ pull: PullSummary | null }>> {
  const pull = opts.sync ? await pullFromSwarmHost(ctx, host) : null;
  if (pull && !pull.ok) return pull;
  if (host.keepAwakePid) {
    const route = await resolveRoute(host);
    await remoteShell(ctx.exec, host, route, null, `ps -p ${host.keepAwakePid} -o comm= | grep -q caffeinate && kill ${host.keepAwakePid}; true`, { timeout: 15_000, signal: ctx.signal });
  }
  await clearSwarmHost(ctx.cwd);
  return { ok: true, pull: pull && pull.ok ? pull : null };
}

// ─── Wave boundaries ──────────────────────────────────────────────────────

/** What a tool reports about the swarm host after handing a wave to it. */
export interface SwarmHostHandoff {
  name: string;
  repoPath: string;
  ntmProject: string;
  synced: boolean;
  detail: string;
}

/** Push before a wave's prompts go out; a failure is reported, not thrown, so the wave's state stays put. */
export async function handOffWave(ctx: SyncContext, host: SwarmHost): Promise<SwarmHostHandoff> {
  const base = { name: host.name, repoPath: host.repoPath, ntmProject: host.ntmProject };
  try {
    const pushed = await pushToSwarmHost(ctx, host);
    return pushed.ok
      ? { ...base, synced: true, detail: `pushed ${pushed.head.slice(0, 12)}, beads ${pushed.beads}` }
      : { ...base, synced: false, detail: `${pushed.message} ${pushed.hint}` };
  } catch (err) {
    return { ...base, synced: false, detail: `${errMsg(err)}. Call flywheel_swarm_host({ action: "sync" }) before sending the prompts.` };
  }
}

/** Pull before verifying a wave. Thrown errors (timeouts) become a retryable failure. */
export async function collectWave(ctx: SyncContext, host: SwarmHost): Promise<SwarmSyncResult<PullSummary>> {
  try {
    return await pullFromSwarmHost(ctx, host);
  } catch (err) {
    return failure('cli_failure', 'sync_failed', `Syncing from ${host.name} failed: ${errMsg(err)}`, 'Call flywheel_swarm_host({ action: "sync" }) once it answers, then retry.');
  }
}

// ─── `swarm-host.js run` ──────────────────────────────────────────────────

const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const RUN_USAGE = 'Usage: swarm-host run [--checkout <path>] [--cd <subdir>] [--timeout <seconds>] -- <command> [args...]';

export interface RunInvocation {
  checkout: string;
  subdir: string | null;
  timeoutMs: number;
  command: string[];
}

export function parseRunArgs(argv: readonly string[], cwd: string): { ok: true; run: RunInvocation } | { ok: false; error: string } {
  if (argv[0] !== 'run') return { ok: false, error: RUN_USAGE };
  const run: RunInvocation = { checkout: cwd, subdir: null, timeoutMs: RUN_TIMEOUT_MS, command: [] };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    if (arg === '--') {
      run.command = argv.slice(i + 1);
      break;
    }
    if (value === undefined) return { ok: false, error: `${arg} needs a value\n${RUN_USAGE}` };
    if (arg === '--checkout') run.checkout = value;
    else if (arg === '--cd') run.subdir = value.replace(/^\.\/+/, '');
    else if (arg === '--timeout' && Number(value) > 0) run.timeoutMs = Number(value) * 1000;
    else return { ok: false, error: `unknown option ${arg}\n${RUN_USAGE}` };
    i++;
  }
  if (run.command.length === 0) return { ok: false, error: RUN_USAGE };
  if (run.subdir && (run.subdir.startsWith('/') || run.subdir.split('/').includes('..'))) {
    return { ok: false, error: `--cd takes a path inside the checkout, not ${run.subdir}` };
  }
  return { ok: true, run };
}

/** The process `run` starts: ssh into the host's clone, or the command itself here. */
async function runTarget(run: RunInvocation, host: SwarmHost | null): Promise<{ cmd: string; args: string[]; cwd: string }> {
  if (!host) {
    return { cmd: run.command[0]!, args: run.command.slice(1), cwd: run.subdir ? join(run.checkout, run.subdir) : run.checkout };
  }
  const route = await resolveRoute(host);
  const dir = run.subdir ? `${host.repoPath}/${run.subdir}` : host.repoPath;
  return {
    cmd: 'ssh',
    args: [...sshOptions(host, route), `${host.user}@${route.address}`, remoteScript(dir, run.command.map(shellQuote).join(' '))],
    cwd: run.checkout,
  };
}

/** Runs a command where this checkout's swarm runs, passing its output and exit code through. */
export async function runSwarmHostCli(argv: readonly string[], cwd = process.cwd()): Promise<number> {
  const parsed = parseRunArgs(argv, cwd);
  if (!parsed.ok) {
    process.stderr.write(`swarm-host: ${parsed.error}\n`);
    return 2;
  }
  const target = await runTarget(parsed.run, await readSwarmHost(parsed.run.checkout));
  return new Promise((resolve) => {
    const child = spawn(target.cmd, target.args, { cwd: target.cwd, stdio: 'inherit' });
    const timer = setTimeout(() => {
      process.stderr.write(`swarm-host: timed out after ${parsed.run.timeoutMs / 1000}s\n`);
      child.kill('SIGTERM');
    }, parsed.run.timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      process.stderr.write(`swarm-host: ${errMsg(err)}\n`);
      resolve(127);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve(code ?? (signal ? 128 + 15 : 1));
    });
  });
}
