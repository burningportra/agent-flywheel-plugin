#!/usr/bin/env node
/**
 * version-sync.mjs — single command that aligns every version-bearing manifest
 * across the repo (context-mode pattern F; bead claude-orchestrator-32e).
 *
 * Usage
 * -----
 *   # Sync all manifests to mcp-server/package.json's current version:
 *   node scripts/version-sync.mjs
 *
 *   # Bump everything to a specific version:
 *   node scripts/version-sync.mjs --version 3.12.0
 *
 *   # Check-only (CI gate): exit 1 + diff report when any manifest drifts.
 *   node scripts/version-sync.mjs --check
 *
 *   # Sweep README badges as well (opt-in to avoid surprise diffs):
 *   node scripts/version-sync.mjs --readme
 *
 *   # Combine flags as needed: --version 3.12.0 --check --readme --config ./alt.json
 *
 * Exit codes
 * ----------
 *   0 — success (sync wrote no diff, or check found everything aligned)
 *   1 — drift found in --check mode, or write failed
 *   2 — bad argv / missing config
 *
 * The script is dependency-free (Node ≥ 22 built-ins only) so it can run
 * before `npm install` in CI. JSON files are written with the same indent
 * style they had on disk, preserving the trailing newline.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const DEFAULT_CONFIG = resolve(HERE, 'version-sync.config.json');
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

function parseArgs(argv) {
  const args = { version: null, check: false, readme: false, config: DEFAULT_CONFIG, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version' || a === '-v') {
      args.version = argv[++i] ?? null;
    } else if (a === '--check') {
      args.check = true;
    } else if (a === '--readme') {
      args.readme = true;
    } else if (a === '--config') {
      args.config = resolve(argv[++i] ?? '');
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else {
      console.error(`version-sync: unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const HELP = `version-sync — align every version-bearing manifest in this repo.

Usage: node scripts/version-sync.mjs [options]

Options:
  --version <semver>   Target version. Defaults to the source manifest's value.
  --check              Exit 1 + diff report when manifests are out of sync.
  --readme             Also sweep README files (best-effort regex; opt-in).
  --config <path>      Override config path (default: ${DEFAULT_CONFIG}).
  -h, --help           Show this help.
`;

function loadConfig(path) {
  if (!existsSync(path)) {
    console.error(`version-sync: config not found at ${path}`);
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`version-sync: invalid JSON in ${path}: ${err.message}`);
    process.exit(2);
  }
}

/** Read a JSON file, returning {raw, parsed, indent, trailingNewline}. */
function readJsonFile(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  const parsed = JSON.parse(raw);
  // Detect indent (2 vs 4 vs tab) from the second line; fall back to 2.
  const m = raw.match(/\n([ \t]+)/);
  const indent = m ? (m[1].includes('\t') ? '\t' : m[1].length) : 2;
  const trailingNewline = raw.endsWith('\n');
  return { raw, parsed, indent, trailingNewline };
}

function writeJsonFile(absPath, parsed, indent, trailingNewline) {
  const out = JSON.stringify(parsed, null, indent) + (trailingNewline ? '\n' : '');
  writeFileSync(absPath, out, 'utf8');
}

/**
 * Resolve a manifest descriptor to {absPath, currentVersion, exists}.
 * Optional manifests with no version key (e.g. marketplace.json today)
 * still load — they just have currentVersion === null.
 */
function inspectManifest(descriptor) {
  const absPath = resolve(REPO_ROOT, descriptor.path);
  if (!existsSync(absPath)) {
    if (descriptor.optional) return { absPath, exists: false, currentVersion: null };
    return { absPath, exists: false, currentVersion: null, missing: true };
  }
  const file = readJsonFile(absPath);
  const currentVersion =
    typeof file.parsed.version === 'string' ? file.parsed.version : null;
  return { absPath, exists: true, currentVersion, file };
}

/**
 * Sweep README files for version-string patterns and return {edits, writes}
 * (writes only happens when not in check mode).
 */
function sweepReadme(descriptor, targetVersion, { check }) {
  const absPath = resolve(REPO_ROOT, descriptor.path);
  if (!existsSync(absPath)) return { changed: false, drift: [] };
  const raw = readFileSync(absPath, 'utf8');
  let next = raw;
  const drift = [];
  for (const pattern of descriptor.patterns ?? []) {
    const re = new RegExp(pattern, 'g');
    next = next.replace(re, (match, prefix) => {
      if (match === `${prefix}${targetVersion}`) return match;
      drift.push({ pattern, was: match, will: `${prefix}${targetVersion}` });
      return `${prefix}${targetVersion}`;
    });
  }
  if (next !== raw && !check) writeFileSync(absPath, next, 'utf8');
  return { changed: next !== raw, drift };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const config = loadConfig(args.config);
  const manifests = config.manifests ?? [];
  const sourceDescriptor = manifests.find((m) => m.isSource);
  if (!sourceDescriptor) {
    console.error('version-sync: config has no manifest with `isSource: true`');
    process.exit(2);
  }

  const sourceState = inspectManifest(sourceDescriptor);
  if (!sourceState.exists) {
    console.error(`version-sync: source manifest missing at ${sourceState.absPath}`);
    process.exit(2);
  }

  const targetVersion = args.version ?? sourceState.currentVersion;
  if (!targetVersion) {
    console.error('version-sync: no target version (source has no `version` and --version not passed)');
    process.exit(2);
  }
  if (!SEMVER_RE.test(targetVersion)) {
    console.error(`version-sync: target "${targetVersion}" is not a valid semver string`);
    process.exit(2);
  }

  const drifts = [];
  const writes = [];
  const skipped = [];

  for (const desc of manifests) {
    const state = inspectManifest(desc);
    if (state.missing) {
      drifts.push({ path: desc.path, reason: `missing required manifest (${state.absPath})` });
      continue;
    }
    if (!state.exists) {
      skipped.push({ path: desc.path, reason: 'optional, not present' });
      continue;
    }
    if (state.currentVersion === null) {
      // Manifest has no `version` key (e.g. marketplace.json). Skip.
      skipped.push({ path: desc.path, reason: 'no `version` field — skipping' });
      continue;
    }
    if (state.currentVersion === targetVersion) continue;

    drifts.push({
      path: desc.path,
      from: state.currentVersion,
      to: targetVersion,
    });
    if (!args.check) {
      state.file.parsed.version = targetVersion;
      writeJsonFile(state.absPath, state.file.parsed, state.file.indent, state.file.trailingNewline);
      writes.push(desc.path);
    }
  }

  // README sweep (opt-in).
  if (args.readme) {
    for (const r of config.readme ?? []) {
      const result = sweepReadme(r, targetVersion, { check: args.check });
      if (result.changed) {
        drifts.push({ path: r.path, readme: true, edits: result.drift });
        if (!args.check) writes.push(r.path);
      }
    }
  }

  if (args.check) {
    if (drifts.length === 0) {
      // Silent on success per --check spec.
      process.exit(0);
    }
    console.error(`version-sync: drift detected (target ${targetVersion}):`);
    for (const d of drifts) {
      if (d.reason) console.error(`  - ${d.path}: ${d.reason}`);
      else if (d.readme) console.error(`  - ${d.path}: README badge drift (${d.edits.length} edits)`);
      else console.error(`  - ${d.path}: ${d.from} → ${d.to}`);
    }
    process.exit(1);
  }

  if (drifts.length === 0) {
    console.log(`version-sync: all manifests aligned at ${targetVersion} (no changes).`);
  } else {
    console.log(`version-sync: aligned ${writes.length} manifest(s) to ${targetVersion}:`);
    for (const w of writes) console.log(`  ✓ ${w}`);
    if (skipped.length > 0) {
      console.log('skipped:');
      for (const s of skipped) console.log(`  - ${s.path}: ${s.reason}`);
    }
  }
}

main();
