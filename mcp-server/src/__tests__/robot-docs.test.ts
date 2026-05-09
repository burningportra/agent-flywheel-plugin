/**
 * R-002 — flywheel_robot_docs handbook tests.
 *
 * Pin: every section exists, has a non-trivial body, and the 'all'
 * default returns each section in declaration order. The text content
 * itself is allowed to drift; the structural contract (section keys,
 * presence of paste-ready code, capabilities pointer) is what's pinned.
 */

import { describe, it, expect } from 'vitest';
import {
  ROBOT_DOCS_VERSION,
  ROBOT_DOCS_SECTIONS,
  buildRobotDocs,
  runRobotDocs,
} from '../tools/robot-docs.js';

describe('flywheel_robot_docs — section coverage', () => {
  it('docs_version is a stable literal', () => {
    expect(ROBOT_DOCS_VERSION).toBe(1);
  });

  it('declares all six expected sections in stable order', () => {
    expect(ROBOT_DOCS_SECTIONS).toEqual([
      'getting_started',
      'common_workflows',
      'error_codes_decoder',
      'dangerous_ops_safe_alt',
      'exit_code_contract',
      'capabilities_pointer',
    ]);
  });

  it.each(ROBOT_DOCS_SECTIONS)('section %s has a non-trivial body', (key) => {
    const payload = buildRobotDocs(key);
    expect(payload.data.section).toBe(key);
    expect(payload.data.sections).toHaveLength(1);
    expect(payload.data.sections[0].key).toBe(key);
    expect(payload.data.sections[0].body.length).toBeGreaterThan(80);
    expect(payload.data.markdown.startsWith('## ')).toBe(true);
  });

  it("section='all' returns every section concatenated in declaration order", () => {
    const payload = buildRobotDocs('all');
    expect(payload.data.section).toBe('all');
    expect(payload.data.sections).toHaveLength(ROBOT_DOCS_SECTIONS.length);
    expect(payload.data.sections.map((s) => s.key)).toEqual([...ROBOT_DOCS_SECTIONS]);
    // Markdown contains every section title.
    for (const s of payload.data.sections) {
      expect(payload.data.markdown).toContain(`## ${s.title}`);
    }
  });

  it('common_workflows references the canonical first calls (paste-ready)', () => {
    const md = buildRobotDocs('common_workflows').data.markdown;
    expect(md).toContain('flywheel_profile(cwd)');
    expect(md).toContain('flywheel_doctor(cwd)');
  });

  it('dangerous_ops_safe_alt names the gated commands and --yes requirement', () => {
    const md = buildRobotDocs('dangerous_ops_safe_alt').data.markdown;
    expect(md).toContain('/flywheel-swarm-stop --yes');
    expect(md).toContain('/flywheel-refine-skills --yes');
    expect(md).toContain('--dry-run');
  });

  it('capabilities_pointer cross-references flywheel_capabilities', () => {
    const md = buildRobotDocs('capabilities_pointer').data.markdown;
    expect(md).toContain('flywheel_capabilities');
    expect(md).toContain('contract_version');
    expect(md).toContain('schemas/index.json');
  });

  it('runRobotDocs falls back to "all" on unknown section', async () => {
    const res = await runRobotDocs(
      { cwd: '/tmp', exec: null as never, signal: null as never } as never,
      { section: 'made_up_section' },
    );
    const sc = res.structuredContent as { data: { section: string; sections: unknown[] } };
    expect(sc.data.section).toBe('all');
    expect(sc.data.sections).toHaveLength(ROBOT_DOCS_SECTIONS.length);
  });

  it('runRobotDocs envelope shape is {tool,version,status,phase,data}', async () => {
    const res = await runRobotDocs(
      { cwd: '/tmp', exec: null as never, signal: null as never } as never,
      { section: 'getting_started' },
    );
    const sc = res.structuredContent as {
      tool: string;
      version: number;
      status: string;
      phase: string;
      data: { kind: string; pointers: { capabilities_tool: string } };
    };
    expect(sc.tool).toBe('flywheel_robot_docs');
    expect(sc.version).toBe(1);
    expect(sc.status).toBe('ok');
    expect(sc.phase).toBe('idle');
    expect(sc.data.kind).toBe('robot_docs');
    expect(sc.data.pointers.capabilities_tool).toBe('flywheel_capabilities');
  });
});
