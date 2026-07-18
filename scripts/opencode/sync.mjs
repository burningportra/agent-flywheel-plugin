#!/usr/bin/env node

/**
 * Render the repository-owned OpenCode integration into an exact, private
 * staging tree, then check, preview, or apply the owned subset only.
 */

import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadManifest, validateManifest } from "./validate.mjs";
import { applyTransformProfile, deriveMcpEntry } from "./transforms.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = path.resolve(MODULE_DIR, "..", "..");
const DEBUG_PATHS_TIMEOUT_MS = 3_000;

const HELP = `Usage: scripts/sync-opencode.sh [mode] [options]

Render the agent-flywheel OpenCode port from repository sources.

Modes (choose exactly one):
  --check       Render privately and report managed drift (default).
  --dry-run     Preview every managed write without touching the target.
  --write       Apply managed writes atomically per item, then re-check.

Options:
  --config-dir <path>   OpenCode configuration directory.
  --config-file <path>  Exact opencode.json or opencode.jsonc path.
  --skip-mcp            Leave the OpenCode config file and mcp.flywheel untouched.
  -h, --help            Show this help.

Config precedence:
  flags -> OPENCODE_CONFIG_DIR/OPENCODE_CONFIG
  -> \${XDG_CONFIG_HOME:-$HOME/.config}/opencode
  opencode debug paths is a bounded diagnostic cross-check only.

Ownership boundary:
  Only manifest-enumerated skills/<name>/, commands/<name>.md,
  plugins/agent-flywheel.js, and the mcp.flywheel config entry are managed.
  Parent directories and unrelated files, skills, commands, plugins, and
  config keys are never ownership targets.

Exit codes:
  0  clean, or write completed and re-check is clean
  1  drift/pending dry-run writes, validation failure, or apply error
  2  invalid usage or a missing/unsupported prerequisite

Examples:
  scripts/sync-opencode.sh
  scripts/sync-opencode.sh --dry-run --config-dir /tmp/opencode-preview
  scripts/sync-opencode.sh --write --config-file "$HOME/.config/opencode/opencode.json"
`;

class SyncError extends Error {
  constructor(message, exitCode = 1, options) {
    super(message, options);
    this.name = "SyncError";
    this.exitCode = exitCode;
  }
}

function usageError(message) {
  return new SyncError(`${message}\nRun with --help for usage.`, 2);
}

function prerequisiteError(message) {
  return new SyncError(message, 2);
}

function operationalError(message, options) {
  return new SyncError(message, 1, options);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveUserPath(value, cwd, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw usageError(`${label} requires a non-empty path`);
  }
  return path.resolve(cwd, value);
}

export function parseArgs(argv) {
  const parsed = {
    mode: "check",
    modeExplicit: false,
    configDir: undefined,
    configFile: undefined,
    skipMcp: false,
    help: false,
  };
  const setMode = (mode) => {
    if (parsed.modeExplicit && parsed.mode !== mode) {
      throw usageError(`modes are mutually exclusive: --${parsed.mode} and --${mode}`);
    }
    parsed.mode = mode;
    parsed.modeExplicit = true;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") setMode("check");
    else if (arg === "--dry-run") setMode("dry-run");
    else if (arg === "--write") setMode("write");
    else if (arg === "--skip-mcp") parsed.skipMcp = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--config-dir" || arg === "--config-file") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw usageError(`${arg} requires a path argument`);
      }
      index += 1;
      const key = arg === "--config-dir" ? "configDir" : "configFile";
      if (parsed[key] !== undefined) throw usageError(`${arg} may be specified only once`);
      parsed[key] = value;
    } else {
      throw usageError(`unknown option ${JSON.stringify(arg)}`);
    }
  }
  return parsed;
}

function probeOpenCodeConfigDir() {
  const result = spawnSync("opencode", ["debug", "paths"], {
    encoding: "utf8",
    timeout: DEBUG_PATHS_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    const reason = result.error.code === "ETIMEDOUT" ? "timed out" : result.error.message;
    return { configDir: undefined, warning: `opencode debug paths unavailable: ${reason}` };
  }
  if (result.status !== 0) {
    return {
      configDir: undefined,
      warning: `opencode debug paths exited ${String(result.status)}; using configured fallback`,
    };
  }
  const match = String(result.stdout).match(/^config\s+(.+)$/m);
  if (!match) {
    return {
      configDir: undefined,
      warning: "opencode debug paths returned no config row; using configured fallback",
    };
  }
  return { configDir: path.resolve(match[1].trim()), warning: undefined };
}

function fallbackConfigDir(env) {
  if (env.XDG_CONFIG_HOME) return path.resolve(env.XDG_CONFIG_HOME, "opencode");
  const home = env.HOME || homedir();
  if (!home) throw prerequisiteError("cannot resolve OpenCode config: HOME is unset");
  return path.resolve(home, ".config", "opencode");
}

/** Resolve the target directory/file without creating either one. */
export async function resolveConfigPaths(options) {
  const {
    args,
    env = process.env,
    cwd = process.cwd(),
    debugProbe = probeOpenCodeConfigDir,
  } = options;
  const warnings = [];
  const debug = debugProbe();
  if (debug.warning) warnings.push(debug.warning);
  if (env.OPENCODE_CONFIG_CONTENT !== undefined) {
    warnings.push(
      "OPENCODE_CONFIG_CONTENT is set; file sync can succeed but OpenCode may use the environment content instead",
    );
  }

  let configDir;
  let selectedConfigFile;
  let selectionSource;

  if (args.configDir !== undefined || args.configFile !== undefined) {
    selectionSource = "flags";
    const flagDir = args.configDir
      ? resolveUserPath(args.configDir, cwd, "--config-dir")
      : undefined;
    const flagFile = args.configFile
      ? resolveUserPath(args.configFile, cwd, "--config-file")
      : undefined;
    if (flagDir && flagFile && path.dirname(flagFile) !== flagDir) {
      throw usageError("--config-file must be inside --config-dir when both are supplied");
    }
    configDir = flagDir ?? path.dirname(flagFile);
    selectedConfigFile = flagFile;
  } else if (env.OPENCODE_CONFIG_DIR || env.OPENCODE_CONFIG) {
    selectionSource = "environment";
    const envDir = env.OPENCODE_CONFIG_DIR
      ? resolveUserPath(env.OPENCODE_CONFIG_DIR, cwd, "OPENCODE_CONFIG_DIR")
      : undefined;
    const envFile = env.OPENCODE_CONFIG
      ? resolveUserPath(env.OPENCODE_CONFIG, cwd, "OPENCODE_CONFIG")
      : undefined;
    if (envDir && envFile && path.dirname(envFile) !== envDir) {
      throw prerequisiteError("OPENCODE_CONFIG must be inside OPENCODE_CONFIG_DIR when both are set");
    }
    configDir = envDir ?? path.dirname(envFile);
    selectedConfigFile = envFile;
  } else {
    selectionSource = "XDG/HOME fallback";
    configDir = fallbackConfigDir(env);
  }

  if (debug.configDir && path.resolve(debug.configDir) !== path.resolve(configDir)) {
    warnings.push(
      `resolved config dir ${configDir} (${selectionSource}) differs from opencode debug paths ${debug.configDir}`,
    );
  }

  const jsonPath = path.join(configDir, "opencode.json");
  const jsoncPath = path.join(configDir, "opencode.jsonc");
  if (!selectedConfigFile) {
    const [hasJson, hasJsonc] = await Promise.all([exists(jsonPath), exists(jsoncPath)]);
    if (hasJson && hasJsonc) {
      throw prerequisiteError(
        `both ${jsonPath} and ${jsoncPath} exist; select one with --config-file`,
      );
    }
    selectedConfigFile = hasJsonc ? jsoncPath : jsonPath;
  }

  return {
    configDir,
    configFile: selectedConfigFile,
    selectionSource,
    warnings,
  };
}

function assertNode20() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(major) || major < 20) {
    throw prerequisiteError(`Node 20+ is required (running ${process.versions.node})`);
  }
}

function resolveContained(root, relativePath, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw operationalError(`${label} must be a non-empty relative path`);
  }
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw operationalError(`${label} must be relative: ${JSON.stringify(relativePath)}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relativePath);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw operationalError(`${label} escapes its root: ${JSON.stringify(relativePath)}`);
  }
  return resolved;
}

function normalizeTarget(target) {
  return target.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function collectArtifactSpecs(manifest) {
  const byTarget = new Map();
  const add = (spec) => {
    const target = normalizeTarget(spec.target ?? "");
    if (!target) throw operationalError(`${spec.kind ?? "artifact"} ${spec.name ?? "?"} has no target`);
    const normalized = { ...spec, target };
    const existing = byTarget.get(target);
    if (!existing) {
      byTarget.set(target, normalized);
      return;
    }
    const overrideShadowsCommand =
      existing.kind === "command" &&
      normalized.kind === "command-override" &&
      existing.name === normalized.name;
    if (overrideShadowsCommand) {
      byTarget.set(target, normalized);
      return;
    }
    throw operationalError(
      `duplicate ownership target ${JSON.stringify(target)} from ${existing.kind}:${existing.name} and ${normalized.kind}:${normalized.name}`,
    );
  };

  for (const spec of manifest.skills ?? []) add(spec);
  for (const spec of manifest.commands ?? []) add(spec);
  for (const spec of manifest.commandOverrides ?? []) add(spec);
  if (manifest.plugin) add({ ...manifest.plugin, source: manifest.plugin.template });
  return [...byTarget.values()].sort((a, b) => a.target.localeCompare(b.target));
}

function validateSpecShape(spec) {
  const expected = {
    "skill-dir": "skill",
    command: "command",
    "command-override": "command-override",
    plugin: "plugin",
  };
  if (!(spec.kind in expected)) {
    throw operationalError(`unsupported manifest artifact kind ${JSON.stringify(spec.kind)}`);
  }
  if (spec.transformProfile !== expected[spec.kind]) {
    throw operationalError(
      `${spec.kind}:${spec.name} must use transform profile ${expected[spec.kind]} (got ${JSON.stringify(spec.transformProfile)})`,
    );
  }
}

async function copyRenderedFile(sourcePath, stagePath, spec, repoRoot) {
  const sourceStat = await lstat(sourcePath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw prerequisiteError(`required source is missing: ${path.relative(repoRoot, sourcePath)}`);
    }
    throw error;
  });
  if (!sourceStat.isFile()) {
    throw prerequisiteError(`required source is not a regular file: ${path.relative(repoRoot, sourcePath)}`);
  }
  await mkdir(path.dirname(stagePath), { recursive: true });
  const shouldTransform =
    spec.transformProfile === "plugin" ||
    (spec.transformProfile !== "command-override" && path.extname(sourcePath) === ".md");
  if (spec.transformProfile === "command-override") {
    const bytes = await readFile(sourcePath);
    const content = bytes.toString("utf8");
    const validated = applyTransformProfile(content, {
      profile: spec.transformProfile,
      repoRoot,
      sourcePath: path.relative(repoRoot, sourcePath),
    });
    if (!Buffer.from(validated, "utf8").equals(bytes)) {
      throw operationalError(`command override must render byte-for-byte: ${spec.source}`);
    }
    await writeFile(stagePath, bytes);
  } else if (!shouldTransform) {
    const bytes = await readFile(sourcePath);
    await writeFile(stagePath, bytes);
  } else {
    const content = await readFile(sourcePath, "utf8");
    const rendered = applyTransformProfile(content, {
      profile: spec.transformProfile,
      repoRoot,
      sourcePath: path.relative(repoRoot, sourcePath),
    });
    await writeFile(stagePath, rendered, "utf8");
  }
  await chmod(stagePath, sourceStat.mode & 0o777);
}

async function renderSkillDirectory(sourceRoot, stageRoot, spec, repoRoot) {
  const sourceStat = await lstat(sourceRoot).catch((error) => {
    if (error?.code === "ENOENT") {
      throw prerequisiteError(`required source directory is missing: ${path.relative(repoRoot, sourceRoot)}`);
    }
    throw error;
  });
  if (!sourceStat.isDirectory()) {
    throw prerequisiteError(
      `required source is not a directory: ${path.relative(repoRoot, sourceRoot)}`,
    );
  }
  await mkdir(stageRoot, { recursive: true });
  const entries = (await readdir(sourceRoot, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const stagePath = path.join(stageRoot, entry.name);
    if (entry.isDirectory()) {
      await renderSkillDirectory(sourcePath, stagePath, spec, repoRoot);
    } else if (entry.isFile()) {
      await copyRenderedFile(sourcePath, stagePath, spec, repoRoot);
    } else {
      throw prerequisiteError(
        `managed source contains an unsupported file type: ${path.relative(repoRoot, sourcePath)}`,
      );
    }
  }
}

function formatFindings(findings) {
  return findings
    .map((finding) => {
      const location = finding.command ?? finding.name ?? finding.from;
      return `${finding.code}${location ? ` (${location})` : ""}: ${finding.message}`;
    })
    .join("\n  ");
}

async function validateOrThrow(repoRoot, manifest, label) {
  let result;
  try {
    result = await validateManifest(repoRoot, { manifest });
  } catch (error) {
    throw operationalError(`${label} validator failed: ${String(error)}`, { cause: error });
  }
  if (!result.ok) {
    throw operationalError(
      `${label} validator reported ${result.findings.length} finding(s):\n  ${formatFindings(result.findings)}`,
    );
  }
  return result;
}

async function loadJson(filePath, label) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw prerequisiteError(`${label} is missing: ${filePath}`);
    throw operationalError(`${label} is unreadable: ${filePath}: ${String(error)}`, { cause: error });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw operationalError(`${label} is not valid JSON: ${filePath}: ${String(error)}`, {
      cause: error,
    });
  }
}

async function validateMcpCommandPaths(entry, repoRoot) {
  const resolvedRoot = path.resolve(repoRoot);
  const rootedArgs = entry.command.slice(1).filter((arg) => {
    if (typeof arg !== "string" || !path.isAbsolute(arg)) return false;
    const resolved = path.resolve(arg);
    return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
  });
  if (rootedArgs.length === 0) {
    throw prerequisiteError(
      "derived MCP command has no repository-rooted server path from CLAUDE_PLUGIN_ROOT",
    );
  }
  for (const serverPath of rootedArgs) {
    let serverStat;
    try {
      serverStat = await lstat(serverPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw prerequisiteError(`derived MCP server path is missing: ${serverPath}`);
      }
      throw error;
    }
    if (!serverStat.isFile()) {
      throw prerequisiteError(`derived MCP server path is not a regular file: ${serverPath}`);
    }
  }
}

/** Build an exact staging tree and validate both source and rendered views. */
export async function renderManagedTree(options) {
  const { repoRoot, stageRoot, configFile, skipMcp } = options;
  const manifestPath = path.join(repoRoot, "opencode", "manifest.json");
  const loaded = await loadManifest(manifestPath).catch((error) => {
    throw operationalError(String(error), { cause: error });
  });
  const manifest = loaded.manifest;
  await validateOrThrow(repoRoot, manifest, "source");

  const specs = collectArtifactSpecs(manifest);
  const items = [];
  for (const spec of specs) {
    validateSpecShape(spec);
    const sourcePath = resolveContained(repoRoot, spec.source, `${spec.kind}:${spec.name} source`);
    const stagePath = resolveContained(stageRoot, spec.target, `${spec.kind}:${spec.name} target`);
    if (spec.kind === "skill-dir") {
      await renderSkillDirectory(sourcePath, stagePath, spec, repoRoot);
      items.push({
        id: `${spec.kind}:${spec.name}`,
        kind: "tree",
        target: spec.target,
        stagePath,
      });
    } else {
      await copyRenderedFile(sourcePath, stagePath, spec, repoRoot);
      items.push({
        id: `${spec.kind}:${spec.name}`,
        kind: "file",
        target: spec.target,
        stagePath,
      });
    }
  }

  // The imported validator reads manifest source paths. Overrides install at a
  // target path, so mirror their rendered bytes into the validation-only source
  // path inside the private stage before validating the rendered view.
  for (const override of manifest.commandOverrides ?? []) {
    const renderedPath = resolveContained(stageRoot, override.target, "override target");
    const validationSource = resolveContained(stageRoot, override.source, "override source");
    if (renderedPath !== validationSource) {
      await mkdir(path.dirname(validationSource), { recursive: true });
      await writeFile(validationSource, await readFile(renderedPath));
    }
  }
  const hooksSource = path.join(repoRoot, "hooks", "hooks.json");
  const hooksValidationPath = path.join(stageRoot, "hooks", "hooks.json");
  await mkdir(path.dirname(hooksValidationPath), { recursive: true });
  await writeFile(hooksValidationPath, await readFile(hooksSource));
  await validateOrThrow(stageRoot, manifest, "rendered stage");

  let mcpItem;
  if (!skipMcp) {
    const pluginManifest = await loadJson(
      path.join(repoRoot, ".claude-plugin", "plugin.json"),
      "Claude plugin manifest",
    );
    const expectedEntry = deriveMcpEntry(pluginManifest, repoRoot);
    await validateMcpCommandPaths(expectedEntry, repoRoot);
    const configKey = manifest?.mcp?.configKey;
    if (typeof configKey !== "string" || configKey.length === 0) {
      throw operationalError("opencode manifest mcp.configKey is missing");
    }
    mcpItem = {
      id: `mcp:${configKey}`,
      kind: "mcp",
      target: configFile,
      displayTarget: `${configFile}#mcp.${configKey}`,
      configKey,
      expectedEntry,
    };
    items.push(mcpItem);
  }

  return { manifest, items, mcpItem };
}

async function directorySnapshot(root) {
  const snapshot = [];
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true, wrongType: false, entries: snapshot };
    throw error;
  }
  if (!rootStat.isDirectory()) {
    return { missing: false, wrongType: true, entries: snapshot };
  }
  const walk = async (current, relative) => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        snapshot.push({ relative: `${childRelative}/`, type: "directory" });
        await walk(child, childRelative);
      } else if (entry.isFile()) {
        snapshot.push({ relative: childRelative, type: "file", bytes: await readFile(child) });
      } else if (entry.isSymbolicLink()) {
        snapshot.push({ relative: childRelative, type: "symlink" });
      } else {
        snapshot.push({ relative: childRelative, type: "other" });
      }
    }
  };
  await walk(root, "");
  return { missing: false, wrongType: false, entries: snapshot };
}

function snapshotsEqual(expected, actual) {
  if (expected.length !== actual.length) return false;
  return expected.every((left, index) => {
    const right = actual[index];
    return (
      left.relative === right.relative &&
      left.type === right.type &&
      (left.type !== "file" || left.bytes.equals(right.bytes))
    );
  });
}

async function readConfigObject(configFile) {
  if (configFile.endsWith(".jsonc")) {
    throw prerequisiteError(
      `JSONC-preserving MCP merge is not available yet for ${configFile}; use --skip-mcp or select opencode.json`,
    );
  }
  let raw;
  try {
    raw = await readFile(configFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { value: {}, exists: false, mode: 0o644 };
    throw operationalError(`cannot read OpenCode config ${configFile}: ${String(error)}`, { cause: error });
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw operationalError(`OpenCode config is not valid JSON: ${configFile}: ${String(error)}`, {
      cause: error,
    });
  }
  if (!isObject(value)) throw operationalError(`OpenCode config root must be an object: ${configFile}`);
  const fileStat = await stat(configFile);
  return { value, exists: true, mode: fileStat.mode & 0o777 };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function compareItem(item, configDir) {
  if (item.kind === "mcp") {
    const config = await readConfigObject(item.target);
    const mcp = config.value.mcp;
    if (mcp !== undefined && !isObject(mcp)) {
      throw operationalError(`OpenCode config mcp field must be an object: ${item.target}`);
    }
    const actual = mcp?.[item.configKey];
    return {
      ...item,
      clean: canonicalJson(actual) === canonicalJson(item.expectedEntry),
      reason: actual === undefined ? "entry missing" : "entry differs",
    };
  }

  const targetPath = resolveContained(configDir, item.target, `${item.id} install target`);
  if (item.kind === "file") {
    let actualStat;
    try {
      actualStat = await lstat(targetPath);
    } catch (error) {
      if (error?.code === "ENOENT") return { ...item, targetPath, clean: false, reason: "missing" };
      throw error;
    }
    if (!actualStat.isFile()) {
      return { ...item, targetPath, clean: false, reason: "type differs" };
    }
    const [expected, actual] = await Promise.all([readFile(item.stagePath), readFile(targetPath)]);
    return {
      ...item,
      targetPath,
      clean: expected.equals(actual),
      reason: "content differs",
    };
  }

  const [expected, actual] = await Promise.all([
    directorySnapshot(item.stagePath),
    directorySnapshot(targetPath),
  ]);
  if (actual.missing) return { ...item, targetPath, clean: false, reason: "missing" };
  if (actual.wrongType) return { ...item, targetPath, clean: false, reason: "type differs" };
  return {
    ...item,
    targetPath,
    clean: !expected.missing && snapshotsEqual(expected.entries, actual.entries),
    reason: "tree differs",
  };
}

export async function compareRenderedItems(items, configDir) {
  const reports = [];
  for (const item of items) reports.push(await compareItem(item, configDir));
  return reports;
}

function displayItem(report) {
  return report.displayTarget ?? report.target;
}

function printReports(reports, output = process.stdout) {
  for (const report of reports) {
    const status = report.clean ? "OK" : "DRIFT";
    const detail = report.clean ? "" : ` (${report.reason})`;
    output.write(`[${status}] ${displayItem(report)}${detail}\n`);
  }
}

async function atomicReplaceFromStage(stagePath, targetPath, kind) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const holder = await mkdtemp(path.join(path.dirname(targetPath), ".flywheel-swap-"));
  const candidate = path.join(holder, "new");
  const previous = path.join(holder, "previous");
  let movedPrevious = false;
  let preserveHolder = false;
  try {
    if (kind === "tree") {
      await cp(stagePath, candidate, { recursive: true, force: false, errorOnExist: true });
    } else {
      await writeFile(candidate, await readFile(stagePath), { flag: "wx" });
      const sourceStat = await stat(stagePath);
      await chmod(candidate, sourceStat.mode & 0o777);
    }
    if (await exists(targetPath)) {
      await rename(targetPath, previous);
      movedPrevious = true;
    }
    await rename(candidate, targetPath);
    if (movedPrevious) {
      await rm(previous, { recursive: true, force: true });
      movedPrevious = false;
    }
  } catch (error) {
    if (movedPrevious && (await exists(previous))) {
      if (!(await exists(targetPath))) {
        try {
          await rename(previous, targetPath);
          movedPrevious = false;
        } catch (restoreError) {
          preserveHolder = true;
          throw new AggregateError(
            [error, restoreError],
            `write failed and rollback could not restore ${targetPath}; previous bytes remain at ${previous}`,
          );
        }
      } else {
        preserveHolder = true;
        throw new Error(
          `write failed after moving ${targetPath}; previous bytes remain at ${previous}: ${String(error)}`,
          { cause: error },
        );
      }
    }
    throw error;
  } finally {
    if (!preserveHolder) await rm(holder, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeMcpEntry(item) {
  const config = await readConfigObject(item.target);
  const currentMcp = config.value.mcp;
  if (currentMcp !== undefined && !isObject(currentMcp)) {
    throw operationalError(`OpenCode config mcp field must be an object: ${item.target}`);
  }
  const next = {
    ...config.value,
    mcp: { ...(currentMcp ?? {}), [item.configKey]: item.expectedEntry },
  };
  await mkdir(path.dirname(item.target), { recursive: true });
  const holder = await mkdtemp(path.join(path.dirname(item.target), ".flywheel-config-"));
  const stagedConfig = path.join(holder, "opencode.json");
  try {
    await writeFile(stagedConfig, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
    await chmod(stagedConfig, config.mode);
    await atomicReplaceFromStage(stagedConfig, item.target, "file");
  } finally {
    await rm(holder, { recursive: true, force: true }).catch(() => {});
  }
}

/** Apply a previously compared plan. Kept separate so T6 can wrap the journal. */
export async function applyReports(reports, output = process.stdout) {
  for (const report of reports) {
    if (report.clean) continue;
    output.write(`[WRITE] ${displayItem(report)}\n`);
    try {
      if (report.kind === "mcp") await writeMcpEntry(report);
      else await atomicReplaceFromStage(report.stagePath, report.targetPath, report.kind);
    } catch (error) {
      throw operationalError(`failed to write ${displayItem(report)}: ${String(error)}`, {
        cause: error,
      });
    }
  }
}

export async function run(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const args = parseArgs(argv);
  if (args.help) {
    stdout.write(HELP);
    return 0;
  }
  assertNode20();

  const paths = await resolveConfigPaths({ args, env, cwd, debugProbe: options.debugProbe });
  for (const warning of paths.warnings) stderr.write(`[WARN] ${warning}\n`);
  stdout.write(
    `[CHECK] source=${repoRoot} target=${paths.configDir} mode=${args.mode} ` +
      `ownership=manifest-items-only mcp=${args.skipMcp ? "skip" : paths.configFile}\n`,
  );
  if (args.skipMcp) stdout.write("[SKIP] mcp.flywheel (--skip-mcp)\n");
  const stageRoot = await mkdtemp(path.join(tmpdir(), "agent-flywheel-opencode-"));
  try {
    const rendered = await renderManagedTree({
      repoRoot,
      stageRoot,
      configFile: paths.configFile,
      skipMcp: args.skipMcp,
    });
    const reports = await compareRenderedItems(rendered.items, paths.configDir);
    printReports(reports, stdout);
    const drift = reports.filter((report) => !report.clean);

    if (args.mode === "check") {
      if (drift.length === 0) stdout.write("[OK] OpenCode port is in sync.\n");
      else stdout.write(`[DRIFT] ${drift.length} managed item(s) differ.\n`);
      return drift.length === 0 ? 0 : 1;
    }
    if (args.mode === "dry-run") {
      for (const report of drift) stdout.write(`[WRITE] ${displayItem(report)} (dry-run)\n`);
      if (drift.length === 0) stdout.write("[OK] OpenCode port is in sync; no writes proposed.\n");
      else stdout.write(`[DRIFT] ${drift.length} managed write(s) proposed.\n`);
      return drift.length === 0 ? 0 : 1;
    }

    await applyReports(reports, stdout);
    const verification = await compareRenderedItems(rendered.items, paths.configDir);
    printReports(verification, stdout);
    const remaining = verification.filter((report) => !report.clean);
    if (remaining.length > 0) {
      throw operationalError(
        `post-write re-check found ${remaining.length} drifting item(s): ${remaining
          .map(displayItem)
          .join(", ")}`,
      );
    }
    stdout.write("[OK] OpenCode port is in sync.\n");
    return 0;
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

async function main() {
  try {
    return await run();
  } catch (error) {
    const exitCode = error instanceof SyncError ? error.exitCode : 1;
    process.stderr.write(`[ERROR] ${error instanceof Error ? error.message : String(error)}\n`);
    return exitCode;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
