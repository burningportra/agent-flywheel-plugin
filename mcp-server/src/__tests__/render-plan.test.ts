import { describe, expect, test } from 'vitest';
import { renderPlan, isPlanEmpty, type InstallPlan } from '../setup-detector.js';

const empty = (): InstallPlan => ({
  install: [],
  register: [],
  start: [],
  configure: [],
  skip: [],
});

describe('renderPlan', () => {
  test('formats a fully-populated plan as bulleted list', () => {
    const plan: InstallPlan = {
      install: ['br', 'bv'],
      register: ['agent-flywheel MCP server'],
      start: ['agent-mail HTTP'],
      configure: ['projects_base symlink: /tmp/ntm/proj'],
      skip: ['cm', 'ntm'],
    };
    const out = renderPlan(plan);
    expect(out).toContain('Install plan:');
    expect(out).toContain('Install 2 tools: br, bv');
    expect(out).toContain('Register: agent-flywheel MCP server');
    expect(out).toContain('Symlink: projects_base symlink: /tmp/ntm/proj');
    expect(out).toContain('Start: agent-mail HTTP');
    expect(out).toContain('Skip (already configured): cm, ntm');
  });

  test('renders "(none)" placeholders when buckets are empty', () => {
    const plan = empty();
    plan.install = ['br'];
    const out = renderPlan(plan);
    expect(out).toContain('Install 1 tools: br');
    expect(out).toContain('Register: (none)');
    expect(out).toContain('Symlink: (none)');
    expect(out).toContain('Start: (none)');
    // skip bucket empty → row omitted entirely (spec: skip line only when non-empty)
    expect(out).not.toContain('Skip (already configured):');
  });

  test('all-empty plan still renders the header + 4 placeholder rows', () => {
    const out = renderPlan(empty());
    expect(out.split('\n')).toEqual([
      'Install plan:',
      '  • Install: (none)',
      '  • Register: (none)',
      '  • Symlink: (none)',
      '  • Start: (none)',
    ]);
  });

  test('single-item buckets do not pluralize incorrectly (literal count)', () => {
    const plan = empty();
    plan.install = ['br'];
    expect(renderPlan(plan)).toContain('Install 1 tools: br');
  });

  test('register-only plan omits skip row', () => {
    const plan = empty();
    plan.register = ['agent-flywheel MCP server'];
    const out = renderPlan(plan);
    expect(out).toContain('Register: agent-flywheel MCP server');
    expect(out).not.toContain('Skip');
  });
});

describe('isPlanEmpty', () => {
  test('empty plan is empty', () => {
    expect(isPlanEmpty(empty())).toBe(true);
  });

  test('skip-only plan is empty (skip means already configured, no work needed)', () => {
    const plan = empty();
    plan.skip = ['br', 'bv', 'cm', 'dcg', 'ntm', 'agent-mail HTTP'];
    expect(isPlanEmpty(plan)).toBe(true);
  });

  test('any actionable item makes plan non-empty', () => {
    for (const bucket of ['install', 'register', 'start', 'configure'] as const) {
      const plan = empty();
      plan[bucket] = ['x'];
      expect(isPlanEmpty(plan)).toBe(false);
    }
  });

  test('multiple buckets non-empty → still non-empty', () => {
    const plan: InstallPlan = {
      install: ['br'],
      register: ['mcp'],
      start: [],
      configure: [],
      skip: [],
    };
    expect(isPlanEmpty(plan)).toBe(false);
  });
});
