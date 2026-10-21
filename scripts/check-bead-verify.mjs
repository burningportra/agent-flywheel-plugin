#!/usr/bin/env node
// check-bead-verify: validate the Plan Verification Triad
// (Verify, unit / Verify, live / Verify, perf) on Flywheel plan markdown
// files (#### Bead sections) and/or open beads.
//
// Usage:
//   node scripts/check-bead-verify.mjs [files...] [--strict] [--json]
//   With no files: validates open (non-closed) beads via `br list --json`.
//
// A lane is an error when its `- **Verify, <lane>**:` line is missing or
// empty; a warning when present but with no real runnable command
// (prose-only or TODO/TBD/... placeholder). --strict promotes warnings
// to errors. --json prints the machine-readable report on stdout.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const LANES = ["unit", "live", "perf"];
const RUNNABLE = /^(npm|node|npx|bash|sh|cd|git|br|bv|bun|tsx|python3?|uv|cargo|make|ntm|am|agy|claude|codex|pi\s|flywheel_|curl|jq|gh|docker|tsc|vitest|eslint)\b/;
const PLACEHOLDER = /TODO|TBD|FIXME|\.\.\.|<[^>]+>|XXX/i;
const BEAD_H = /^####\s+Bead\s+(.+)$/;
const VERIFY_RE = /^-\s+\*\*Verify,\s*(unit|live|perf)\*\*:\s*(.*)$/;

function checkBead(title, text) {
  const lines = text.split(/\r?\n/);
  const found = { unit: null, live: null, perf: null };
  for (const line of lines) {
    const m = VERIFY_RE.exec(line.trim());
    if (m && found[m[1]] === null) found[m[1]] = m[2].trim();
  }
  const errors = [];
  const warnings = [];
  const commands = {};
  for (const lane of LANES) {
    const raw = found[lane];
    if (raw === null || raw === "") {
      errors.push(`missing Verify, ${lane}`);
      continue;
    }
    const spans = [...raw.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
    const cmd = spans.find((s) => RUNNABLE.test(s)) ?? null;
    commands[lane] = cmd;
    if (cmd === null) warnings.push(`Verify, ${lane} has no runnable command: ${raw.slice(0, 100)}`);
    else if (PLACEHOLDER.test(cmd)) warnings.push(`Verify, ${lane} looks like a placeholder: ${cmd.slice(0, 100)}`);
  }
  return { title, errors, warnings, commands };
}

function splitBeads(markdown) {
  const lines = markdown.split(/\r?\n/);
  const beads = [];
  let cur = null;
  for (const line of lines) {
    const m = BEAD_H.exec(line.trim());
    if (m) {
      if (cur) beads.push(cur);
      cur = { title: m[1].trim(), text: "" };
    } else if (cur) {
      cur.text += line + "\n";
    }
  }
  if (cur) beads.push(cur);
  return beads;
}

function openBeads() {
  let out;
  try {
    out = execFileSync("br", ["list", "--json"], { encoding: "utf8", timeout: 15000 });
  } catch (err) {
    console.error(`check-bead-verify: cannot list open beads: ${String(err)}`);
    process.exit(2);
  }
  let beads;
  try {
    beads = JSON.parse(out);
  } catch (err) {
    console.error(`check-bead-verify: cannot parse br output: ${String(err)}`);
    process.exit(2);
  }
  const list = Array.isArray(beads) ? beads : (beads.beads ?? []);
  return list
    .filter((b) => !["closed", "merged", "done"].includes(String(b.status ?? "").toLowerCase()))
    .map((b) => ({ title: `${b.id}: ${b.title ?? ""}`, text: String(b.description ?? "") }));
}

function main(argv) {
  const files = [];
  let strict = false;
  let json = false;
  for (const a of argv) {
    if (a === "--strict") strict = true;
    else if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/check-bead-verify.mjs [files...] [--strict] [--json]");
      return 0;
    } else files.push(a);
  }
  const sources = files.length > 0
    ? files.map((f) => ({ source: f, beads: splitBeads(fs.readFileSync(f, "utf8")) }))
    : [{ source: "br:open-beads", beads: openBeads() }];
  const report = { ok: true, strict, sources: [] };
  for (const s of sources) {
    const entry = { source: s.source, beads: [] };
    if (s.beads.length === 0) {
      entry.warnings = ["no #### Bead sections found"];
      if (strict) report.ok = false;
    }
    for (const b of s.beads) {
      const r = checkBead(b.title, b.text);
      const failed = r.errors.length > 0 || (strict && r.warnings.length > 0);
      if (failed) report.ok = false;
      entry.beads.push({ ...r, ok: !failed });
    }
    report.sources.push(entry);
  }
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const s of report.sources) {
      console.log(`${s.source}: ${s.beads.length} bead(s)`);
      for (const b of s.beads) {
        const tag = b.ok ? "ok" : "FAIL";
        console.log(`  [${tag}] ${b.title}`);
        for (const e of b.errors) console.log(`    error: ${e}`);
        for (const w of b.warnings) console.log(`    warn: ${w}`);
      }
      for (const w of s.warnings ?? []) console.log(`  warn: ${w}`);
    }
    console.log(report.ok ? "PASS" : "FAIL");
  }
  return report.ok ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
