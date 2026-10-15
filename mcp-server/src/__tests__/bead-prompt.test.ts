import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { buildBeadCreationPrompt, containsForbiddenDependsOnFlag } from '../tools/bead-prompt.js';
import { beadCreationPrompt } from '../tools/shared.js';

describe('buildBeadCreationPrompt', () => {
  it('renders the positional br dep add form and never emits --depends-on', () => {
    const prompt = buildBeadCreationPrompt({
      goal: 'Add rate limiting',
      constraints: ['no breaking changes'],
      repoContext: 'TypeScript MCP server',
    });

    expect(prompt).toContain('br dep add <downstream> <upstream>');
    expect(containsForbiddenDependsOnFlag(prompt)).toBe(false);
    expect(prompt).not.toContain('--depends-on');
  });

  it('documents br create, update, close with the correct flags', () => {
    const prompt = buildBeadCreationPrompt({ goal: 'test' });

    expect(prompt).toContain('br create --title');
    expect(prompt).toContain('--priority <0-4>');
    expect(prompt).toContain('br close <id> --reason');
    expect(prompt).toMatch(/open\|in_progress\|deferred\|closed/);
  });

  it('includes the plan path and preview when provided', () => {
    const prompt = buildBeadCreationPrompt({
      goal: 'test',
      planPath: 'docs/plans/demo.md',
      planPreview: 'Plan step 1',
    });

    expect(prompt).toContain('docs/plans/demo.md');
    expect(prompt).toContain('Plan step 1');
  });

  it('includes a Provenance section when provided (B3 hook)', () => {
    const prompt = buildBeadCreationPrompt({
      goal: 'test',
      provenance: 'duel-sourced idea with cross-score 820/1000',
    });

    expect(prompt).toContain('## Provenance');
    expect(prompt).toContain('820/1000');
  });

  it('includes a Template Library section with the Template: <id> hook (B2)', () => {
    const prompt = buildBeadCreationPrompt({
      goal: 'test',
      templateLibrary: '- add-api-endpoint — new HTTP endpoint',
    });

    expect(prompt).toContain('## Template Library');
    expect(prompt).toContain('Template: <id>');
    expect(prompt).toContain('flywheel_calibrate');
  });

  it('includes constraints when supplied', () => {
    const prompt = buildBeadCreationPrompt({
      goal: 'test',
      constraints: ['keep latency < 50ms', 'no new deps'],
    });

    expect(prompt).toContain('keep latency < 50ms');
    expect(prompt).toContain('no new deps');
  });

  it('is used by the shared.ts beadCreationPrompt wrapper', () => {
    const prompt = beadCreationPrompt('Add a thing', 'ctx', ['c1']);
    expect(containsForbiddenDependsOnFlag(prompt)).toBe(false);
    expect(prompt).toContain('br dep add <downstream> <upstream>');
  });
});

describe('regression: no server-built prompt mentions --depends-on', () => {
  const srcRoot = resolve(__dirname, '..');
  const skipFiles = new Set([
    // the detector itself holds the pattern as a literal
    resolve(srcRoot, 'tools', 'bead-prompt.ts'),
    resolve(srcRoot, '__tests__', 'bead-prompt.test.ts'),
  ]);

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) {
        // Skip test trees — tests must mention the forbidden flag literal to assert its absence.
        if (entry === '__tests__' || entry === '__snapshots__') continue;
        out.push(...walk(p));
      } else if (extname(p) === '.ts' && !p.endsWith('.test.ts')) {
        out.push(p);
      }
    }
    return out;
  }

  it('mcp-server/src (non-test .ts): nothing instructs an agent to use --depends-on', () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      if (skipFiles.has(file)) continue;
      const text = readFileSync(file, 'utf8');
      if (containsForbiddenDependsOnFlag(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
