/**
 * clone-safety — safer `git clone` helper for user-supplied URLs.
 *
 * Motivation
 * ----------
 * Unauthenticated `git clone` over HTTPS with no SHA pinning is a supply-chain
 * footgun. A compromised upstream or DNS poisoning can redirect a clone to
 * attacker-controlled contents. CE phase4 blunder #2 (see
 * docs/research/compound-engineering-phase4-blunders.md) is the reference.
 *
 * This helper enforces three defenses at a single chokepoint:
 *   1. Host allowlist — only known-good Git hosts are accepted.
 *   2. HTTPS-only — non-https URLs require an explicit opt-in via the
 *      `FLYWHEEL_ALLOW_INSECURE_CLONE=1` env var.
 *   3. HEAD-SHA pinning — after clone we record `git rev-parse HEAD` and
 *      return it so callers can surface the exact commit to the user.
 *
 * We do NOT recurse submodules by default (another supply-chain vector),
 * and we pass args via array spawn (no shell).
 */

import { FlywheelError } from '../errors.js';
import type { ExecFn } from '../exec.js';

// ─── Types ──────────────────────────────────────────────────

export interface CloneSafetyOptions {
  /** Extra hosts to add to the allowlist (e.g. GitHub Enterprise). */
  extraAllowedHosts?: string[];
  /** Optional branch/tag/ref to check out after clone. */
  branch?: string;
  /** Clone depth (defaults to 1 — shallow). */
  depth?: number;
  /** Timeout for git operations in ms. */
  timeout?: number;
  /** Abort signal. */
  signal?: AbortSignal;
  /**
   * Env object (defaults to process.env). Exposed for testing so tests can
   * control FLYWHEEL_ALLOW_INSECURE_CLONE without mutating process.env.
   */
  env?: NodeJS.ProcessEnv;
}

export interface CloneSafetyResult {
  /** The destination path that was cloned into. */
  path: string;
  /** Pinned HEAD SHA after clone (40-char hex). */
  head_sha: string;
  /** Resolved clone URL (post-validation). */
  url: string;
  /** Human-readable source identifier, e.g. "github.com/owner/repo". */
  source: string;
}

export const CloneSafetyError = FlywheelError;

function cloneSafetyError(message: string, cloneSafetyCode: string): FlywheelError {
  return new FlywheelError({
    code: cloneSafetyCode.endsWith('_failed') ? 'cli_failure' : 'invalid_input',
    message,
    details: { cloneSafetyCode },
  });
}

// ─── Allowlist ─────────────────────────────────────────────

/**
 * Default host allowlist. Expand carefully — each entry is a trust
 * decision for user-supplied URLs flowing through the plugin.
 */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
  'git.sr.ht',
];

// ─── Validation ────────────────────────────────────────────

/**
 * Validate a user-supplied clone URL. Returns the parsed URL on success or
 * throws CloneSafetyError on failure. Pure — no side effects, no I/O.
 */
export function validateCloneUrl(
  rawUrl: string,
  opts: { extraAllowedHosts?: string[]; env?: NodeJS.ProcessEnv } = {}
): { url: URL; source: string } {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    throw cloneSafetyError('Clone URL is empty or not a string', 'invalid_url');
  }

  // Reject obviously-dangerous patterns before URL parsing. `git` accepts a
  // lot of URL-like shapes (scp-like `user@host:path`, local paths, etc.);
  // we only allow well-formed https URLs.
  if (rawUrl.includes('\x00') || rawUrl.includes('\n') || rawUrl.includes('\r')) {
    throw cloneSafetyError('Clone URL contains control characters', 'invalid_url');
  }

  // Reject args-masquerading-as-URL (e.g. `--upload-pack=...`).
  if (rawUrl.startsWith('-')) {
    throw cloneSafetyError('Clone URL must not start with "-"', 'invalid_url');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw cloneSafetyError(`Clone URL is not a valid URL: ${rawUrl}`, 'invalid_url');
  }

  const env = opts.env ?? process.env;
  const allowInsecure = env.FLYWHEEL_ALLOW_INSECURE_CLONE === '1';

  if (parsed.protocol !== 'https:' && !allowInsecure) {
    throw cloneSafetyError(
      `Clone URL must use https:// (got ${parsed.protocol}). ` +
        `Set FLYWHEEL_ALLOW_INSECURE_CLONE=1 to bypass.`,
      'insecure_protocol'
    );
  }

  // Even with the insecure bypass, forbid file:// and javascript: and
  // anything that isn't http/https/git/ssh.
  const allowedProtocols = new Set(['https:', 'http:', 'git:', 'ssh:']);
  if (!allowedProtocols.has(parsed.protocol)) {
    throw cloneSafetyError(
      `Clone URL protocol not allowed: ${parsed.protocol}`,
      'invalid_protocol'
    );
  }

  // Strip any embedded credentials (`https://user:pass@host/...`) — we don't
  // want them in logs or error messages.
  if (parsed.username || parsed.password) {
    throw cloneSafetyError(
      'Clone URL must not contain embedded credentials',
      'invalid_url'
    );
  }

  const allowed = new Set<string>([
    ...DEFAULT_ALLOWED_HOSTS,
    ...(opts.extraAllowedHosts ?? []),
  ]);
  const host = parsed.hostname.toLowerCase();

  if (!allowed.has(host)) {
    throw cloneSafetyError(
      `Clone host not in allowlist: ${host}. ` +
        `Allowed: ${[...allowed].join(', ')}. ` +
        `Pass extraAllowedHosts to extend (e.g. GitHub Enterprise).`,
      'host_not_allowed'
    );
  }

  // Reject refs that look like args: `--branch --upload-pack=...`
  // (the caller validates its own `branch` but we centralize the check).
  const source = `${host}${parsed.pathname.replace(/\.git$/, '')}`;
  return { url: parsed, source };
}

/** Validate a git ref (branch/tag) — reject arg-like or path-like refs. */
export function validateGitRef(ref: string): void {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw cloneSafetyError('Git ref is empty', 'invalid_ref');
  }
  if (ref.startsWith('-')) {
    throw cloneSafetyError(`Git ref must not start with "-": ${ref}`, 'invalid_ref');
  }
  if (/[\s\x00\n\r]/.test(ref)) {
    throw cloneSafetyError(`Git ref contains whitespace or control chars: ${ref}`, 'invalid_ref');
  }
  // git check-ref-format rejects these too but we pre-validate to fail fast.
  if (ref.includes('..') || ref.includes(':')) {
    throw cloneSafetyError(`Git ref contains invalid sequence: ${ref}`, 'invalid_ref');
  }
}

// ─── Clone ──────────────────────────────────────────────────

/**
 * Safely `git clone` a user-supplied URL into `destination` and return a
 * CloneSafetyResult including the pinned HEAD SHA.
 *
 * Callers MUST surface `head_sha` in any artifact produced from the cloned
 * contents so downstream readers can independently verify the commit.
 */
export async function safeClone(
  exec: ExecFn,
  rawUrl: string,
  destination: string,
  options: CloneSafetyOptions = {}
): Promise<CloneSafetyResult> {
  const { url, source } = validateCloneUrl(rawUrl, {
    extraAllowedHosts: options.extraAllowedHosts,
    env: options.env,
  });

  if (options.branch !== undefined) {
    validateGitRef(options.branch);
  }

  const depth = options.depth ?? 1;
  if (!Number.isInteger(depth) || depth < 1) {
    throw cloneSafetyError(`Clone depth must be a positive integer, got ${depth}`, 'invalid_depth');
  }

  const args = [
    'clone',
    '--depth',
    String(depth),
    '--single-branch',
    '--no-tags',
    '--recurse-submodules=no',
  ];
  if (options.branch) {
    args.push('--branch', options.branch);
  }
  // `--` terminator defends against a URL that somehow starts with `-` even
  // though validateCloneUrl rejected it. Defense-in-depth.
  args.push('--', url.toString(), destination);

  const clone = await exec('git', args, {
    timeout: options.timeout,
    signal: options.signal,
  });
  if (clone.code !== 0) {
    throw cloneSafetyError(
      `git clone failed (code ${clone.code}): ${clone.stderr || clone.stdout}`,
      'clone_failed'
    );
  }

  const rev = await exec('git', ['rev-parse', 'HEAD'], {
    cwd: destination,
    timeout: options.timeout,
    signal: options.signal,
  });
  if (rev.code !== 0) {
    throw cloneSafetyError(
      `git rev-parse HEAD failed (code ${rev.code}): ${rev.stderr || rev.stdout}`,
      'rev_parse_failed'
    );
  }
  const head_sha = rev.stdout.trim();
  if (!/^[0-9a-f]{7,64}$/i.test(head_sha)) {
    throw cloneSafetyError(
      `HEAD SHA does not look like a git object id: "${head_sha}"`,
      'invalid_sha'
    );
  }

  return { path: destination, head_sha, url: url.toString(), source };
}

/**
 * Format a one-line provenance string for inclusion in research artifacts.
 * Example: "github.com/foo/bar @ abc1234 (https://github.com/foo/bar.git)"
 */
export function formatProvenance(result: CloneSafetyResult): string {
  const short = result.head_sha.slice(0, 7);
  return `${result.source} @ ${short} (${result.url})`;
}
