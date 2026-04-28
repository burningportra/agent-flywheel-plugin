/**
 * Chaos: bead-viewer must exit within ~2s when its parent dies.
 *
 * We spawn an intermediate "fake parent" Node process. The fake parent spawns
 * the viewer (so viewer.ppid === fakeParent.pid) and prints the viewer's pid.
 * We then SIGKILL the fake parent. Within 2s the viewer's parent-watch
 * (PARENT_WATCH_INTERVAL_MS=1000) detects the dead ppid and exits.
 *
 * We poll `process.kill(viewerPid, 0)` from the test to confirm the viewer
 * process is gone.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VIEWER_JS = resolve(__dirname, '../../../dist/scripts/bead-viewer.js');
const FAKE_PARENT_TIMEOUT_MS = 8_000;
const PARENT_DEATH_GRACE_MS = 4_000; // viewer polls every 1s; allow 4s slack

const childRegistry: ChildProcess[] = [];

afterEach(() => {
  for (const c of childRegistry) {
    if (!c.killed && c.exitCode === null) {
      try { c.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
  childRegistry.length = 0;
});

function aliveSync(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pollUntilDead(pid: number, timeoutMs: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!aliveSync(pid)) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}

interface FakeParentResult {
  fakeParent: ChildProcess;
  viewerPid: number;
}

function spawnFakeParentWithViewer(): Promise<FakeParentResult> {
  // Inline node script: spawn the viewer, print "VIEWER_PID:<n>" once we know it,
  // then sleep forever waiting for SIGKILL.
  const script = `
    const { spawn } = require('node:child_process');
    const viewer = spawn(
      process.execPath,
      ${JSON.stringify([VIEWER_JS, '--no-open', '--port', '0'])},
      {
        env: { ...process.env, FW_VIEWER_BIND: '127.0.0.1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    process.stdout.write('VIEWER_PID:' + viewer.pid + '\\n');
    let buf = '';
    viewer.stdout.on('data', (b) => {
      buf += b.toString();
      if (buf.includes('bead-viewer ready:')) {
        process.stdout.write('VIEWER_READY\\n');
      }
    });
    viewer.stderr.on('data', () => {});
    // Sleep forever; on SIGKILL of THIS process, the viewer's parent-watch
    // should notice and exit.
    setInterval(() => {}, 1_000_000);
  `;

  return new Promise((resolveR, rejectR) => {
    const fakeParent = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    childRegistry.push(fakeParent);
    let stdout = '';
    let stderr = '';
    let viewerPid: number | null = null;
    let ready = false;
    const t = setTimeout(() => {
      try { fakeParent.kill('SIGKILL'); } catch { /* ignore */ }
      rejectR(
        new Error(
          `fake-parent setup timed out after ${FAKE_PARENT_TIMEOUT_MS}ms; stdout=${stdout} stderr=${stderr}`,
        ),
      );
    }, FAKE_PARENT_TIMEOUT_MS);

    fakeParent.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    fakeParent.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString();
      if (viewerPid === null) {
        const m = stdout.match(/VIEWER_PID:(\d+)/);
        if (m) viewerPid = Number.parseInt(m[1], 10);
      }
      if (!ready && stdout.includes('VIEWER_READY')) {
        ready = true;
      }
      if (viewerPid !== null && ready) {
        clearTimeout(t);
        resolveR({ fakeParent, viewerPid });
      }
    });
    fakeParent.on('error', (err) => {
      clearTimeout(t);
      rejectR(err);
    });
    fakeParent.on('exit', (code, signal) => {
      if (viewerPid === null || !ready) {
        clearTimeout(t);
        rejectR(
          new Error(
            `fake parent exited before viewer ready (code=${code} signal=${signal}); stdout=${stdout} stderr=${stderr}`,
          ),
        );
      }
    });
  });
}

describe('chaos/viewer-parent-death', () => {
  it('viewer exits within 4s of parent SIGKILL (poll-based)', async () => {
    const { fakeParent, viewerPid } = await spawnFakeParentWithViewer();
    expect(aliveSync(viewerPid)).toBe(true);

    // Kill the fake parent. The viewer's setInterval(ppid, 0) should fire
    // within PARENT_WATCH_INTERVAL_MS (1000ms) of detection and exit.
    fakeParent.kill('SIGKILL');

    const elapsed = await pollUntilDead(viewerPid, PARENT_DEATH_GRACE_MS);
    expect(elapsed).toBeLessThan(PARENT_DEATH_GRACE_MS);
  }, 20_000);
});
