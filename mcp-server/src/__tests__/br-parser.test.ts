import { describe, expect, it } from 'vitest';
import { parseBrList } from '../br-parser.js';

describe('br-parser — calibration metadata', () => {
  it('extracts template from a bead description Template line', () => {
    const raw = JSON.stringify([
      {
        id: 'bead-1',
        title: 'Add tool',
        status: 'closed',
        description: 'Template: add-tool\n\nImplement the tool.\n\n### Files:\n- src/tool.ts',
        created_at: '2026-04-27T00:00:00.000Z',
        closed_at: '2026-04-27T01:00:00.000Z',
      },
    ]);

    const result = parseBrList(raw);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      template: 'add-tool',
      created_ts: '2026-04-27T00:00:00.000Z',
      closed_ts: '2026-04-27T01:00:00.000Z',
    });
  });

  it('does not overwrite a first-class template field from br when present', () => {
    const raw = JSON.stringify([
      {
        id: 'bead-2',
        title: 'Add endpoint',
        status: 'closed',
        template: 'add-api-endpoint@1',
        description: 'Template: add-tool\n\nImplement something else.',
      },
    ]);

    const result = parseBrList(raw);

    expect(result.rows[0]).toMatchObject({ template: 'add-api-endpoint@1' });
  });
});

describe('br-parser — statuses and descriptions br accepts', () => {
  it('reads completed as closed and a null description as absent, and still rejects an unknown status', () => {
    const raw = JSON.stringify([
      { id: 'bead-1', title: 'Done long ago', status: 'completed', description: null },
      { id: 'bead-2', title: 'Odd', status: 'wibble' },
    ]);

    const result = parseBrList(raw);

    expect(result.rows.map((row) => [row.id, row.status, row.description])).toEqual([['bead-1', 'closed', undefined]]);
    expect(result.rejected).toBe(1);
  });

  it('keeps a blocked row as blocked instead of rejecting it', () => {
    const raw = JSON.stringify({
      issues: [
        { id: 'bead-1', title: 'Ready', status: 'open' },
        { id: 'bead-2', title: 'Waiting on upstream', status: 'blocked', priority: 1 },
      ],
    });

    const result = parseBrList(raw);

    expect(result.rows.map((row) => [row.id, row.status])).toEqual([['bead-1', 'open'], ['bead-2', 'blocked']]);
    expect(result.rejected).toBe(0);
  });
});
