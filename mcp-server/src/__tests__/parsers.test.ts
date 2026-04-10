import { describe, it, expect } from 'vitest';
import {
  parseBrList,
  parseBvInsights,
  parseBvNextPicks,
  parseBvNextPick,
  parseBrError,
  parseAgentMailResponse,
  parseCmResult,
  parseCmSearchResults,
  parseSophiaResult,
  parseProfileCache,
  parseFeedbackFile,
} from '../parsers.js';

// ─── Helpers ───────────────────────────────────────────────

function validBead(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bead-1',
    title: 'Test bead',
    description: 'A test',
    status: 'open',
    priority: 1,
    type: 'task',
    labels: ['test'],
    ...overrides,
  };
}

function validInsights(overrides: Record<string, unknown> = {}) {
  return {
    Bottlenecks: [{ ID: 'b1', Value: 5 }],
    Cycles: null,
    Orphans: ['o1'],
    Articulation: ['a1'],
    Slack: [{ ID: 's1', Value: 2 }],
    ...overrides,
  };
}

function validPick(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pick-1',
    title: 'Next task',
    score: 0.9,
    reasons: ['high priority'],
    unblocks: ['bead-2'],
    ...overrides,
  };
}

function validFeedback(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: '2026-01-01T00:00:00Z',
    goal: 'Ship feature',
    beadCount: 5,
    completedCount: 3,
    totalRounds: 2,
    polishRounds: 1,
    converged: true,
    regressions: [],
    spaceViolationCount: 0,
    ...overrides,
  };
}

// ─── parseBrList ───────────────────────────────────────────

describe('parseBrList', () => {
  it('parses a valid array of beads', () => {
    const raw = JSON.stringify([validBead(), validBead({ id: 'bead-2' })]);
    const result = parseBrList(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(2);
      expect(result.data[0].id).toBe('bead-1');
      expect(result.data[1].id).toBe('bead-2');
    }
  });

  it('parses an empty array', () => {
    const result = parseBrList('[]');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
  });

  it('preserves extra fields via passthrough', () => {
    const bead = validBead({ customField: 'hello' });
    const result = parseBrList(JSON.stringify([bead]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data[0] as unknown as Record<string, unknown>).customField).toBe('hello');
    }
  });

  it('fails on invalid JSON', () => {
    const result = parseBrList('not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Invalid JSON');
  });

  it('fails when input is not an array', () => {
    const result = parseBrList(JSON.stringify({ id: 'bead-1' }));
    expect(result.ok).toBe(false);
  });

  it('fails when array items miss required fields', () => {
    const result = parseBrList(JSON.stringify([{ title: 'no id' }]));
    expect(result.ok).toBe(false);
  });
});

// ─── parseBvInsights ───────────────────────────────────────

describe('parseBvInsights', () => {
  it('parses well-formed insights', () => {
    const result = parseBvInsights(JSON.stringify(validInsights()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.Bottlenecks).toHaveLength(1);
      expect(result.data.Orphans).toContain('o1');
    }
  });

  it('accepts Cycles as null', () => {
    const result = parseBvInsights(JSON.stringify(validInsights({ Cycles: null })));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.Cycles).toBeNull();
  });

  it('accepts non-null Cycles', () => {
    const result = parseBvInsights(JSON.stringify(validInsights({ Cycles: [['a', 'b']] })));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.Cycles).toEqual([['a', 'b']]);
  });

  it('fails when Bottlenecks is missing', () => {
    const { Bottlenecks: _, ...noBottlenecks } = validInsights();
    const result = parseBvInsights(JSON.stringify(noBottlenecks));
    expect(result.ok).toBe(false);
  });

  it('fails on invalid JSON', () => {
    const result = parseBvInsights('{bad');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Invalid JSON');
  });
});

// ─── parseBvNextPicks ──────────────────────────────────────

describe('parseBvNextPicks', () => {
  it('parses an array of picks', () => {
    const result = parseBvNextPicks(JSON.stringify([validPick()]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('pick-1');
    }
  });

  it('parses an empty array', () => {
    const result = parseBvNextPicks('[]');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
  });

  it('fails when items are missing id', () => {
    const result = parseBvNextPicks(JSON.stringify([{ title: 'no id', score: 1, reasons: [], unblocks: [] }]));
    expect(result.ok).toBe(false);
  });

  it('fails on non-JSON', () => {
    const result = parseBvNextPicks('nope');
    expect(result.ok).toBe(false);
  });
});

// ─── parseBvNextPick ───────────────────────────────────────

describe('parseBvNextPick', () => {
  it('parses a valid single pick', () => {
    const result = parseBvNextPick(JSON.stringify(validPick()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).not.toBeNull();
      expect(result.data!.id).toBe('pick-1');
    }
  });

  it('returns null for empty string', () => {
    const result = parseBvNextPick('');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeNull();
  });

  it('returns null for "null" string', () => {
    const result = parseBvNextPick('null');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeNull();
  });

  it('returns null for "{}" string', () => {
    const result = parseBvNextPick('{}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    const result = parseBvNextPick('   ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeNull();
  });

  it('fails when required fields are missing', () => {
    const result = parseBvNextPick(JSON.stringify({ id: 'x' }));
    expect(result.ok).toBe(false);
  });

  it('fails on invalid JSON', () => {
    const result = parseBvNextPick('not-json-or-empty');
    expect(result.ok).toBe(false);
  });
});

// ─── parseBrError ──────────────────────────────────────────

describe('parseBrError', () => {
  it('parses error with code and message', () => {
    const raw = JSON.stringify({ code: 'NOT_FOUND', message: 'bead missing', hint: 'check id' });
    const result = parseBrError(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.code).toBe('NOT_FOUND');
      expect(result.data.message).toBe('bead missing');
    }
  });

  it('parses minimal error (all fields optional)', () => {
    const result = parseBrError('{}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.code).toBeUndefined();
      expect(result.data.message).toBeUndefined();
    }
  });

  it('parses error with retryable and context', () => {
    const raw = JSON.stringify({ retryable: true, context: { attempt: 3 } });
    const result = parseBrError(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.retryable).toBe(true);
      expect(result.data.context).toEqual({ attempt: 3 });
    }
  });

  it('fails on non-object input', () => {
    const result = parseBrError('"just a string"');
    expect(result.ok).toBe(false);
  });

  it('fails on invalid JSON', () => {
    const result = parseBrError('{{bad}}');
    expect(result.ok).toBe(false);
  });
});

// ─── parseAgentMailResponse ────────────────────────────────

describe('parseAgentMailResponse', () => {
  it('parses a successful response with result', () => {
    const raw = JSON.stringify({ result: { id: 1, name: 'test' } });
    const result = parseAgentMailResponse<{ id: number; name: string }>(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ id: 1, name: 'test' });
    }
  });

  it('returns error when response has error field', () => {
    const raw = JSON.stringify({ error: { message: 'not found', code: 404 } });
    const result = parseAgentMailResponse(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('RPC error');
      expect(result.error).toContain('not found');
      expect(result.error).toContain('404');
    }
  });

  it('returns error with unknown message when error has no message', () => {
    const raw = JSON.stringify({ error: {} });
    const result = parseAgentMailResponse(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Unknown RPC error');
  });

  it('fails on malformed JSON', () => {
    const result = parseAgentMailResponse('broken');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Invalid JSON');
  });
});

// ─── parseCmResult ─────────────────────────────────────────

describe('parseCmResult', () => {
  it('parses success response with data', () => {
    const raw = JSON.stringify({ success: true, data: { entries: [1, 2] } });
    const result = parseCmResult<{ entries: number[] }>(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ entries: [1, 2] });
  });

  it('returns error when success is false', () => {
    const raw = JSON.stringify({ success: false });
    const result = parseCmResult(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('success=false');
  });

  it('parses when success is omitted (undefined)', () => {
    const raw = JSON.stringify({ data: 'hello' });
    const result = parseCmResult<string>(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe('hello');
  });

  it('fails on invalid JSON', () => {
    const result = parseCmResult('nope');
    expect(result.ok).toBe(false);
  });
});

// ─── parseCmSearchResults ──────────────────────────────────

describe('parseCmSearchResults', () => {
  it('parses an array of search results', () => {
    const raw = JSON.stringify([
      { text: 'result 1', score: 0.95 },
      { content: 'result 2', score: 0.8 },
    ]);
    const result = parseCmSearchResults(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(2);
      expect(result.data[0].text).toBe('result 1');
    }
  });

  it('parses an empty array', () => {
    const result = parseCmSearchResults('[]');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
  });

  it('fails on non-JSON', () => {
    const result = parseCmSearchResults('bad');
    expect(result.ok).toBe(false);
  });

  it('fails on non-array JSON', () => {
    const result = parseCmSearchResults('{"text": "not array"}');
    expect(result.ok).toBe(false);
  });
});

// ─── parseSophiaResult ─────────────────────────────────────

describe('parseSophiaResult', () => {
  it('parses ok:true with data', () => {
    const raw = JSON.stringify({ ok: true, data: { answer: 42 } });
    const result = parseSophiaResult<{ answer: number }>(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ answer: 42 });
  });

  it('returns error when ok:false with error message', () => {
    const raw = JSON.stringify({ ok: false, error: { message: 'timeout' } });
    const result = parseSophiaResult(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('sophia error');
      expect(result.error).toContain('timeout');
    }
  });

  it('returns error with unknown message when error has no message', () => {
    const raw = JSON.stringify({ ok: false, error: {} });
    const result = parseSophiaResult(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Unknown sophia error');
  });

  it('treats ok:true without error as success even if data is undefined', () => {
    const raw = JSON.stringify({ ok: true });
    const result = parseSophiaResult(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeUndefined();
  });

  it('returns error when ok:false with no error field', () => {
    const raw = JSON.stringify({ ok: false });
    const result = parseSophiaResult(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Unknown sophia error');
  });

  it('fails on invalid JSON', () => {
    const result = parseSophiaResult('???');
    expect(result.ok).toBe(false);
  });
});

// ─── parseProfileCache ─────────────────────────────────────

describe('parseProfileCache', () => {
  it('parses valid profile cache', () => {
    const raw = JSON.stringify({ gitHead: 'abc123', profile: { name: 'test' }, cachedAt: '2024-01-01T00:00:00Z' });
    const result = parseProfileCache(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.gitHead).toBe('abc123');
      expect(result.data.cachedAt).toBe('2024-01-01T00:00:00Z');
    }
  });

  it('fails when gitHead is missing', () => {
    const raw = JSON.stringify({ profile: {}, cachedAt: '2024-01-01' });
    const result = parseProfileCache(raw);
    expect(result.ok).toBe(false);
  });

  it('fails when cachedAt is missing', () => {
    const raw = JSON.stringify({ gitHead: 'abc', profile: {} });
    const result = parseProfileCache(raw);
    expect(result.ok).toBe(false);
  });

  it('fails on invalid JSON', () => {
    const result = parseProfileCache('nope');
    expect(result.ok).toBe(false);
  });
});

// ─── parseFeedbackFile ─────────────────────────────────────

describe('parseFeedbackFile', () => {
  it('parses valid feedback', () => {
    const result = parseFeedbackFile(JSON.stringify(validFeedback()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.goal).toBe('Ship feature');
      expect(result.data.converged).toBe(true);
      expect(result.data.regressions).toEqual([]);
    }
  });

  it('parses feedback with optional scores', () => {
    const fb = validFeedback({ planQualityScore: 0.85, foregoneScore: 0.1 });
    const result = parseFeedbackFile(JSON.stringify(fb));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.planQualityScore).toBe(0.85);
    }
  });

  it('preserves extra fields via passthrough', () => {
    const fb = validFeedback({ customNote: 'extra' });
    const result = parseFeedbackFile(JSON.stringify(fb));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as unknown as Record<string, unknown>).customNote).toBe('extra');
    }
  });

  it('fails when required field is missing', () => {
    const { goal: _, ...noGoal } = validFeedback();
    const result = parseFeedbackFile(JSON.stringify(noGoal));
    expect(result.ok).toBe(false);
  });

  it('fails on invalid JSON', () => {
    const result = parseFeedbackFile('not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Invalid JSON');
  });
});
