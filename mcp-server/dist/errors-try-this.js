/**
 * T1.1 + T1.2 (v3.16.0 noob-onboarding) — canonical home for the
 * per-error-code metadata table.
 *
 * Public surface (kept stable for T1.3 + downstream consumers):
 *   - DEFAULT_HINTS         — re-exported from errors.ts (snake_case wire)
 *   - DEFAULT_TRY_THIS      — re-exported from errors.ts (snake_case wire)
 *   - FLYWHEEL_ERROR_CODES  — re-exported from errors.ts
 *   - FlywheelErrorCode     — re-exported type
 *   - ERROR_META            — Record<FlywheelErrorCode, ErrorMeta>
 *                             camelCase view derived once at module load
 *                             from DEFAULT_HINTS + DEFAULT_TRY_THIS; this
 *                             is the source format T1.3 `renderError`
 *                             reads from.
 *
 * Why ERROR_META is derived rather than hand-written:
 *   - DEFAULT_HINTS and DEFAULT_TRY_THIS are already
 *     Record<FlywheelErrorCode, string> — TypeScript already rejects
 *     compile time any added FlywheelErrorCode that is missing from
 *     either dict. Deriving ERROR_META preserves the single source of
 *     truth and makes T1.2 a strictly additive change (no risk of
 *     prose drift between the dicts and a parallel hand-written table).
 *   - The build-time guard `scripts/verify-error-meta.js` additionally
 *     fails the build on empty strings, which the type system cannot
 *     catch.
 */
import { FLYWHEEL_ERROR_CODES, DEFAULT_HINTS, DEFAULT_TRY_THIS, } from './errors.js';
export { DEFAULT_HINTS, DEFAULT_TRY_THIS, FLYWHEEL_ERROR_CODES, };
export const ERROR_META = Object.fromEntries(FLYWHEEL_ERROR_CODES.map((code) => [
    code,
    { hint: DEFAULT_HINTS[code], tryThis: DEFAULT_TRY_THIS[code] },
]));
//# sourceMappingURL=errors-try-this.js.map