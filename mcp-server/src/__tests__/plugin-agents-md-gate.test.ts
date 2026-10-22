import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const START_DIR = join(REPO_ROOT, "skills", "start");

/**
 * E6 / D3 regression guard: a bare "AGENTS.md" (or similar) in a pane's
 * marching-orders prompt resolves against the pane's cwd — which is the
 * user's project, not the plugin. The user project's `AGENTS.md` has no
 * Pre-Completion Quality Gate section, so the panes lose the gate.
 *
 * The coordinator reads the gate from the plugin's own file (via
 * $CLAUDE_PLUGIN_ROOT) and pastes it into the pane prompt instead, or
 * keeps one compact inline copy. This test rejects a marching-orders
 * block that still points at a bare "AGENTS.md" for the quality gate.
 */

const QUALITY_GATE_SIGNALS = [
  /quality gate/i,
  /pre-?completion/i,
  /pre-completion quality gate/i,
  /completion[\s_-]?attestation/i,
  /completionreport/i,
];

const BARE_AGENTS_MD = /\bAGENTS\.md\b/g;
const PLUGIN_ROOT_PATH = /\$(?:CLAUDE_)?PLUGIN_ROOT\s*\/\s*AGENTS\.md/i;

/** True if any 3-line window in the file contains a quality-gate signal
 *  phrase AND an unqualified `AGENTS.md` reference without a nearby
 *  `$CLAUDE_PLUGIN_ROOT/AGENTS.md`. */
function hasBareAgentsMdForGate(text: string): { line: number; sample: string }[] {
  const lines = text.split("\n");
  const hits: { line: number; sample: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const window = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2)).join("\n");
    const hasGateSignal = QUALITY_GATE_SIGNALS.some((p) => p.test(window));
    if (!hasGateSignal) continue;
    if (!BARE_AGENTS_MD.test(window)) continue;
    BARE_AGENTS_MD.lastIndex = 0;
    // Pass if the same window names the plugin-rooted path (coordinator reads from there).
    if (PLUGIN_ROOT_PATH.test(window)) continue;
    hits.push({ line: i + 1, sample: lines[i].trim().slice(0, 160) });
  }
  return hits;
}

// E6 scopes the pointer-fix to these three files. _implement.md's STEP 3.5
// is served by the server-built completion-attestation prompt from
// `mcp-server/src/adapters/completion-attestation-prompt.ts`, so panes
// receive the gate text inline (D3/D8 own that path); their documentation-
// touchpoint references to AGENTS.md are intentionally left for a later bead.
const E6_FILES = [
  "skills/start/_inflight_prompt.md",
  "skills/start/_deslop.md",
  "skills/start/_reality_check.md",
];

describe("plugin AGENTS.md gate reference (E6)", () => {
  it("no E6 marching-orders prose points at a bare AGENTS.md for the Pre-Completion Quality Gate", () => {
    const offenders: Array<{ file: string; line: number; sample: string }> = [];
    for (const rel of E6_FILES) {
      const file = join(REPO_ROOT, rel);
      const text = readFileSync(file, "utf8");
      for (const hit of hasBareAgentsMdForGate(text)) {
        offenders.push({ file: rel, ...hit });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("walker helper (coverage): hasBareAgentsMdForGate returns a sample line and 1-indexed line number", () => {
    // Pin the helper's contract so later edits don't accidentally break
    // reporting (an empty-array result in a real file would also pass the
    // guard above by vacuous truth).
    const synthetic = [
      "Normal prose.",
      "## Pre-Completion Quality Gate",
      "Follow AGENTS.md § \"Pre-Completion Quality Gate\" verbatim.",
      "More prose.",
    ].join("\n");
    const hits = hasBareAgentsMdForGate(synthetic);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.line).toBeGreaterThan(0);
    expect(hits[0]!.sample.length).toBeGreaterThan(0);
  });

  // Keep START_DIR available for a future wider sweep; not used here.
  it("E6_FILES list exists for every target file", () => {
    const dirEntries = readdirSync(START_DIR).filter((f) => f.endsWith(".md"));
    for (const rel of E6_FILES) {
      const name = basename(rel);
      expect(dirEntries).toContain(name);
    }
  });
});
