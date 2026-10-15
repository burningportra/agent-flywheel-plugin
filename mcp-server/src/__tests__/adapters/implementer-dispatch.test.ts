import { describe, expect, it } from 'vitest';

import { CompletionReportSchemaV1 } from '../../completion-report.js';
import {
  buildImplementerDispatch,
  type ImplementerPrompt,
} from '../../adapters/implementer-dispatch.js';
import type { CapabilitiesMap } from '../../adapters/model-diversity.js';
import type { ExecFn } from '../../exec.js';
import type { Bead } from '../../types.js';

const unusedExec: ExecFn = async () => {
  throw new Error('capability probe should not run when capabilities are supplied');
};

function capabilities(gemini = true): CapabilitiesMap {
  return {
    claude: { provider: 'claude', available: true, path: '/bin/claude' },
    codex: { provider: 'codex', available: true, path: '/bin/codex' },
    gemini: gemini
      ? { provider: 'gemini', available: true, path: '/bin/gemini' }
      : { provider: 'gemini', available: false, reason: 'not installed' },
  };
}

function beads(count: number): Bead[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `bead-${index + 1}`,
    title: `Implement feature ${index + 1}`,
    description: `Implement feature ${index + 1}.\n- Verify behavior ${index + 1}.`,
    status: 'open',
    priority: 2,
    type: 'task',
    labels: [],
  }));
}

function completionReportExample(prompt: string): unknown {
  const match = prompt.match(
    /## PRE-COMPLETION QUALITY GATE[\s\S]*?```json\n(?<json>[\s\S]*?)\n```/u,
  );
  const json = match?.groups?.json;
  if (!json) throw new Error('completion report JSON example missing from prompt');

  const replacements: ReadonlyArray<readonly [string, string]> = [
    ['<pane-name-or-omit>', 'agent-flywheel--wave-1__cod_1'],
    ['<repo-relative-path>', 'src/feature.ts'],
    ['<short-sha>', 'abc1234'],
    ['<repo-verify-command>', 'npx vitest run'],
    ['<verify-summary>', 'all green'],
    ['<self-review-summary>', 'no regressions found'],
    ['<ISO-8601 timestamp>', '2026-10-15T14:00:00.000Z'],
  ];
  const materialized = replacements.reduce(
    (value, [placeholder, fixture]) => value.replaceAll(placeholder, fixture),
    json,
  );
  const parsed: unknown = JSON.parse(materialized);
  return parsed;
}

function assertCompletionGate(prompt: ImplementerPrompt): void {
  expect(prompt.prompt).toContain('## PRE-COMPLETION QUALITY GATE');
  expect(prompt.prompt).toContain(`.pi-flywheel/completion/${prompt.beadId}.json`);
  const report = CompletionReportSchemaV1.parse(completionReportExample(prompt.prompt));
  expect(report.beadId).toBe(prompt.beadId);
  expect(report.agentName).toBe(prompt.agentName);
}

describe('buildImplementerDispatch', () => {
  it('builds a stable 2/2/2 lane split and bead-specific gated prompts', async () => {
    const dispatch = await buildImplementerDispatch({
      exec: unusedExec,
      cwd: '/workspace/project',
      beads: beads(6),
      coordinatorName: 'WindyBasin',
      capabilities: capabilities(),
    });

    expect(dispatch.lanes).toEqual([
      { lane: 'cc', beadIds: ['bead-1', 'bead-2'] },
      { lane: 'cod', beadIds: ['bead-3', 'bead-4'] },
      { lane: 'gmi', beadIds: ['bead-5', 'bead-6'] },
    ]);
    expect(dispatch.prompts.map(({ beadId, lane }) => ({ beadId, lane }))).toEqual([
      { beadId: 'bead-1', lane: 'cc' },
      { beadId: 'bead-2', lane: 'cc' },
      { beadId: 'bead-3', lane: 'cod' },
      { beadId: 'bead-4', lane: 'cod' },
      { beadId: 'bead-5', lane: 'gmi' },
      { beadId: 'bead-6', lane: 'gmi' },
    ]);
    expect(Object.keys(dispatch.complexity)).toEqual([
      'bead-1', 'bead-2', 'bead-3', 'bead-4', 'bead-5', 'bead-6',
    ]);
    for (const prompt of dispatch.prompts) assertCompletionGate(prompt);
    expect(dispatch.prompts[0]?.prompt.endsWith('\n')).toBe(true);
    expect(dispatch.prompts[0]?.prompt.endsWith('\n\n')).toBe(false);
    expect(dispatch.prompts[2]?.prompt.endsWith('\n\n')).toBe(true);
    expect(dispatch.prompts[4]?.prompt.endsWith('\n')).toBe(true);
    expect(dispatch.prompts[4]?.prompt.endsWith('\n\n')).toBe(false);
  });

  it('reassigns the missing Gemini share to Codex without changing Claude share', async () => {
    const dispatch = await buildImplementerDispatch({
      exec: unusedExec,
      cwd: '/workspace/project',
      beads: beads(6),
      coordinatorName: 'WindyBasin',
      capabilities: capabilities(false),
    });

    expect(dispatch.lanes).toEqual([
      { lane: 'cc', beadIds: ['bead-1', 'bead-2'] },
      { lane: 'cod', beadIds: ['bead-3', 'bead-4', 'bead-5', 'bead-6'] },
    ]);
    expect(dispatch.prompts.map((prompt) => prompt.lane)).toEqual([
      'cc', 'cc', 'cod', 'cod', 'cod', 'cod',
    ]);
    expect(dispatch.degraded).toBe(true);
    expect(dispatch.warnings).toEqual([
      'gemini CLI not available (not installed); reassigned 2 bead(s) to codex',
    ]);
  });

  it('returns an empty dispatch without probing capabilities when there are no beads', async () => {
    const dispatch = await buildImplementerDispatch({
      exec: unusedExec,
      cwd: '/workspace/project',
      beads: [],
      coordinatorName: 'WindyBasin',
    });

    expect(dispatch).toEqual({
      lanes: [],
      prompts: [],
      complexity: {},
      warnings: [],
      degraded: false,
    });
  });
});
