/**
 * Chaos: spawn two viewers on the same explicit port. T14 does NOT retry,
 * so the second instance must exit non-zero with an EADDRINUSE-style error.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VIEWER_JS = resolve(__dirname, '../../../dist/scripts/bead-viewer.js');
const READY_TIMEOUT_MS = 8_000;
const EXIT_TIMEOUT_MS = 8_000;

const childRegistry: ChildProcess[] = [];

afterEach(() => {
  for (const c of childRegistry) {
    if (!c.killed && c.exitCode === null) {
      try {
        c.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  }
  childRegistry.length = 0;
});

function pickFreePort(): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', rejectP);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr !== 'object' || !addr) {
        rejectP(new Error('no address'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolveP(port));
    });
  });
}

interface SpawnedViewer {
  child: ChildProcess;
  ready: Promise<string>;
  exit: Promise<{ code: number | null; stderr: string; stdout: string }>;
}

function spawnViewer(port: number): SpawnedViewer {
  const child = spawn(
    process.execPath,
    [VIEWER_JS, '--no-open', '--port', String(port)],
    {
      env: { ...process.env, FW_VIEWER_BIND: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  childRegistry.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (b: Buffer) => {
    stdout += b.toString();
  });
  child.stderr?.on('data', (b: Buffer) => {
    stderr += b.toString();
  });

  const ready = new Promise<string>((resolveR, rejectR) => {
    const t = setTimeout(() => {
      rejectR(new Error(`viewer not ready in ${READY_TIMEOUT_MS}ms; stderr=${stderr}`));
    }, READY_TIMEOUT_MS);
    const onData = () => {
      const m = stdout.match(/bead-viewer ready: (\S+)/);
      if (m) {
        clearTimeout(t);
        child.stdout?.off('data', onData);
        resolveR(m[1]);
      }
    };
    child.stdout?.on('data', onData);
    child.on('exit', () => {
      clearTimeout(t);
      rejectR(new Error(`viewer exited before ready; stderr=${stderr}`));
    });
  });

  const exit = new Promise<{ code: number | null; stderr: string; stdout: string }>(
    (resolveE) => {
      child.on('exit', (code) => {
        resolveE({ code, stderr, stdout });
      });
    },
  );

  return { child, ready, exit };
}

describe('chaos/viewer-port-collision', () => {
  it('second viewer on same port exits non-zero (no retry in T14)', async () => {
    const port = await pickFreePort();
    const first = spawnViewer(port);
    await first.ready;

    const second = spawnViewer(port);
    const result = await Promise.race<
      { code: number | null; stderr: string; stdout: string } | { ready: string }
    >([
      second.exit,
      second.ready.then((url) => ({ ready: url })),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('second viewer hung')), EXIT_TIMEOUT_MS),
      ),
    ]);

    if ('ready' in result) {
      throw new Error(
        `second viewer should not have become ready on busy port ${port}; url=${result.ready}`,
      );
    }
    expect(result.code).not.toBe(0);
    expect(result.code).not.toBeNull();
    expect((result.stderr + result.stdout).toLowerCase()).toMatch(
      /eaddrinuse|address.*in.*use|port.*in.*use/,
    );

    first.child.kill('SIGTERM');
    await first.exit;
  }, 30_000);
});
