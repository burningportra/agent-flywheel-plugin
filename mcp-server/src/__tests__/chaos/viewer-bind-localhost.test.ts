/**
 * Chaos: bead-viewer must refuse to start when FW_VIEWER_BIND is not loopback.
 * Asserts non-zero exit and a stderr message naming the bind value.
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VIEWER_JS = resolve(__dirname, '../../../dist/scripts/bead-viewer.js');
const SPAWN_TIMEOUT_MS = 5_000;

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runViewer(env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [VIEWER_JS, '--no-open', '--port', '0'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectRun(new Error(`viewer did not exit within ${SPAWN_TIMEOUT_MS}ms`));
    }, SPAWN_TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(killer);
      resolveRun({ code, signal, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      rejectRun(err);
    });
  });
}

describe('chaos/viewer-bind-localhost', () => {
  it('refuses FW_VIEWER_BIND=0.0.0.0 with non-zero exit', async () => {
    const r = await runViewer({ FW_VIEWER_BIND: '0.0.0.0' });
    expect(r.code).not.toBe(0);
    expect(r.code).not.toBeNull();
    expect(r.stderr).toMatch(/non-loopback|0\.0\.0\.0|FW_VIEWER_BIND/i);
  }, 15_000);

  it('refuses FW_VIEWER_BIND=192.168.1.1 with non-zero exit', async () => {
    const r = await runViewer({ FW_VIEWER_BIND: '192.168.1.1' });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/non-loopback|192\.168\.1\.1|FW_VIEWER_BIND/i);
  }, 15_000);
});
