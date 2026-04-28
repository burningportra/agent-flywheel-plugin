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
//# sourceMappingURL=br-parser.test.js.map