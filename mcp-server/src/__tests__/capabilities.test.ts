/**
 * R-001 — flywheel_capabilities snapshot tests.
 *
 * Goal: pin the capabilities envelope shape so that contract drift is
 * caught at PR time. Bumping CAPABILITIES_CONTRACT_VERSION REQUIRES
 * updating the snapshot; adding a new tool to PRIMARY_TOOLS REQUIRES
 * appending it to the snapshot's mcp_tools array. Both signals are
 * intentional review gates, not noise.
 */

import { describe, it, expect } from 'vitest';
import {
  CAPABILITIES_CONTRACT_VERSION,
  buildCapabilitiesPayload,
  summarizeTool,
  FLYWHEEL_ENV_VARS,
  EXIT_CODE_CONTRACT,
} from '../tools/capabilities.js';
import { TOOLS } from '../server.js';
import { FLYWHEEL_ERROR_CODES, DEFAULT_HINTS, DEFAULT_RETRYABLE } from '../errors.js';
import { DOCTOR_CHECK_NAMES } from '../tools/doctor.js';

describe('flywheel_capabilities — contract surface', () => {
  it('contract_version is a stable literal', () => {
    expect(CAPABILITIES_CONTRACT_VERSION).toBe(1);
  });

  it('summarizeTool extracts required, optional, and enums', () => {
    const tool = {
      name: 'flywheel_review',
      description: 'review beads',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          beadId: { type: 'string' },
          action: { type: 'string', enum: ['hit-me', 'looks-good', 'skip'] as const },
          mode: { type: 'string', enum: ['interactive', 'autofix', 'report-only', 'headless'] as const },
        },
        required: ['cwd', 'beadId', 'action'],
      },
    };
    const s = summarizeTool(tool);
    expect(s.name).toBe('flywheel_review');
    expect(s.required).toEqual(['action', 'beadId', 'cwd']);
    expect(s.optional).toEqual(['mode']);
    expect(s.enums.action).toEqual(['hit-me', 'looks-good', 'skip']);
    expect(s.enums.mode).toEqual(['interactive', 'autofix', 'report-only', 'headless']);
    expect(s.deprecated).toBe(false);
    expect(s.deprecation_replacement).toBeUndefined();
  });

  it('summarizeTool flags orch_* aliases as deprecated with a replacement', () => {
    const s = summarizeTool({
      name: 'orch_doctor',
      description: '[DEPRECATED] doctor',
      inputSchema: { type: 'object', properties: { cwd: {} }, required: ['cwd'] },
    });
    expect(s.deprecated).toBe(true);
    expect(s.deprecation_replacement).toBe('flywheel_doctor');
  });

  it('summarizeTool emits a schema_url pointing at dist/schemas/inputs (R-003)', () => {
    const s = summarizeTool({
      name: 'flywheel_observe',
      description: 'observe',
      inputSchema: { type: 'object', properties: { cwd: {} }, required: ['cwd'] },
    });
    expect(s.schema_url).toBe('schemas/inputs/flywheel_observe.json');
  });

  it('every FLYWHEEL_ERROR_CODE has a default hint and retryable flag', () => {
    for (const code of FLYWHEEL_ERROR_CODES) {
      expect(DEFAULT_HINTS[code], `hint for ${code}`).toBeDefined();
      expect(typeof DEFAULT_RETRYABLE[code], `retryable for ${code}`).toBe('boolean');
    }
  });

  it('FLYWHEEL_ENV_VARS dictionary is non-empty and entries are descriptive', () => {
    const keys = Object.keys(FLYWHEEL_ENV_VARS);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.startsWith('FW_'), `${key} should start with FW_`).toBe(true);
      expect(FLYWHEEL_ENV_VARS[key].length).toBeGreaterThan(20);
    }
  });

  it('EXIT_CODE_CONTRACT documents 0 through 5', () => {
    for (const code of ['0', '1', '2', '3', '4', '5']) {
      expect(EXIT_CODE_CONTRACT[code], `exit code ${code}`).toBeDefined();
    }
  });
});

describe('flywheel_capabilities — payload shape against the live TOOLS list', () => {
  const payload = buildCapabilitiesPayload(TOOLS, { now: () => 'TEST-TS' });

  it('envelope status is ok with stable version literal', () => {
    expect(payload.tool).toBe('flywheel_capabilities');
    expect(payload.version).toBe(1);
    expect(payload.status).toBe('ok');
    expect(payload.phase).toBe('idle');
    expect(payload.data.contract_version).toBe(1);
    expect(payload.data.generated_at).toBe('TEST-TS');
  });

  it('mcp_tools is sorted by name and includes both flywheel_* and orch_* aliases', () => {
    const names = payload.data.mcp_tools.map((t) => t.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
    expect(names).toContain('flywheel_doctor');
    expect(names).toContain('orch_doctor');
    expect(names).toContain('flywheel_capabilities');
  });

  it('every tool entry has required[] and optional[] arrays (possibly empty)', () => {
    for (const t of payload.data.mcp_tools) {
      expect(Array.isArray(t.required), `${t.name}.required`).toBe(true);
      expect(Array.isArray(t.optional), `${t.name}.optional`).toBe(true);
    }
  });

  it('every tool entry carries a schema_url (R-003)', () => {
    for (const t of payload.data.mcp_tools) {
      expect(t.schema_url, `${t.name}.schema_url`).toBe(`schemas/inputs/${t.name}.json`);
    }
  });

  it('references.schemas_url points at the manifest (R-003)', () => {
    expect(payload.data.references.schemas_url).toBe('schemas/index.json');
  });

  it('error_codes count matches FLYWHEEL_ERROR_CODES', () => {
    expect(payload.data.error_codes.length).toBe(FLYWHEEL_ERROR_CODES.length);
  });

  it('every error_code carries default_hint AND default_try_this (R-007)', () => {
    for (const entry of payload.data.error_codes) {
      expect(entry.default_hint, `${entry.code}.default_hint`).toBeDefined();
      expect(entry.default_hint.length).toBeGreaterThan(20);
      expect(entry.default_try_this, `${entry.code}.default_try_this`).toBeDefined();
      expect(entry.default_try_this.length).toBeGreaterThan(20);
    }
  });

  it('doctor_check_names matches the source enum, sorted', () => {
    expect([...payload.data.doctor_check_names].sort()).toEqual(payload.data.doctor_check_names);
    expect(payload.data.doctor_check_names.length).toBe(DOCTOR_CHECK_NAMES.length);
  });

  it('snapshot of the structural skeleton (counts + presence, not full content)', () => {
    // Why a structural snapshot rather than the full payload: the full
    // payload churns on every tool description tweak. The skeleton catches
    // the load-bearing drift (a tool added/removed; a contract version
    // bump; an error code dropped) without flagging benign description edits.
    const skeleton = {
      tool: payload.tool,
      version: payload.version,
      status: payload.status,
      phase: payload.phase,
      data: {
        kind: payload.data.kind,
        contract_version: payload.data.contract_version,
        mcp_tool_count: payload.data.mcp_tools.length,
        primary_tool_count: payload.data.mcp_tools.filter((t) => !t.deprecated).length,
        deprecated_tool_count: payload.data.mcp_tools.filter((t) => t.deprecated).length,
        first_tool_name: payload.data.mcp_tools[0]?.name,
        last_tool_name: payload.data.mcp_tools[payload.data.mcp_tools.length - 1]?.name,
        error_code_count: payload.data.error_codes.length,
        doctor_check_count: payload.data.doctor_check_names.length,
        env_var_count: Object.keys(payload.data.env_vars).length,
        exit_code_count: Object.keys(payload.data.exit_code_contract).length,
      },
    };
    expect(skeleton).toMatchSnapshot();
  });
});
