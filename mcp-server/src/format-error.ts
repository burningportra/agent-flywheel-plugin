/**
 * T1.3 (v3.16.0 noob-onboarding) — single canonical renderer for
 * FlywheelError values into the 3-line human-facing format:
 *
 *     ❌ <code>: <message>
 *        Hint: <narrative>
 *        Try:  <imperative paste-ready>
 *
 * Use `renderError(err)` everywhere a structured error needs to be
 * surfaced as plain text (CLI tools, skill bodies, log lines that a
 * human reads). Inside the MCP envelope, the structured fields
 * (`hint`, `try_this`) ride the JSON envelope unchanged — this
 * function is for the human-facing serialisation layer.
 *
 * Per-call `err.hint` / `err.try_this` overrides win over the
 * defaults from ERROR_META. A missing FlywheelErrorCode would have
 * already failed at compile time (T1.2 enforces exhaustiveness on
 * ERROR_META).
 */
import { ERROR_META } from './errors-try-this.js';
import { FlywheelError, type FlywheelToolError } from './errors.js';

/** The subset of a FlywheelError this renderer needs. */
export type RenderableError = {
  readonly code: FlywheelToolError['code'];
  readonly message: string;
  readonly hint?: string | undefined;
  readonly try_this?: string | undefined;
};

export function renderError(err: RenderableError | FlywheelError): string {
  const meta = ERROR_META[err.code];
  const hint = err.hint ?? meta.hint;
  const tryThis = (err as { try_this?: string }).try_this ?? meta.tryThis;
  return [
    `❌ ${err.code}: ${err.message}`,
    `   Hint: ${hint}`,
    `   Try:  ${tryThis}`,
  ].join('\n');
}
