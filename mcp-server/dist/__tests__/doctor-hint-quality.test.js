/**
 * doctor-hint-quality — regression guard.
 *
 * During the v3.4.0 R1 review, `mcp-server/src/tools/doctor.ts` shipped with
 * ~37 `hint:` sites that used the error-code *string* as the value instead
 * of an actionable remediation sentence (e.g. `hint: 'cli_failure'`). The
 * `DoctorCheckSchema.hint` field is advertised to consumers as a
 * human-readable next-step, so echoing the code back defeats its purpose.
 *
 * This test scans `doctor.ts` for the regressive pattern and fails if any
 * `hint: '<snake_case_identifier>'` literal re-appears. Actionable hints
 * must be either a string constant (UPPER_SNAKE_CASE) or a template
 * literal — never a lowercase literal matching an error-code shape.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
describe('doctor.ts hint quality', () => {
    it('uses no error-code-shaped string literals as hint values', () => {
        const src = readFileSync(resolve(__dirname, '../tools/doctor.ts'), 'utf8');
        // Match `hint: '<lowercase_snake_case>'` — the regressive shape.
        // Allow UPPER_SNAKE_CASE identifiers (our hint constants) and backtick
        // templates (contextual hints) through.
        const regressive = /hint:\s*'[a-z][a-z_]*'/g;
        const matches = src.match(regressive) ?? [];
        expect(matches, `doctor.ts hint values must be actionable remediation sentences, not ` +
            `error-code echoes. Found: ${JSON.stringify(matches)}`).toEqual([]);
    });
    it('hint constants are substantial remediation sentences', () => {
        const src = readFileSync(resolve(__dirname, '../tools/doctor.ts'), 'utf8');
        // Pull every `const <NAME>_HINT = '...';` and assert the body is long
        // enough to carry a real instruction (>30 chars). Capture single-quoted
        // strings specifically — matching quotes are required so a backtick
        // inside the body does not prematurely end the capture.
        const constDecl = /const ([A-Z_]+_HINT)\s*=\s*'((?:\\.|[^'\\])*)';/g;
        const found = [];
        let m;
        while ((m = constDecl.exec(src)) !== null) {
            found.push([m[1], m[2]]);
        }
        expect(found.length).toBeGreaterThanOrEqual(5);
        for (const [name, body] of found) {
            expect(body.length, `${name} body too short to be actionable`).toBeGreaterThan(30);
        }
    });
});
//# sourceMappingURL=doctor-hint-quality.test.js.map