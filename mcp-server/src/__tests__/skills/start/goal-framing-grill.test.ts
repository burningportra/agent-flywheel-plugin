import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Lint tests for grill-with-docs integration into flywheel goal refinement.
 *
 * Guards the seams shipped with the Goal framing mode:
 *   - skills/start/SKILL.md exposes Light / Grill / Full brainstorm
 *   - skills/start/_planning.md Phase 0.5 skips on grill brainstorms
 *   - skills/grill-with-docs/SKILL.md exists with handoff contract markers
 */

const REPO_ROOT = resolve(__dirname, '../../../../../');
const START_SKILL = resolve(REPO_ROOT, 'skills/start/SKILL.md');
const PLANNING = resolve(REPO_ROOT, 'skills/start/_planning.md');
const GRILL_SKILL = resolve(REPO_ROOT, 'skills/grill-with-docs/SKILL.md');

describe('goal framing + grill-with-docs integration', () => {
  let startBody: string;
  let planningBody: string;
  let grillBody: string;

  beforeAll(() => {
    startBody = readFileSync(START_SKILL, 'utf-8');
    planningBody = readFileSync(PLANNING, 'utf-8');
    expect(existsSync(GRILL_SKILL), 'skills/grill-with-docs/SKILL.md must exist').toBe(true);
    grillBody = readFileSync(GRILL_SKILL, 'utf-8');
  });

  describe('skills/start/SKILL.md — Goal framing mode', () => {
    it('defines Goal framing mode section', () => {
      expect(startBody).toContain('#### Goal framing mode');
      expect(startBody).toContain('Light (Phase 0.5 only)');
      expect(startBody).toContain('Grill with docs (Recommended)');
      expect(startBody).toContain('Full brainstorm');
      expect(startBody).toContain('Skip framing');
    });

    it('routes Set a goal through Goal framing mode', () => {
      expect(startBody).toMatch(
        /\|\s*\*\*Set a goal\*\*\s*\|[\s\S]*?Goal framing mode/,
      );
    });

    it('routes Refine first and Ambiguous through Goal framing mode', () => {
      expect(startBody).toContain('Pick a framing mode (Light / Grill with docs / Full brainstorm)');
      expect(startBody).toContain(
        'always run **Goal framing mode** first (Recommended default: Grill with docs)',
      );
    });

    it('references grill-with-docs skill path or get_skill name', () => {
      expect(
        startBody.includes('skills/grill-with-docs') ||
          startBody.includes('agent-flywheel:grill-with-docs'),
      ).toBe(true);
    });

    it('anti-double-interview rule present', () => {
      expect(startBody).toContain('Anti-double-interview rule');
    });
  });

  describe('skills/start/_planning.md — Phase 0.5 skip', () => {
    it('skips when grill brainstorm has floor+ceiling+framing', () => {
      expect(planningBody).toContain('Grill-complete brainstorm already on disk');
      expect(planningBody).toContain('## Framing synthesis');
      expect(planningBody).toContain('## Scope floor');
      expect(planningBody).toContain('## Ambition ceiling');
      expect(planningBody).toContain('FRAMING_MODE === "grill"');
    });

    it('does not skip for light framing mode alone', () => {
      expect(planningBody).toContain('FRAMING_MODE === "light"');
      expect(planningBody.toLowerCase()).toContain('do not skip');
    });
  });

  describe('skills/grill-with-docs/SKILL.md — handoff contract', () => {
    it('has required frontmatter name', () => {
      expect(grillBody).toMatch(/^---\nname: grill-with-docs\n/m);
    });

    it('requires AskUserQuestion and forbids plan/bead side effects', () => {
      expect(grillBody).toContain('AskUserQuestion');
      expect(grillBody).toContain('No plan / beads / code');
    });

    it('writes brainstorm under docs/brainstorms with required headings', () => {
      expect(grillBody).toContain('docs/brainstorms/<GOAL_SLUG>-<TODAY>.md');
      expect(grillBody).toContain('## Framing synthesis');
      expect(grillBody).toContain('## Scope floor');
      expect(grillBody).toContain('## Ambition ceiling');
    });

    it('emits GRILL_STATUS / GRILL_BRAINSTORM / GRILL_ENRICHED_GOAL markers', () => {
      expect(grillBody).toContain('GRILL_STATUS=approved|aborted');
      expect(grillBody).toContain('GRILL_BRAINSTORM=');
      expect(grillBody).toContain('GRILL_ENRICHED_GOAL=');
    });

    it('documents ADR + glossary side effects', () => {
      expect(grillBody).toContain('docs/adr/');
      expect(grillBody).toMatch(/CONTEXT\.md|glossary/);
    });
  });
});
