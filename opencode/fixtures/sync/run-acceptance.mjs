#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_REPO_ROOT,
  parseArgs,
  resolveConfigPaths,
  run,
} from "../../../scripts/opencode/sync.mjs";
import { deriveMcpEntry } from "../../../scripts/opencode/transforms.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

function capture() {
  let value = "";
  return {
    stream: { write: (chunk) => ((value += String(chunk)), true) },
    read: () => value,
  };
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function treeHash(root) {
  const rows = [];
  const walk = async (current, relative = "") => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      const absolutePath = path.join(current, entry.name);
      const entryStat = await lstat(absolutePath);
      if (entry.isDirectory()) {
        rows.push([relativePath, "directory", entryStat.mode & 0o777]);
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        rows.push([
          relativePath,
          "file",
          entryStat.mode & 0o777,
          (await readFile(absolutePath)).toString("base64"),
        ]);
      } else {
        rows.push([relativePath, "other", entryStat.mode & 0o777]);
      }
    }
  };
  await walk(root);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function invoke(target, modeArgs) {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await run({
    argv: [...modeArgs, "--config-dir", target],
    repoRoot: REPO_ROOT,
    stdout: stdout.stream,
    stderr: stderr.stream,
    debugProbe: () => ({ configDir: target, warning: undefined }),
  });
  return { exitCode, stdout: stdout.read(), stderr: stderr.read() };
}

assert.equal(REPO_ROOT, DEFAULT_REPO_ROOT, "fixture resolves the same repository root as the CLI");
assert.throws(
  () => parseArgs(["--check", "--write"]),
  (error) => error?.exitCode === 2,
  "mutually exclusive modes are usage errors",
);
assert.throws(
  () => parseArgs(["--config-file"]),
  (error) => error?.exitCode === 2,
  "missing flag values are usage errors",
);

const sandbox = await mkdtemp(path.join(tmpdir(), "agent-flywheel-sync-acceptance-"));
try {
  const target = path.join(sandbox, "target");
  await mkdir(path.join(target, "skills", "personal"), { recursive: true });
  await mkdir(path.join(target, "commands", "flywheel-audit.md"), { recursive: true });
  await writeFile(path.join(target, "skills", "personal", "SKILL.md"), "unmanaged skill\n");
  await writeFile(path.join(target, "commands", "personal.md"), "unmanaged command\n");
  await writeFile(path.join(target, "commands", "flywheel-audit.md", "wrong-type"), "drift\n");

  const initialHash = await treeHash(target);
  const checkBefore = await invoke(target, ["--check"]);
  assert.equal(checkBefore.exitCode, 1, "check reports drift on an unsynced target");
  assert.match(checkBefore.stdout, /^\[CHECK\]/m);
  assert.match(checkBefore.stdout, /^\[DRIFT\]/m);
  assert.equal(await treeHash(target), initialHash, "check leaves every target byte untouched");

  const dryRunBefore = await invoke(target, ["--dry-run"]);
  assert.equal(dryRunBefore.exitCode, 1, "dry-run reports pending writes as drift");
  assert.match(dryRunBefore.stdout, /^\[WRITE\].*\(dry-run\)$/m);
  assert.equal(await treeHash(target), initialHash, "dry-run leaves every target byte untouched");

  const write = await invoke(target, ["--write"]);
  assert.equal(write.exitCode, 0, "write applies and re-checks successfully");
  assert.match(write.stdout, /^\[OK\] OpenCode port is in sync\.$/m);
  assert.equal(
    await readFile(path.join(target, "skills", "personal", "SKILL.md"), "utf8"),
    "unmanaged skill\n",
    "unmanaged skill siblings survive",
  );
  assert.equal(
    await readFile(path.join(target, "commands", "personal.md"), "utf8"),
    "unmanaged command\n",
    "unmanaged command siblings survive",
  );
  assert.equal(
    await readFile(path.join(target, "commands", "start.md"), "utf8"),
    await readFile(path.join(REPO_ROOT, "opencode", "commands", "start.md"), "utf8"),
    "start override shadows the derived command byte-for-byte",
  );
  assert.equal(
    await readFile(path.join(target, "commands", "grill-with-docs.md"), "utf8"),
    await readFile(path.join(REPO_ROOT, "opencode", "commands", "grill-with-docs.md"), "utf8"),
    "grill-with-docs override is copied byte-for-byte",
  );

  const pluginManifest = JSON.parse(
    await readFile(path.join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
  );
  const config = JSON.parse(await readFile(path.join(target, "opencode.json"), "utf8"));
  assert.deepEqual(
    config.mcp.flywheel,
    deriveMcpEntry(pluginManifest, REPO_ROOT),
    "MCP entry is structurally derived from plugin.json",
  );

  const installedHash = await treeHash(target);
  const cleanCheck = await invoke(target, ["--check"]);
  assert.equal(cleanCheck.exitCode, 0, "second render is clean");
  assert.match(cleanCheck.stdout, /^\[OK\] OpenCode port is in sync\.$/m);
  assert.equal(await treeHash(target), installedHash, "clean check is byte-stable");

  const cleanDryRun = await invoke(target, ["--dry-run"]);
  assert.equal(cleanDryRun.exitCode, 0, "clean dry-run exits zero");
  assert.doesNotMatch(cleanDryRun.stdout, /^\[WRITE\]/m);
  assert.equal(await treeHash(target), installedHash, "clean dry-run is byte-stable");

  const skipTarget = path.join(sandbox, "skip-mcp");
  await mkdir(skipTarget, { recursive: true });
  const skipWrite = await invoke(skipTarget, ["--write", "--skip-mcp"]);
  assert.equal(skipWrite.exitCode, 0);
  assert.match(skipWrite.stdout, /^\[SKIP\] mcp\.flywheel/m);
  assert.equal(await fileExists(path.join(skipTarget, "opencode.json")), false);

  const ambiguousTarget = path.join(sandbox, "ambiguous");
  await mkdir(ambiguousTarget, { recursive: true });
  await writeFile(path.join(ambiguousTarget, "opencode.json"), "{}\n");
  await writeFile(path.join(ambiguousTarget, "opencode.jsonc"), "{}\n");
  await assert.rejects(
    () => invoke(ambiguousTarget, ["--check"]),
    (error) => error?.exitCode === 2 && /both .*opencode\.json/.test(error.message),
    "ambiguous config files require an explicit selection",
  );

  const fallback = await resolveConfigPaths({
    args: parseArgs([]),
    env: { HOME: path.join(sandbox, "fake-home") },
    cwd: sandbox,
    debugProbe: () => ({ configDir: "/diagnostic-only/opencode", warning: undefined }),
  });
  assert.equal(fallback.configDir, path.join(sandbox, "fake-home", ".config", "opencode"));
  assert.equal(fallback.warnings.length, 1, "debug-path mismatch is diagnostic only");

  const envDir = path.join(sandbox, "env-config");
  const fromEnvironment = await resolveConfigPaths({
    args: parseArgs([]),
    env: {
      HOME: path.join(sandbox, "ignored-home"),
      OPENCODE_CONFIG_DIR: envDir,
      OPENCODE_CONFIG_CONTENT: "{}",
    },
    cwd: sandbox,
    debugProbe: () => ({ configDir: "/diagnostic-only/opencode", warning: undefined }),
  });
  assert.equal(fromEnvironment.configDir, envDir, "environment config dir beats fallback");
  assert.equal(fromEnvironment.warnings.length, 2, "inline content and path mismatch both warn");

  const envFile = path.join(sandbox, "env-file", "custom-opencode.json");
  const fromEnvironmentFile = await resolveConfigPaths({
    args: parseArgs([]),
    env: { HOME: sandbox, OPENCODE_CONFIG: envFile },
    cwd: sandbox,
    debugProbe: () => ({ configDir: path.dirname(envFile), warning: undefined }),
  });
  assert.equal(fromEnvironmentFile.configFile, envFile, "environment config file is exact");
  assert.equal(fromEnvironmentFile.configDir, path.dirname(envFile));

  const flagDir = path.join(sandbox, "flag-config");
  const fromFlags = await resolveConfigPaths({
    args: parseArgs(["--config-dir", flagDir]),
    env: { HOME: sandbox, OPENCODE_CONFIG_DIR: envDir },
    cwd: sandbox,
    debugProbe: () => ({ configDir: envDir, warning: undefined }),
  });
  assert.equal(fromFlags.configDir, flagDir, "explicit config dir beats environment");
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

process.stdout.write("[OK] sync CLI acceptance\n");
