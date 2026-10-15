import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

const repoRoot = resolve(__dirname, '..', '..', '..');
const skillsDir = join(repoRoot, 'skills');
const commandsDir = join(repoRoot, 'commands');

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...walkMarkdown(p));
    } else if (extname(p) === '.md') {
      out.push(p);
    }
  }
  return out;
}

const RETIRED_RATIOS = [
  /\b4\s*cod\s*\+\s*2\s*cc\b/i,
  /\b4\s*pi\s*\+\s*2\s*cc\b/i,
];

const BARE_NTM_SEND = /\bntm\s+send\b(?!\s*=|-)/;
const PANE_NAME_FLAG = /--pane-name\b/;

// Flags the specific defect: parallel reviewers told to overwrite a shared file.
// Catches "write your revised plan back to the same file" plus a nearby mention
// of three/multiple reviewers reconciling, which is the shape of the bug. Single
// -agent revise prompts (one agent, writes back to its own input) are fine.
const PARALLEL_SAME_FILE = /write\s+(?:your|the)\s+(?:revised\s+)?plan\s+back\s+to\s+the\s+same\s+file/i;

describe('swarm doc contradictions (AGENTS.md NTM pane priority)', () => {
  const files = [
    ...walkMarkdown(skillsDir),
    ...walkMarkdown(commandsDir),
  ];

  it('no file recommends the retired "4 cod + 2 cc" or "4 pi + 2 cc" composition', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        for (const pat of RETIRED_RATIOS) {
          if (pat.test(line)) {
            offenders.push({ file, line: i + 1, text: line.trim().slice(0, 120) });
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('no file recommends bare "ntm send"; everyone uses --robot-send', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (BARE_NTM_SEND.test(line) && !/--robot-send/.test(line)) {
          offenders.push({ file, line: i + 1, text: line.trim().slice(0, 120) });
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('no file passes --pane-name to ntm (not a flag in ntm 1.36.1; use --panes=<N>)', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (PANE_NAME_FLAG.test(line)) {
          offenders.push({ file, line: i + 1, text: line.trim().slice(0, 120) });
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('no file tells concurrent reviewers to write back to the same plan file', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (PARALLEL_SAME_FILE.test(line)) {
          offenders.push({ file, line: i + 1, text: line.trim().slice(0, 120) });
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('_planning.md review-round recipe spawns 1:1:1, uses --panes= indexing, and gives each pane its own per-pane revision file', () => {
    const planningPath = resolve(skillsDir, 'start', '_planning.md');
    const text = readFileSync(planningPath, 'utf8');
    // Locate the review-round recipe section.
    const idx = text.indexOf('plan-review-round-');
    expect(idx).toBeGreaterThan(-1);
    // Grab a reasonable window around it.
    const window = text.slice(idx, idx + 2000);
    expect(window).toMatch(/--cc=1\s+--cod=1\s+--gmi=1/);
    expect(window).toMatch(/--panes=/);
    expect(window).not.toMatch(/--pane-name/);
    expect(window).toMatch(/-round-<N>-/); // per-pane revision filenames
  });
});
