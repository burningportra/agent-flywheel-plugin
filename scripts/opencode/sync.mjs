#!/usr/bin/env node

/**
 * Render the repository-owned OpenCode integration into an exact, private
 * staging tree, then check, preview, or apply the owned subset only.
 */

import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  formatCompatibilityReport,
  loadCompatibilityPolicy,
  loadManifest,
  validateCompatibilityItems,
  validateManifest,
} from "./validate.mjs";
import { applyTransformProfile, deriveMcpEntry } from "./transforms.mjs";
import { parseJsonc, setMcpFlywheelEntry } from "./jsonc.mjs";
import {
  acquireLock,
  hashPath,
  readLedger,
  recoverState,
  releaseLock,
  runTransaction,
  stateDirFor,
} from "./apply.mjs";

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

  // An explicitly named config file (flag or env) is a promise to merge into
  // that exact document; a missing one is an error, not a create-from-scratch.
  const explicitConfigFile = selectedConfigFile !== undefined;

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
    explicitConfigFile,
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
      const location = finding.path ?? finding.command ?? finding.name ?? finding.from;
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
  const { repoRoot, stageRoot, configFile, skipMcp, explicitConfigFile = false } = options;
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

  const compatibilityPolicyPath = path.join(repoRoot, "opencode", "compatibility.json");
  const compatibilityPolicy = await loadCompatibilityPolicy(compatibilityPolicyPath).catch((error) => {
    throw operationalError(String(error), { cause: error });
  });
  const compatibility = await validateCompatibilityItems(items, compatibilityPolicy).catch((error) => {
    throw operationalError(`rendered stage compatibility validator failed: ${String(error)}`, {
      cause: error,
    });
  });

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
    // A user-named config file must already exist: the JSONC-preserving merge
    // works on real bytes, and fabricating a document at an explicit path would
    // be surprising. This throws during render, before any managed write.
    if (explicitConfigFile && !(await exists(configFile))) {
      throw prerequisiteError(`selected OpenCode config file is missing: ${configFile}`);
    }
    mcpItem = {
      id: `mcp:${configKey}`,
      kind: "mcp",
      target: configFile,
      displayTarget: `${configFile}#mcp.${configKey}`,
      configKey,
      expectedEntry,
      requireExisting: Boolean(explicitConfigFile),
    };
    items.push(mcpItem);
  }

  return { manifest, items, mcpItem, compatibility };
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

/**
 * Read a config file for comparison only. JSONC-tolerant (comments + trailing
 * commas) so drift detection works on `opencode.jsonc`. Error messages carry the
 * file path and a position-only parse reason but never echo file contents, since
 * provider secrets live in this document.
 */
async function readConfigForCompare(configFile) {
  let raw;
  try {
    raw = await readFile(configFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { value: {}, exists: false };
    throw operationalError(`cannot read OpenCode config ${configFile}: ${String(error)}`, { cause: error });
  }
  let value;
  try {
    value = parseJsonc(raw, { path: configFile });
  } catch (error) {
    throw operationalError(
      `OpenCode config is not valid JSON/JSONC: ${error instanceof Error ? error.message : `parse error in ${configFile}`}`,
      { cause: error },
    );
  }
  if (!isObject(value)) throw operationalError(`OpenCode config root must be an object: ${configFile}`);
  return { value, exists: true };
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
    const config = await readConfigForCompare(item.target);
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

/**
 * Guard against a config path that resolves outside its own config directory
 * (e.g. a symlink pointing at /etc). Resolves realpaths and asserts containment;
 * absent dir/file is fine (a fresh write lands directly under the config dir).
 */
async function assertRealpathContained(configDir, configFile) {
  let realDir;
  try {
    realDir = await realpath(configDir);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  let realFile;
  try {
    realFile = await realpath(configFile);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (realFile !== realDir && !realFile.startsWith(`${realDir}${path.sep}`)) {
    throw prerequisiteError(
      `refusing to write ${configFile}: resolved path escapes config dir ${realDir}`,
    );
  }
}

/**
 * Merge the derived MCP entry into the user's config as `mcp.<configKey>`,
 * preserving every other byte of an existing document (comments, trailing
 * commas, key order, unrelated keys, and secrets). An existing file is edited
 * via the pinned JSONC editor; a missing *default* `opencode.json` is created
 * from a minimal document. Never falls back to a whole-document rewrite.
 */
async function writeMcpEntry(item) {
  const configFile = item.target;
  const configDir = path.dirname(configFile);

  let originalBytes = null;
  let mode = 0o644;
  try {
    originalBytes = await readFile(configFile);
    const fileStat = await stat(configFile);
    mode = fileStat.mode & 0o777;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw operationalError(`cannot read OpenCode config ${configFile}: ${String(error)}`, {
        cause: error,
      });
    }
  }

  let nextText;
  if (originalBytes === null) {
    // Only reachable for the default opencode.json (explicit missing files are
    // rejected during render). Nothing to preserve, so a minimal doc is safe.
    if (item.requireExisting) {
      throw prerequisiteError(`selected OpenCode config file is missing: ${configFile}`);
    }
    nextText = `${JSON.stringify({ mcp: { [item.configKey]: item.expectedEntry } }, null, 2)}\n`;
  } else {
    // Targeted JSONC edit: changes only the mcp.<configKey> subtree.
    nextText = setMcpFlywheelEntry(originalBytes.toString("utf8"), item.configKey, item.expectedEntry, {
      path: configFile,
    });
  }

  // Verify the edited document parses and carries exactly the expected entry
  // BEFORE anything is renamed into place. A failure here aborts without a write.
  let verified;
  try {
    verified = parseJsonc(nextText, { path: configFile });
  } catch (error) {
    throw operationalError(
      `refusing to write ${configFile}: edited document does not parse (${error instanceof Error ? error.message : "parse error"})`,
      { cause: error },
    );
  }
  if (canonicalJson(verified?.mcp?.[item.configKey]) !== canonicalJson(item.expectedEntry)) {
    throw operationalError(`refusing to write ${configFile}: mcp.${item.configKey} did not update as expected`);
  }

  await assertRealpathContained(configDir, configFile);
  await mkdir(configDir, { recursive: true });
  const holder = await mkdtemp(path.join(configDir, ".flywheel-config-"));
  const stagedConfig = path.join(holder, path.basename(configFile));
  try {
    await writeFile(stagedConfig, nextText, { flag: "wx" });
    await chmod(stagedConfig, mode);
    await atomicReplaceFromStage(stagedConfig, configFile, "file");
  } finally {
    await rm(holder, { recursive: true, force: true }).catch(() => {});
  }
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Ledger key for an owned item: the config subtree for mcp, else the rel path. */
function ledgerKeyOf(report) {
  return report.kind === "mcp" ? `mcp:${report.configKey}` : normalizeTarget(report.target);
}

/** The rendered ("source") hash that will be recorded in the ledger post-apply. */
async function sourceHashOf(report) {
  if (report.kind === "mcp") return sha256Hex(canonicalJson(report.expectedEntry));
  return hashPath(report.stagePath);
}

/** The live hash of the installed target (null when absent). */
async function liveHashOf(report, configDir) {
  if (report.kind === "mcp") {
    const config = await readConfigForCompare(report.target);
    const live = isObject(config.value.mcp) ? config.value.mcp[report.configKey] : undefined;
    return live === undefined ? null : sha256Hex(canonicalJson(live));
  }
  const targetPath = report.targetPath ?? resolveContained(configDir, report.target, `${report.id} target`);
  return hashPath(targetPath);
}

/**
 * Build the transactional plan from compared reports plus a full desired-ledger
 * snapshot. Drifting items become ops labelled `WRITE` (clean install/upgrade of
 * a path we own per the ledger) or `LOCAL` (the live bytes diverge from what we
 * installed, or predate the ledger — back up before overwrite, never silent).
 */
async function classifyAndPlan(reports, configDir) {
  const stateDir = stateDirFor(configDir);
  const ledger = await readLedger(stateDir);
  const desiredLedger = {};
  const ops = [];
  for (const report of reports) {
    const key = ledgerKeyOf(report);
    const type = report.kind === "mcp" ? "mcp" : report.kind;
    const sourceHash = await sourceHashOf(report);
    desiredLedger[key] = { type, hash: sourceHash };
    if (report.clean) continue;

    const liveHash = await liveHashOf(report, configDir);
    const ledgerHash = ledger.entries?.[key]?.hash;
    const targetExists = liveHash !== null && liveHash !== undefined;
    let label;
    if (!targetExists) label = "WRITE";
    else if (ledgerHash !== undefined && liveHash === ledgerHash) label = "WRITE";
    else label = "LOCAL";

    ops.push({
      kind: report.kind,
      target:
        report.kind === "mcp"
          ? report.target
          : resolveContained(configDir, report.target, `${report.id} target`),
      relTarget:
        report.kind === "mcp" ? path.basename(report.target) : normalizeTarget(report.target),
      stageSource: report.kind === "mcp" ? null : report.stagePath,
      ledgerKey: key,
      newHash: sourceHash,
      type,
      label,
      displayTarget: displayItem(report),
      writeMcp: report.kind === "mcp" ? () => writeMcpEntry(report) : null,
    });
  }
  return { ops, desiredLedger };
}

/**
 * Best-effort, bounded runtime verification of the installed MCP server. A hung
 * or missing runtime classifies `runtime_unverified` and reports red on the
 * runtime line, but NEVER rolls back an already-committed filesystem apply.
 */
function verifyRuntimeReal() {
  const result = spawnSync("opencode", ["mcp", "list"], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    const reason =
      result.error.code === "ETIMEDOUT"
        ? "opencode mcp list timed out after 15s"
        : `opencode runtime unavailable: ${result.error.message}`;
    return { checked: true, ok: false, reason };
  }
  if (result.status !== 0) {
    return { checked: true, ok: false, reason: `opencode mcp list exited ${String(result.status)}` };
  }
  return { checked: true, ok: true };
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

  const isWrite = args.mode === "write";
  const stateDir = stateDirFor(paths.configDir);
  const ownerPid = Number.parseInt(env.FW_SYNC_PID ?? "", 10) || process.pid;
  const startedAt = new Date().toISOString();
  let lock = null;
  const stageRoot = await mkdtemp(path.join(tmpdir(), "agent-flywheel-opencode-"));
  try {
    if (isWrite) {
      // Single-writer lock + startup recovery run BEFORE any render, so an
      // abandoned transaction is repaired against the live tree first.
      lock = await acquireLock(stateDir, { output: stdout, ownerPid, startedAt });
      await recoverState(stateDir, { output: stdout });
    }
    const rendered = await renderManagedTree({
      repoRoot,
      stageRoot,
      configFile: paths.configFile,
      skipMcp: args.skipMcp,
      explicitConfigFile: paths.explicitConfigFile,
    });
    stdout.write(formatCompatibilityReport(rendered.compatibility));
    if (!rendered.compatibility.ok) {
      throw operationalError(
        `rendered stage compatibility validator reported ${rendered.compatibility.findings.length} ` +
          `finding(s):\n  ${formatFindings(rendered.compatibility.findings)}`,
      );
    }
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

    const { ops, desiredLedger } = await classifyAndPlan(reports, paths.configDir);
    await runTransaction({ stateDir, ops, desiredLedger, ownerPid, startedAt, output: stdout, env });

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

    // Bounded, non-fatal runtime verification (production only; tests that inject
    // debugProbe/runtimeProbe opt out to avoid spawning the real opencode CLI).
    let runtime = { checked: false, ok: true };
    if (typeof options.runtimeProbe === "function") runtime = options.runtimeProbe();
    else if (!options.debugProbe && !args.skipMcp) runtime = verifyRuntimeReal();
    if (runtime.checked && !runtime.ok) {
      stdout.write(`[runtime] runtime_unverified: ${runtime.reason}\n`);
    } else if (runtime.checked) {
      stdout.write("[runtime] ok\n");
    }

    stdout.write("[OK] OpenCode port is in sync.\n");
    return 0;
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
    if (lock) await releaseLock(lock);
  }
}

async function main() {
  try {
    return await run();
  } catch (error) {
    const exitCode = typeof error?.exitCode === "number" ? error.exitCode : 1;
    process.stderr.write(`[ERROR] ${error instanceof Error ? error.message : String(error)}\n`);
    return exitCode;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
