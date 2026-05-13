import { describe, it, expect } from 'vitest';
import {
  detectInstallState,
  REQUIRED_CLIS,
  type Probes,
  type RequiredCli,
} from '../setup-detector.js';

function makeProbes(overrides: Partial<Probes> = {}): Probes {
  return {
    hasCli: async () => true,
    isAgentMailAlive: async () => true,
    isMcpRegistered: async () => true,
    getNtmBase: async () => null,
    ...overrides,
  };
}

describe('detectInstallState (T3.1)', () => {
  it('returns the 5-bucket InstallPlan shape', async () => {
    const plan = await detectInstallState({
      cwd: '/tmp/proj',
      probes: makeProbes(),
    });
    expect(plan).toMatchObject({
      install: expect.any(Array),
      register: expect.any(Array),
      start: expect.any(Array),
      configure: expect.any(Array),
      skip: expect.any(Array),
    });
  });

  it('all checks run in parallel (Promise.all)', async () => {
    const callOrder: string[] = [];
    const slow = async <T,>(label: string, value: T): Promise<T> => {
      callOrder.push(`start:${label}`);
      await new Promise((r) => setTimeout(r, 5));
      callOrder.push(`end:${label}`);
      return value;
    };
    const t0 = Date.now();
    await detectInstallState({
      cwd: '/tmp/proj',
      probes: makeProbes({
        hasCli: (cli) => slow(`cli:${cli}`, true),
        isAgentMailAlive: () => slow('mail', true),
        isMcpRegistered: () => slow('mcp', true),
        getNtmBase: () => slow('ntm', null),
      }),
    });
    const elapsed = Date.now() - t0;
    // If sequential, 8 probes × 5ms = 40ms+; parallel should be <30ms.
    expect(elapsed).toBeLessThan(30);
    // Every probe started before any finished.
    const firstEndIdx = callOrder.findIndex((s) => s.startsWith('end:'));
    const lastStartIdx = callOrder.map((s) => s.startsWith('start:'))
      .lastIndexOf(true);
    expect(lastStartIdx).toBeLessThan(firstEndIdx);
  });

  it('routes a missing CLI into install, present CLI into skip', async () => {
    const plan = await detectInstallState({
      cwd: '/tmp/proj',
      probes: makeProbes({
        hasCli: async (cli: RequiredCli) => cli !== 'ntm',
      }),
    });
    expect(plan.install).toEqual(['ntm']);
    expect(plan.skip).toEqual(expect.arrayContaining(['br', 'bv', 'cm', 'dcg']));
  });

  it('routes unreachable agent-mail into start, reachable into skip', async () => {
    const down = await detectInstallState({
      cwd: '/tmp/proj',
      probes: makeProbes({ isAgentMailAlive: async () => false }),
    });
    expect(down.start).toContain('agent-mail HTTP');
    const up = await detectInstallState({
      cwd: '/tmp/proj',
      probes: makeProbes({ isAgentMailAlive: async () => true }),
    });
    expect(up.skip).toContain('agent-mail HTTP');
  });

  it('routes unregistered MCP into register, registered into skip', async () => {
    const unreg = await detectInstallState({
      cwd: '/tmp/proj',
      probes: makeProbes({ isMcpRegistered: async () => false }),
    });
    expect(unreg.register).toContain('agent-flywheel MCP server');
    const reg = await detectInstallState({
      cwd: '/tmp/proj',
      probes: makeProbes({ isMcpRegistered: async () => true }),
    });
    expect(reg.skip).toContain('agent-flywheel MCP server');
  });

  it('flags missing NTM projects_base symlink into configure', async () => {
    const plan = await detectInstallState({
      cwd: '/tmp/proj-that-does-not-exist',
      probes: makeProbes({
        getNtmBase: async () => '/tmp/agent-flywheel-test-ntm-base-XYZ',
      }),
    });
    const configureEntry = plan.configure.find((s) =>
      s.startsWith('projects_base symlink:'),
    );
    expect(configureEntry).toBeDefined();
  });

  it('omits NTM configure entry when ntm base is unknown', async () => {
    const plan = await detectInstallState({
      cwd: '/tmp/proj',
      probes: makeProbes({ getNtmBase: async () => null }),
    });
    expect(plan.configure.find((s) => s.includes('projects_base'))).toBeUndefined();
  });

  it('REQUIRED_CLIS lists the canonical 5 ACFS CLIs', () => {
    expect(REQUIRED_CLIS).toEqual(['br', 'bv', 'cm', 'dcg', 'ntm']);
  });
});
