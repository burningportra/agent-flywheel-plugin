import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../../../..');

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

const phaseFiles = [
  'skills/start/_planning.md',
  'skills/start/_beads.md',
  'skills/start/_implement.md',
  'skills/start/_review.md',
  'skills/start/_wrapup.md',
] as const;

describe('shared start-skill rules', () => {
  it('defines structured-error policy once and keeps phase-specific pointers', () => {
    const start = read('skills/start/SKILL.md');

    expect(start.match(/UNIVERSAL RULE 4/g)).toHaveLength(1);
    for (const phaseFile of phaseFiles) {
      expect(read(phaseFile)).toContain('SKILL.md Universal Rule 4');
    }
    expect(phaseFiles.map(read).join('\n')).not.toContain('Structured error branching');
  });

  it('defines one recent-plan render block and expands it in all three menus', () => {
    const start = read('skills/start/SKILL.md');

    expect(start.match(/Recent plans \(mtime desc/g)).toHaveLength(1);
    expect(start.match(/Insert `RECENT_PLANS_BLOCK` built from `RECENT_PLAN_PATHS`/g)).toHaveLength(3);
    expect(start.match(/Glossary: bead=atomic task/g)).toHaveLength(1);
  });

  it('routes degraded post-mortem drafts through warnings, not error codes', () => {
    const wrapup = read('skills/start/_wrapup.md');

    expect(wrapup).toContain('const warnings = res.structuredContent?.data?.draft?.warnings ?? [];');
    expect(wrapup).toContain('warnings.includes("postmortem_empty_session")');
    expect(wrapup).toContain('warnings.includes("postmortem_checkpoint_stale")');
  });
});
