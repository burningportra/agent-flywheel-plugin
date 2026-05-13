/**
 * T1.1 (v3.16.0 noob-onboarding) — canonical home for the per-error-code
 * `hint` + `try_this` metadata. Currently re-exports the source-of-truth
 * dictionaries from `errors.ts`; T1.2 will replace these dicts with an
 * `ERROR_META` table that holds both fields side-by-side.
 *
 * The re-export shape is the public surface other modules (R-007 wiring,
 * capabilities snapshot, error-contract tests) depend on. Keep it stable.
 */
export {
  DEFAULT_HINTS,
  DEFAULT_TRY_THIS,
  FLYWHEEL_ERROR_CODES,
  type FlywheelErrorCode,
} from './errors.js';
