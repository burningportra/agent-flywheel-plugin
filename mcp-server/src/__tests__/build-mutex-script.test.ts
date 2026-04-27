import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "build-mutex.sh");

type RunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function firstExisting(paths: string[]): string {
  const found = paths.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`missing required test command: ${paths.join(" or ")}`);
  }
  return found;
}

async function linkCommand(binDir: string, command: string): Promise<void> {
  await symlink(firstExisting([`/bin/${command}`, `/usr/bin/${command}`]), path.join(binDir, command));
}

async function waitForFile(filePath: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function runMutex(projectDir: string, binDir: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", [SCRIPT_PATH, ...args], {
      cwd: projectDir,
      env: {
        ...process.env,
        PATH: binDir,
        AGENT_NAME: "RainyHill",
        BUILD_MUTEX_LOCK_DIR: path.join(projectDir, ".pi-flywheel", "build.lock.d"),
        BUILD_MUTEX_RETRY_DELAY_SECONDS: "0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: stdout.join(""), stderr: stderr.join("") });
    });
  });
}

describe("scripts/build-mutex.sh", () => {
  let tempDir: string;
  let binDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "build-mutex-"));
    binDir = path.join(tempDir, "bin");
    await mkdir(binDir);

    for (const command of ["mkdir", "rm", "rmdir", "sleep"]) {
      await linkCommand(binDir, command);
    }
    await writeFile(path.join(binDir, "uname"), "#!/bin/sh\nprintf 'Darwin\\n'\n", {
      mode: 0o755,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("runs on simulated Darwin when no flock binary is on PATH", async () => {
    await expect(access(path.join(binDir, "flock"))).rejects.toThrow();

    const result = await runMutex(tempDir, binDir, [
      "/bin/sh",
      "-c",
      "printf ok > mutex.out",
    ]);

    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFile(path.join(tempDir, "mutex.out"), "utf8")).toBe("ok");
    await expect(access(path.join(tempDir, ".pi-flywheel", "build.lock.d"))).rejects.toThrow();
  });

  it("serializes concurrent commands with the mkdir lock", async () => {
    const firstStarted = path.join(tempDir, "first.started");
    const secondStarted = path.join(tempDir, "second.started");
    const releaseFirst = path.join(tempDir, "release-first");

    const first = runMutex(tempDir, binDir, [
      "/bin/sh",
      "-c",
      "printf started > first.started; while [ ! -f release-first ]; do sleep 0.1; done; printf done > first.done",
    ]);
    await waitForFile(firstStarted);

    const second = runMutex(tempDir, binDir, [
      "/bin/sh",
      "-c",
      "printf second > second.started",
    ]);
    await delay(250);

    expect(existsSync(secondStarted)).toBe(false);
    await writeFile(releaseFirst, "release", "utf8");

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(secondResult).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(await readFile(secondStarted, "utf8")).toBe("second");
  });
});
