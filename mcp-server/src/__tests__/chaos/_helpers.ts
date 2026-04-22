/**
 * Shared test utilities for the T13 chaos + regression harness.
 * Prefixed with underscore so vitest does not collect this as a test file.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecFn } from '../../exec.js';

// ─── Tmp CWD factory ──────────────────────────────────────────

/**
 * Create a temp directory that looks like an agent-flywheel project root.
 * Includes a minimal mcp-server/dist/server.js so doctor's dist_drift
 * check stays green when using allGreenExec.
 */
export function makeTmpCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 't13-chaos-'));
  mkdirSync(join(dir, 'mcp-server', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'mcp-server', 'dist', 'server.js'), '// built\n');
  return dir;
}

export function cleanupTmpCwd(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── ExecStub types ───────────────────────────────────────────

export type ExecStubRespond =
  | { result: { code: number; stdout: string; stderr: string } }
  | { throws: Error }
  | { hangMs: number; result?: undefined };

export interface ExecStub {
  match: (cmd: string, args: readonly string[]) => boolean;
  respond: ExecStubRespond;
}

/**
 * Build an ExecFn from an array of stubs. Unmatched commands return
 * `{ code: 1, stdout: '', stderr: 'not mocked: <cmd>' }` — surfaces
 * unexpected calls in test output without throwing.
 */
export function makeExecFn(stubs: ExecStub[]): ExecFn {
  return async (cmd, args, opts) => {
    if (opts?.signal?.aborted) throw new Error('Aborted');
    const stub = stubs.find((s) => s.match(cmd, args));
    if (!stub) {
      return { code: 1, stdout: '', stderr: `not mocked: ${cmd} ${args.join(' ')}` };
    }
    if ('throws' in stub.respond) {
      throw stub.respond.throws;
    }
    if ('hangMs' in stub.respond) {
      const hangMs = (stub.respond as { hangMs: number }).hangMs;
      // Returns a promise that hangs for hangMs, but aborts early if signal fires.
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve({ code: 0, stdout: '', stderr: '' });
        }, hangMs);
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Aborted'));
          }, { once: true });
        }
      });
    }
    return stub.respond.result;
  };
}

// ─── Common stub factories ────────────────────────────────────

const ok = (stdout: string) => ({ result: { code: 0, stdout, stderr: '' } });

/** Returns a stub set where every exec-based check resolves green. */
export function allGreenStubs(): ExecStub[] {
  return [
    {
      match: (cmd, args) =>
        cmd === 'curl' && args.includes('http://127.0.0.1:8765/health/liveness'),
      respond: ok('{"status":"alive"}'),
    },
    { match: (cmd, args) => cmd === 'br' && args[0] === '--version', respond: ok('br 0.1.0') },
    { match: (cmd, args) => cmd === 'bv' && args[0] === '--version', respond: ok('bv 0.1.0') },
    { match: (cmd, args) => cmd === 'ntm' && args[0] === '--version', respond: ok('ntm 0.1.0') },
    { match: (cmd, args) => cmd === 'cm' && args[0] === '--version', respond: ok('cm 0.1.0') },
    { match: (cmd, args) => cmd === 'node' && args[0] === '--version', respond: ok('v22.0.0') },
    { match: (cmd, args) => cmd === 'git' && args[0] === 'rev-parse', respond: ok('abc123') },
    { match: (cmd, args) => cmd === 'git' && args[0] === 'status', respond: ok('') },
  ];
}

/**
 * Merge two stub arrays. Stubs in `overrides` take precedence over `base`
 * for any command that both match.
 */
export function mergeStubs(base: ExecStub[], overrides: ExecStub[]): ExecStub[] {
  return [...overrides, ...base];
}
