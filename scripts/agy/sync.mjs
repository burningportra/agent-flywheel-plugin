#!/usr/bin/env node

/**
 * AGY mirror sync engine (bead agent-flywheel-plugin-dm1).
 *
 * Renders the manifest-owned subset of this repository into an Antigravity
 * plugin directory, diffs it against the last sync state (SHA-256 in
 * <target>/.sync-state.json), and checks, writes, or prunes:
 *
 *   [OK]     disk matches the rendered bytes
 *   [ADD]    rendered, missing on disk
 *   [UPDATE] disk matches the last written hash, source has moved on
 *   [LOCAL]  disk matches neither — hand-edited divergence, backed up first
 *   [PRUNE]  written by a previous sync, no longer rendered
 *
 * The repository is the source of truth; the installed plugin is a derived
 * artifact. Modes: --check (default, exit 1 on drift), --write, --prune.
 */

import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { emitHooks } from "./emit-hooks.mjs";
import { rewriteBody, rewriteCommand } from "./rewrite-body.mjs";
import { runAgyValidate, sha256Text, validatePlugin } from "./validate.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = path.resolve(MODULE_DIR, "..", "..");
const STATE_FILE = ".sync-state.json";
const STATE_VERSION = 1;

/** AGY loads only the first 24,000 bytes of a skill body; stay under it. */
const SKILL_BODY_MARGIN_BYTES = 500;

function stubOverCapSkillBody(rendered, { skillName, capBytes, actualBytes }) {
  const frontmatter = rendered.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const header = frontmatter ? frontmatter[0] : "";
  const notice = [
    "> [!IMPORTANT]",
    `> This skill's canonical body is ${actualBytes} bytes; AGY loads only the`,
    `> first ${capBytes} bytes of a skill body, so this mirror ships a stub instead of a`,
    `> silently truncated copy. Load the full body through the flywheel MCP server:`,
    `> flywheel_get_skill({ name: "agent-flywheel:${skillName}" })`,
    "> Sub-files the body references sit next to this SKILL.md; read_file them",
    "> directly when needed.",
    "",
  ].join("\n");
  return header + notice;
}

const HELP = `Usage: scripts/sync-agy.sh [mode] [options]

Render the agent-flywheel Antigravity (AGY) mirror from repository sources.

Modes (choose exactly one):
  --check       Report managed drift; exit 1 when anything is not [OK] (default).
  --write       Apply managed writes (backing up [LOCAL] divergences), then re-check.
  --prune       Delete files a previous sync wrote that are no longer rendered.

Options:
  --target <path>      Plugin directory (default: manifest target).
  --backup-dir <path>  Where [LOCAL] divergences are backed up on --write
                       (default: <target>/.agy-sync-backups/<timestamp>).
  --json               Machine-readable output instead of the human report.
  -h, --help           Show this help.

Ownership boundary:
  Only manifest-enumerated files are managed: plugin.json (+ .agy-plugin copy),
  mcp_config.json, hooks.json, hooks/*.sh|mjs, rules/AGENTS.md, logo.svg,
  skills/<name>/** and skills/cmd-<name>/SKILL.md. Anything else in the target
  is never an ownership target. Validation runs our own checks plus
  \`agy plugin validate <target> --strict --json\` when agy is on PATH.

Exit codes:
  0  clean, or write/prune completed and the re-check is clean
  1  drift, pending writes, or validation findings
  2  invalid usage or a missing prerequisite
`;

class SyncError extends Error {
  constructor(message, exitCode = 1, options) {
    super(message, options);
    this.name = "SyncError";
    this.exitCode = exitCode;
  }
}

const usageError = (message) => new SyncError(`${message}\nRun with --help for usage.`, 2);

export function parseArgs(argv) {
  const parsed = {
    mode: "check",
    modeExplicit: false,
    target: undefined,
    backupDir: undefined,
    json: false,
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
    else if (arg === "--write") setMode("write");
    else if (arg === "--prune") setMode("prune");
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--target" || arg === "--backup-dir") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw usageError(`${arg} requires a path argument`);
      }
      index += 1;
      if (arg === "--target") parsed.target = value;
      else parsed.backupDir = value;
    } else {
      throw usageError(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

/** True when relPath resolves inside base (no `..` escape, no absolutes). */
function isRelPathUnder(base, relPath) {
  if (typeof relPath !== "string" || relPath === "" || path.isAbsolute(relPath)) return false;
  const resolved = path.resolve(base, relPath);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

async function readTextFile(absPath, label) {
  try {
    return await readFile(absPath, "utf8");
  } catch (err) {
    throw new SyncError(`cannot read ${label} (${absPath}): ${err.message}`, 2);
  }
}

async function walkFiles(absDir, relPrefix = "") {
  const out = [];
  const entries = await readdir(absDir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(path.join(absDir, entry.name), rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

// ─── Inventory cross-check ────────────────────────────────────────────────

async function crossCheckInventory(repoRoot, manifest) {
  const findings = [];
  const discovery = manifest.discovery ?? {};
  const skillPattern = new RegExp(discovery.skillDirPattern ?? "^(flywheel-.+|start)$");
  const commandPattern = new RegExp(discovery.commandFilePattern ?? "^(flywheel-.+|start)\\.md$");
  const skillsRoot = discovery.skillsRoot ?? "skills";
  const commandsRoot = discovery.commandsRoot ?? "commands";

  const diskSkillDirs = new Set();
  for (const entry of await readdir(path.join(repoRoot, skillsRoot), { withFileTypes: true })) {
    if (entry.isDirectory() && skillPattern.test(entry.name)) {
      try {
        await stat(path.join(repoRoot, skillsRoot, entry.name, "SKILL.md"));
        diskSkillDirs.add(entry.name);
      } catch {
        // matches the pattern but has no SKILL.md — not a managed skill dir
      }
    }
  }
  const diskCommands = new Set(
    (await readdir(path.join(repoRoot, commandsRoot)))
      .filter((name) => commandPattern.test(name))
      .map((name) => name.replace(/\.md$/, "")),
  );

  const manifestSkills = new Set((manifest.skills ?? []).map((s) => s.name));
  const manifestCommands = new Set((manifest.commands ?? []).map((c) => c.name));
  for (const name of diskSkillDirs) {
    if (!manifestSkills.has(name)) {
      findings.push(`inventory_unclassified: skills/${name}/ matches the discovery pattern but is not in agy/manifest.json`);
    }
  }
  for (const name of manifestSkills) {
    if (!diskSkillDirs.has(name)) {
      findings.push(`inventory_missing: agy/manifest.json lists skill "${name}" but skills/${name}/SKILL.md does not exist`);
    }
  }
  for (const name of diskCommands) {
    if (!manifestCommands.has(name)) {
      findings.push(`inventory_unclassified: commands/${name}.md matches the discovery pattern but is not in agy/manifest.json`);
    }
  }
  for (const name of manifestCommands) {
    if (!diskCommands.has(name)) {
      findings.push(`inventory_missing: agy/manifest.json lists command "${name}" but commands/${name}.md does not exist`);
    }
  }
  return findings;
}

// ─── Render ───────────────────────────────────────────────────────────────

/**
 * Render every managed file into an ordered map relPath -> {content, executable}.
 */
export async function renderPlugin(repoRoot, manifest) {
  const files = new Map();
  const put = (relPath, content, executable = false) => {
    files.set(relPath, { content, executable });
  };

  // plugin.json — exactly the 7-field schema, plus the .agy-plugin mirror copy.
  const pluginJsonText = await readTextFile(
    path.join(repoRoot, manifest.pluginJson?.source ?? "agy/plugin.json"),
    "plugin.json source",
  );
  const pluginJsonNormalized = `${JSON.stringify(JSON.parse(pluginJsonText), null, 2)}\n`;
  put(manifest.pluginJson?.target ?? "plugin.json", pluginJsonNormalized);
  const mirrorCopy = manifest.pluginJson?.mirrorCopy ?? ".agy-plugin/plugin.json";
  if (mirrorCopy) put(mirrorCopy, pluginJsonNormalized);

  // mcp_config.json — AGY's file name, with ${PLUGIN_ROOT} resolved to the repo.
  const mcpSource = await readTextFile(
    path.join(repoRoot, manifest.mcp?.source ?? "agy/.mcp.json"),
    "mcp source",
  );
  const rootToken = manifest.mcp?.rootToken ?? "${PLUGIN_ROOT}";
  const mcpRendered = mcpSource.split(rootToken).join(repoRoot);
  let mcpParsed;
  try {
    mcpParsed = JSON.parse(mcpRendered);
  } catch (err) {
    throw new SyncError(`rendered mcp config is not valid JSON: ${err.message}`, 1);
  }
  if (!mcpParsed.mcpServers || !mcpParsed.mcpServers[manifest.mcp?.serverName ?? "agent-flywheel"]) {
    throw new SyncError(
      `rendered mcp config has no mcpServers.${manifest.mcp?.serverName ?? "agent-flywheel"} entry`,
      1,
    );
  }
  put(manifest.mcp?.target ?? "mcp_config.json", `${JSON.stringify(mcpParsed, null, 2)}\n`);

  // Hooks — translated table + wrapper scripts.
  const claudeHooksText = await readTextFile(
    path.join(repoRoot, "hooks", "hooks.json"),
    "hooks/hooks.json",
  );
  let claudeHooks;
  try {
    claudeHooks = JSON.parse(claudeHooksText);
  } catch (err) {
    throw new SyncError(`hooks/hooks.json is not valid JSON: ${err.message}`, 2);
  }
  const emitted = emitHooks(claudeHooks, { repoRoot });
  put("hooks.json", emitted.hooksJsonText);
  for (const [relPath, entry] of Object.entries(emitted.files)) {
    put(relPath, entry.content, entry.executable === true);
  }

  // Rules and logo.
  put(
    manifest.rules?.target ?? "rules/AGENTS.md",
    await readTextFile(path.join(repoRoot, manifest.rules?.source ?? "agy/rules/AGENTS.md"), "rules source"),
  );
  if (manifest.logo?.source) {
    put(
      manifest.logo.target ?? "logo.svg",
      await readTextFile(path.join(repoRoot, manifest.logo.source), "logo source"),
    );
  }

  // Managed skill dirs (markdown bodies rewritten, other files copied verbatim).
  const cappedSkills = [];
  const skillBodyCap = (manifest.skillBodyMaxBytes ?? 24_000) - SKILL_BODY_MARGIN_BYTES;
  for (const skill of manifest.skills ?? []) {
    const absDir = path.join(repoRoot, skill.source);
    let relFiles;
    try {
      relFiles = await walkFiles(absDir);
    } catch (err) {
      throw new SyncError(`cannot walk skill dir ${skill.source}: ${err.message}`, 2);
    }
    for (const rel of relFiles) {
      const raw = await readTextFile(path.join(absDir, rel), `${skill.source}/${rel}`);
      const targetDirName = skill.target.replace(/\/$/, "");
      const targetRel = `${targetDirName}/${rel}`;
      if (rel.toLowerCase() !== "skill.md" && !rel.endsWith(".md")) {
        put(targetRel, raw);
        continue;
      }
      let rendered = rewriteBody(raw, { repoRoot, sourcePath: `${skill.source}/${rel}` });
      if (rel.toLowerCase() === "skill.md") {
        const size = Buffer.byteLength(rendered, "utf8");
        if (size > skillBodyCap) {
          rendered = stubOverCapSkillBody(rendered, {
            skillName: skill.name,
            capBytes: manifest.skillBodyMaxBytes ?? 24_000,
            actualBytes: size,
          });
          cappedSkills.push(`${skill.source} (${size} bytes)`);
        }
      }
      put(targetRel, rendered);
    }
  }

  // Managed commands -> skills/cmd-<name>/SKILL.md.
  for (const command of manifest.commands ?? []) {
    const raw = await readTextFile(path.join(repoRoot, command.source), command.source);
    put(
      command.target,
      rewriteCommand(raw, { repoRoot, name: command.name, sourcePath: command.source }),
    );
  }

  return { files, unsupportedHooks: emitted.unsupported, cappedSkills };
}

// ─── State and diff ───────────────────────────────────────────────────────

async function loadState(targetDir) {
  try {
    const raw = await readFile(path.join(targetDir, STATE_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.version !== STATE_VERSION || typeof parsed.files !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readDisk(targetDir, relPath) {
  try {
    return await readFile(path.join(targetDir, relPath), "utf8");
  } catch {
    return null;
  }
}

async function computeStatuses(targetDir, rendered) {
  const state = await loadState(targetDir);
  const stateFiles = state?.files ?? {};
  const rows = [];
  for (const [relPath, entry] of rendered) {
    const renderedSha = sha256Text(entry.content);
    const disk = await readDisk(targetDir, relPath);
    const stateSha = stateFiles[relPath]?.sha;
    let status;
    if (disk === null) status = "ADD";
    else if (sha256Text(disk) === renderedSha) status = "OK";
    else if (stateSha && sha256Text(disk) === stateSha) status = "UPDATE";
    else status = "LOCAL";
    rows.push({ path: relPath, status, sha: renderedSha, executable: entry.executable });
  }
  // The state file is on-disk input: never treat entries that escape the
  // target directory as prunable (or deletable) paths.
  const pruned = Object.keys(stateFiles)
    .filter((relPath) => !rendered.has(relPath))
    .filter((relPath) => isRelPathUnder(targetDir, relPath))
    .sort();
  return { rows, pruned, state };
}

function summaryOf(rows, pruned) {
  const summary = { ok: 0, add: 0, update: 0, local: 0, prune: pruned.length, total: rows.length };
  for (const row of rows) summary[row.status.toLowerCase()] += 1;
  return summary;
}

async function writeAtomic(absPath, content, mode = 0o644) {
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, { mode });
  await rename(tmp, absPath);
}

// ─── Main ─────────────────────────────────────────────────────────────────

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return { exitCode: 0, help: true };
  }

  const repoRoot = DEFAULT_REPO_ROOT;
  const manifestPath = path.join(repoRoot, "agy", "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (err) {
    throw new SyncError(`cannot load agy/manifest.json: ${err.message}`, 2);
  }
  if (manifest.schemaVersion !== 1) {
    throw new SyncError(`unsupported manifest schemaVersion: ${manifest.schemaVersion}`, 2);
  }

  const targetDir = path.resolve(expandHome(args.target ?? manifest.target ?? ""));

  const inventoryFindings = await crossCheckInventory(repoRoot, manifest);
  const { files: rendered, unsupportedHooks, cappedSkills } = await renderPlugin(repoRoot, manifest);

  // Every untranslated source hook must have an explicit manifest entry.
  const manifestHooks = manifest.hooks ?? [];
  const manifestUnsupported = manifestHooks.filter((h) => h && h.portable === false);
  const hookCoverageFindings = unsupportedHooks
    .filter((unsupported) => !manifestUnsupported.some((entry) => entry.source?.event === unsupported.event))
    .map((unsupported) => ({
      severity: "error",
      file: "agy/manifest.json",
      message: `source hook event ${unsupported.event} is not translated and has no portable:false manifest entry`,
    }));
  const { rows, pruned } = await computeStatuses(targetDir, rendered);
  const summary = summaryOf(rows, pruned);
  const internalValidation = validatePlugin({ files: rendered, manifest });

  const findings = [
    ...inventoryFindings.map((message) => ({ severity: "error", file: "agy/manifest.json", message })),
    ...hookCoverageFindings,
    ...internalValidation.findings,
  ];

  let backups = [];
  let wrote = [];
  let deleted = [];

  if (args.mode === "write") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = args.backupDir
      ? path.resolve(expandHome(args.backupDir))
      : path.join(targetDir, ".agy-sync-backups", stamp);
    let needsBackup = false;
    for (const row of rows) {
      if (row.status === "LOCAL") needsBackup = true;
    }
    if (needsBackup) await mkdir(backupDir, { recursive: true });
    for (const row of rows) {
      if (row.status === "OK") continue;
      const absPath = path.join(targetDir, row.path);
      if (row.status === "LOCAL") {
        const backupPath = path.join(backupDir, row.path);
        await mkdir(path.dirname(backupPath), { recursive: true });
        await writeFile(backupPath, await readDisk(targetDir, row.path) ?? "");
        backups.push(path.relative(targetDir, backupPath));
      }
      await mkdir(path.dirname(absPath), { recursive: true });
      const entry = rendered.get(row.path);
      await writeAtomic(absPath, entry.content, entry.executable ? 0o755 : 0o644);
      wrote.push(row.path);
    }
    const state = {
      version: STATE_VERSION,
      generatedAt: new Date().toISOString(),
      repoRoot,
      files: Object.fromEntries(
        rows.map((row) => [row.path, { sha: row.sha, executable: row.executable }]),
      ),
    };
    await mkdir(targetDir, { recursive: true });
    await writeAtomic(path.join(targetDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
  }

  if (args.mode === "prune") {
    for (const relPath of pruned) {
      await rm(path.join(targetDir, relPath), { force: true });
      deleted.push(relPath);
    }
    // Rewrite the state without the pruned entries so the re-check is clean.
    const priorState = (await loadState(targetDir)) ?? { version: STATE_VERSION, files: {} };
    const nextState = {
      version: STATE_VERSION,
      generatedAt: new Date().toISOString(),
      repoRoot,
      files: Object.fromEntries(
        Object.entries(priorState.files ?? {}).filter(([relPath]) => !pruned.includes(relPath)),
      ),
    };
    await mkdir(targetDir, { recursive: true });
    await writeAtomic(path.join(targetDir, STATE_FILE), `${JSON.stringify(nextState, null, 2)}\n`);
  }

  // Host oracle on the on-disk target (check after write, or the live target).
  const targetExists = await stat(targetDir).then(() => true, () => false);
  const agyResult =
    args.mode !== "prune" && targetExists
      ? runAgyValidate(targetDir)
      : {
          ran: false,
          findings: [],
          raw:
            args.mode === "prune"
              ? "agy validate: skipped (prune mode)"
              : "agy validate: skipped (target directory does not exist)",
        };
  if (agyResult.ran) {
    for (const finding of agyResult.findings) {
      findings.push({ severity: finding.severity, file: finding.file, message: `agy: ${finding.message}` });
    }
  }

  // Re-check after write/prune: everything must be OK for exit 0.
  const recheck = args.mode === "check"
    ? { rows, pruned }
    : await computeStatuses(targetDir, rendered);
  const recheckSummary = summaryOf(recheck.rows, recheck.pruned);
  const drift =
    recheckSummary.add + recheckSummary.update + recheckSummary.local + recheckSummary.prune;
  const hasErrors = findings.some((f) => f.severity === "error" || f.severity === "warning");
  const exitCode = drift > 0 || hasErrors ? 1 : 0;

  const skillCount = (manifest.skills ?? []).length + (manifest.commands ?? []).length;
  if (!args.json) {
    for (const row of recheck.rows) {
      if (row.status !== "OK" || args.mode === "write") {
        process.stdout.write(`[${row.status}] ${row.path}\n`);
      }
    }
    for (const relPath of recheck.pruned) process.stdout.write(`[PRUNE] ${relPath}\n`);
    for (const finding of findings) {
      process.stdout.write(`[FINDING:${finding.severity}] ${finding.file}: ${finding.message}\n`);
    }
    for (const backup of backups) process.stdout.write(`[BACKUP] ${backup}\n`);
    const state = drift === 0 && !hasErrors ? "clean" : args.mode === "write" ? "written with findings" : "drift";
    process.stdout.write(
      `sync-agy: ${state} · ${skillCount} skills · ` +
        `${manifestHooks.filter((h) => h.portable).length} hooks ` +
        `(${manifestUnsupported.length} unsupported) · ` +
        `${cappedSkills.length} body-capped · ` +
        `${agyResult.ran ? `agy validate ${agyResult.ok && exitCode === 0 ? "ok" : "failed"} (agy ${agyResult.version})` : agyResult.raw}\n`,
    );
    if (drift > 0 && args.mode === "check") {
      process.stdout.write(`run scripts/sync-agy.sh --write --target ${targetDir}\n`);
    }
  }

  return {
    exitCode,
    json: {
      mode: args.mode,
      target: targetDir,
      repoRoot,
      files: recheck.rows.map(({ path: p, status, sha }) => ({ path: p, status, sha })),
      pruned: recheck.pruned,
      wrote,
      deleted,
      backups,
      summary: recheckSummary,
      unsupportedHooks,
      cappedSkills,
      validation: {
        internal: internalValidation.findings,
        agy: agyResult.ran
          ? { ran: true, version: agyResult.version, ok: agyResult.ok, findings: agyResult.findings }
          : { ran: false, note: agyResult.raw },
      },
    },
  };
}

export async function run(argv) {
  let result;
  try {
    result = await main(argv);
    if (result?.help) return result.exitCode;
    if (argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result.json, null, 2)}\n`);
    }
    return result.exitCode;
  } catch (err) {
    if (err instanceof SyncError) {
      process.stderr.write(`sync-agy: ${err.message}\n`);
      return err.exitCode;
    }
    process.stderr.write(`sync-agy: unexpected failure: ${err?.stack ?? err}\n`);
    return 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  process.exit(await run(process.argv.slice(2)));
}
