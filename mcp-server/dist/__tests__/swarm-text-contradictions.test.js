import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
const repoRoot = resolve(__dirname, '..', '..', '..');
const skillsDir = join(repoRoot, 'skills');
const commandsDir = join(repoRoot, 'commands');
function walkMarkdown(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) {
            out.push(...walkMarkdown(p));
        }
        else if (extname(p) === '.md') {
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
        const offenders = [];
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
        const offenders = [];
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
        const offenders = [];
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
        const offenders = [];
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
    it('_planning.md review-round recipe spawns 1:1:1, addresses panes by --type=, and gives each pane its own per-pane revision file', () => {
        const planningPath = resolve(skillsDir, 'start', '_planning.md');
        const text = readFileSync(planningPath, 'utf8');
        const idx = text.indexOf('plan-review-round-');
        expect(idx).toBeGreaterThan(-1);
        const window = text.slice(idx, idx + 2000);
        expect(window).toMatch(/--cc=1\s+--cod=1\s+--gmi=1/);
        // Address panes by provider type (index-agnostic — a --no-user spawn with
        // pane-base-index 0 numbers panes 0..N-1, so an index loop starting at 1
        // skips the cc pane). --type= is correct; --panes=1,2,3 is wrong here.
        expect(window).toMatch(/--type=cc/);
        expect(window).toMatch(/--type=cod/);
        expect(window).toMatch(/--type=gmi/);
        expect(window).not.toMatch(/--pane-name/);
        // Guard the specific regression WindyBasin flagged: the --panes=1,2,3 loop.
        expect(window).not.toMatch(/for\s+PANE\s+in\s+1\s+2\s+3/);
        expect(window).not.toMatch(/--panes="?\$?PANE/);
        expect(window).toMatch(/-round-<N>-/); // per-pane revision filenames
    });
    it('_planning.md review-round recipe does not claim ntm only accepts a short flag list (it has more flags)', () => {
        const planningPath = resolve(skillsDir, 'start', '_planning.md');
        const text = readFileSync(planningPath, 'utf8');
        const idx = text.indexOf('plan-review-round-');
        const window = text.slice(idx, idx + 2000);
        // Earlier drafts claimed `ntm 1.36.1 only accepts \`--panes\`, \`--type\`, and \`--all\``.
        // That understates the real flag surface; the recipe should state what it uses, not what ntm accepts.
        expect(window).not.toMatch(/ntm[^.]*only accepts/i);
    });
});
//# sourceMappingURL=swarm-text-contradictions.test.js.map