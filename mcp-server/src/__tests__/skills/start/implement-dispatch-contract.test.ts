import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../../../..');

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

const implementerSurfaces = [
  'skills/start/_implement.md',
  'skills/flywheel-swarm/SKILL.md',
  'commands/flywheel-swarm.md',
] as const;

describe('server-owned wave-one implementer dispatch', () => {
  it.each(implementerSurfaces)('%s dispatches returned lanes and prompts', (relativePath) => {
    const content = read(relativePath);

    expect(content).toContain('data.lanes');
    expect(content).toContain('data.prompts');
    expect(content).toContain('coordinatorName');
    expect(content).not.toContain('Follow AGENTS.md § "Pre-Completion Quality Gate"');
    expect(content).not.toContain('copy the gate text from AGENTS.md');
  });

  it.each(['skills/start/_implement.md', 'skills/flywheel-swarm/SKILL.md'])(
    '%s spawns Pi lanes through swarm-spawn.js on a user-picked model',
    (relativePath) => {
      const content = read(relativePath);

      expect(content).toContain('node "${PLUGIN_ROOT}/mcp-server/dist/scripts/swarm-spawn.js" "$NTM_PROJECT" --label impl-<goal-slug>');
      expect(content).toContain('--cc=<N_cc> --pi=<N_pi> --pi-model="$PI_IMPL_MODEL" --pi-name=impl --gmi=<N_gmi> --cod=<N_cod>');
      expect(content).toContain('flywheel_pi_models({ cwd, action: "list", roles: ["implementer"] })');
      expect(content).toContain('data.piModels.implementer');
      // ntm 1.36.1 rejects --pi on a raw spawn, and its gmi lane is the gemini CLI.
      expect(content).not.toMatch(/ntm spawn[^\n]*--(pi|gmi)=/);
    },
  );

  it.each(['skills/start/_implement.md', 'skills/start/_inflight_prompt.md', 'skills/flywheel-swarm/SKILL.md'])(
    '%s asks the operator to choose Claude + AGY (Recommended) or optional Pi before calling flywheel_pi_models',
    (relativePath) => {
      const content = read(relativePath);

      expect(content).toContain('header: "Swarm lanes"');
      expect(content).toContain('label: "Claude + AGY (Recommended)"');
      expect(content).toContain('label: "Claude + AGY + Pi (optional Pi)"');
    },
  );

  it('asks which model the Claude panes run and passes it as --cc=<N_cc>:<model>', () => {
    const content = read('skills/start/_implement.md');

    expect(content).toContain('When `N_cc` is above 0, also ask which model the Claude panes run and pass it as `--cc=<N_cc>:<model>`.');
  });

  it('keeps the pane-addressing invariants', () => {
    const content = read('skills/start/_implement.md');

    expect(content).toContain('Use `--panes=N`');
    expect(content).toContain('`--pane=N` (singular) is silently broadcast to ALL panes');
    expect(content).toContain("Don't add `--type`: ntm reports Pi panes as type `unknown`");
  });

  it('routes every batch-review step without asking the user', () => {
    const content = read('skills/start/_implement.md');

    for (const kind of ['batch_review_due', 'advance_wave']) {
      expect(content).toContain(`\`${kind}\``);
    }
    expect(content).not.toMatch(/needs_attention|synthesized_beads_pending|Approve subset|Pause to fix/);
  });
});
