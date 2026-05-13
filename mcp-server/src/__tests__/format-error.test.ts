import { describe, it, expect } from 'vitest';
import { renderError } from '../format-error.js';
import { FlywheelError } from '../errors.js';
import { ERROR_META } from '../errors-try-this.js';

describe('renderError (T1.3)', () => {
  it('renders the 3-line format with defaults from ERROR_META', () => {
    const err = {
      code: 'missing_prerequisite' as const,
      message: 'br not installed',
    };
    const out = renderError(err);
    expect(out).toBe(
      [
        '❌ missing_prerequisite: br not installed',
        `   Hint: ${ERROR_META.missing_prerequisite.hint}`,
        `   Try:  ${ERROR_META.missing_prerequisite.tryThis}`,
      ].join('\n'),
    );
  });

  it('per-call hint and try_this override the ERROR_META defaults', () => {
    const out = renderError({
      code: 'agent_mail_unreachable',
      message: 'connection refused',
      hint: 'override hint',
      try_this: 'override try',
    });
    expect(out).toBe(
      [
        '❌ agent_mail_unreachable: connection refused',
        '   Hint: override hint',
        '   Try:  override try',
      ].join('\n'),
    );
  });

  it('accepts a FlywheelError instance', () => {
    const err = new FlywheelError({
      code: 'invalid_input',
      message: 'wrong shape',
    });
    const out = renderError(err);
    expect(out.startsWith('❌ invalid_input: wrong shape\n')).toBe(true);
    expect(out).toContain('Hint:');
    expect(out).toContain('Try: ');
  });

  it('output is exactly 3 lines for every FlywheelErrorCode (snapshot of the contract)', () => {
    for (const code of Object.keys(ERROR_META) as Array<keyof typeof ERROR_META>) {
      const out = renderError({ code, message: 'sample' });
      const lines = out.split('\n');
      expect(lines.length, `code ${code} produced ${lines.length} lines`).toBe(3);
      expect(lines[0]).toMatch(/^❌ /);
      expect(lines[1]).toMatch(/^   Hint: /);
      expect(lines[2]).toMatch(/^   Try:  /);
    }
  });

  it('locks the canonical missing_prerequisite snapshot', () => {
    expect(
      renderError({
        code: 'missing_prerequisite',
        message: 'br not installed',
        hint: 'run /flywheel-setup to install dependencies',
        try_this: '/agent-flywheel:flywheel-setup',
      }),
    ).toMatchInlineSnapshot(`
      "❌ missing_prerequisite: br not installed
         Hint: run /flywheel-setup to install dependencies
         Try:  /agent-flywheel:flywheel-setup"
    `);
  });
});
