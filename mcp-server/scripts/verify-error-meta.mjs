#!/usr/bin/env node
/**
 * T1.2 (v3.16.0 noob-onboarding) build-time gate: every FlywheelErrorCode
 * MUST have a non-empty `hint` AND `tryThis` in ERROR_META.
 *
 * Runs against the compiled `dist/` outputs so the script does not need a
 * TypeScript transpiler at runtime. Wire into `package.json` and CI to
 * catch drift (a new code added to FLYWHEEL_ERROR_CODES without matching
 * hint + tryThis entries) at build time rather than at first agent
 * encounter.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const errorsTryThisUrl = new URL(
  `file://${resolve(here, '..', 'dist', 'errors-try-this.js')}`,
);
const errorsUrl = new URL(
  `file://${resolve(here, '..', 'dist', 'errors.js')}`,
);

const { ERROR_META } = await import(errorsTryThisUrl.href);
const { FLYWHEEL_ERROR_CODES } = await import(errorsUrl.href);

const problems = [];
for (const code of FLYWHEEL_ERROR_CODES) {
  const entry = ERROR_META[code];
  if (!entry) {
    problems.push(`${code}: missing from ERROR_META`);
    continue;
  }
  if (typeof entry.hint !== 'string' || entry.hint.length === 0) {
    problems.push(`${code}: empty/missing hint`);
  }
  if (typeof entry.tryThis !== 'string' || entry.tryThis.length === 0) {
    problems.push(`${code}: empty/missing tryThis`);
  }
}

if (problems.length > 0) {
  console.error('verify-error-meta: FAIL');
  for (const p of problems) console.error('  -', p);
  process.exit(1);
}

console.log(
  `verify-error-meta: OK — ${FLYWHEEL_ERROR_CODES.length} codes, all carry hint + tryThis`,
);
