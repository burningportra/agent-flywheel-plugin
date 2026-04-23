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
export {};
//# sourceMappingURL=doctor-hint-quality.test.d.ts.map