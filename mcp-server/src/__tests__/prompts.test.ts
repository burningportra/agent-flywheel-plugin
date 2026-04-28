import { describe, expect, it } from 'vitest';
import { beadCreationPrompt, planToBeadsPrompt } from '../prompts.js';
import type { RepoProfile } from '../types.js';

function minimalProfile(): RepoProfile {
  return {
    name: 'demo',
    languages: ['TypeScript'],
    frameworks: [],
    structure: '',
    entrypoints: [],
    recentCommits: [],
    hasTests: true,
    testFramework: 'Vitest',
    hasDocs: false,
    hasCI: false,
    todos: [],
    keyFiles: {},
  };
}

describe('bead creation prompts — template calibration metadata', () => {
  it('instructs direct bead creation to include a Template line for template-backed beads', () => {
    const prompt = beadCreationPrompt('Add a tool', 'Repo context', []);

    expect(prompt).toContain('Template: <id>');
    expect(prompt).toContain('Template: add-api-endpoint');
    expect(prompt).toContain('machine-readable');
  });

  it('instructs plan-to-beads synthesis to include a Template line in br create bodies', () => {
    const prompt = planToBeadsPrompt('docs/plans/demo.md', 'Add a tool', minimalProfile());

    expect(prompt).toContain('Template: <id>');
    expect(prompt).toContain('Template: add-api-endpoint');
    expect(prompt).toContain('calibration');
  });
});
