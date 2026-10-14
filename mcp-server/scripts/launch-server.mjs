// MCP entry point for plugin installs. `/plugin install` copies the repo (with the
// committed dist/) but never runs npm, so the first start installs the runtime
// dependencies, then runs dist/server.js as a child. stdout belongs to JSON-RPC:
// everything this launcher prints goes to stderr.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sdkManifest = join(root, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
const lockDir = join(root, '.deps-install.lock');
const INSTALL_TIMEOUT_MS = 180_000;
const STALE_LOCK_MS = 300_000;

const log = (message) => process.stderr.write(`[agent-flywheel launcher] ${message}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tryLock() {
  try {
    mkdirSync(lockDir);
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lockDir).mtimeMs > STALE_LOCK_MS) rmSync(lockDir, { recursive: true, force: true });
    } catch {}
    return false;
  }
}

async function ensureDependencies() {
  const deadline = Date.now() + INSTALL_TIMEOUT_MS;
  while (!existsSync(sdkManifest)) {
    if (!tryLock()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for another session to install dependencies');
      await sleep(1000);
      continue;
    }
    try {
      if (existsSync(sdkManifest)) return;
      log(`installing runtime dependencies in ${root}`);
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const result = spawnSync(
        npm,
        ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
        { cwd: root, stdio: ['ignore', process.stderr, process.stderr], timeout: INSTALL_TIMEOUT_MS, shell: process.platform === 'win32' },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`npm ci exited with ${result.status}`);
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
}

try {
  await ensureDependencies();
} catch (err) {
  log(`dependency install failed: ${err instanceof Error ? err.message : String(err)}. Run \`npm ci --omit=dev\` in ${root}.`);
  process.exit(1);
}

const child = spawn(process.execPath, [join(root, 'dist', 'server.js'), ...process.argv.slice(2)], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
