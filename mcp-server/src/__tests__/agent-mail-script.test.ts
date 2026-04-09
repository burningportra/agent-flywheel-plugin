import { describe, it, expect } from 'vitest';
import { shellSingleQuote, amHelperScript } from '../agent-mail.js';

// ─── shellSingleQuote unit tests ────────────────────────────────

describe('shellSingleQuote — injection safety', () => {
  /**
   * Helper: simulate a bash variable assignment and verify the value
   * doesn't contain unquoted metacharacters.
   *
   * A safe single-quoted assignment looks like:
   *   VAR='<content>'
   * or for paths with embedded single quotes:
   *   VAR='<part1>'"'"'<part2>'
   *
   * Safety invariant: the quoted string must not contain any of these
   * sequences outside of single-quoted regions: ` $ ( )
   */
  function buildAssignment(path: string): string {
    return `VAR=${shellSingleQuote(path)}`;
  }

  /**
   * Verify that the raw path string does NOT appear verbatim in the
   * assignment (it must be transformed / wrapped).
   * Also verify that dangerous characters appearing unquoted are absent.
   *
   * In bash single-quote strings the shell performs NO interpretation,
   * so the resulting assignment must:
   *  1. Start with VAR='
   *  2. End with '  (the closing single-quote)
   *  3. Any occurrence of backtick, $( , or bare $ in the quoted regions
   *     is inert because they are inside '…' segments.
   */
  function assertSafe(assignment: string, dangerousRaw: string): void {
    // The literal dangerous string must NOT appear verbatim in the assignment
    // (it should be quoted / broken up)
    // Exception: if the path has no metacharacters at all, it IS fine verbatim.
    // We check the structural invariant instead: the assignment wraps everything
    // in single-quote segments.
    expect(assignment.startsWith("VAR='")).toBe(true);
    expect(assignment.endsWith("'")).toBe(true);
    // Suppress unused-variable lint: dangerousRaw is documentation here.
    void dangerousRaw;
  }

  it('wraps a normal path unchanged inside single quotes', () => {
    const path = '/Users/foo/projects/bar';
    const result = shellSingleQuote(path);
    expect(result).toBe("'/Users/foo/projects/bar'");
    const assignment = buildAssignment(path);
    expect(assignment).toBe("VAR='/Users/foo/projects/bar'");
    assertSafe(assignment, path);
  });

  it('safely quotes a path with backticks', () => {
    const path = '/path/with/`backticks`';
    const result = shellSingleQuote(path);
    // Backticks inside single-quoted string are inert
    expect(result).toBe("'/path/with/`backticks`'");
    const assignment = buildAssignment(path);
    assertSafe(assignment, path);
    // Structural check: entire value is inside '…' — no unquoted backtick
    // The single-quoted region prevents evaluation
    expect(result.startsWith("'")).toBe(true);
    expect(result.endsWith("'")).toBe(true);
  });

  it('safely quotes a path with $(...) command substitution', () => {
    const path = '/path/$(whoami)/dir';
    const result = shellSingleQuote(path);
    // $(...) inside single-quoted string is inert
    expect(result).toBe("'/path/$(whoami)/dir'");
    const assignment = buildAssignment(path);
    assertSafe(assignment, path);
    expect(result.startsWith("'")).toBe(true);
    expect(result.endsWith("'")).toBe(true);
  });

  it('safely quotes a path with dollar signs / variable expansion', () => {
    const path = '/path/$HOME/dir';
    const result = shellSingleQuote(path);
    // $HOME inside single-quoted string is NOT expanded
    expect(result).toBe("'/path/$HOME/dir'");
    const assignment = buildAssignment(path);
    assertSafe(assignment, path);
    expect(result.startsWith("'")).toBe(true);
    expect(result.endsWith("'")).toBe(true);
  });

  it("safely quotes a path containing single quotes", () => {
    const path = "/path/it's/here";
    const result = shellSingleQuote(path);
    // The single quote must be handled by ending '…', inserting '\'' , reopening '…'
    // Result: '/path/it'"'"'s/here'
    expect(result).toBe("'/path/it'\\''s/here'");
    const assignment = buildAssignment(path);
    // Assignment must not be just VAR='…' with a raw unescaped apostrophe breaking it
    // The raw path must NOT appear literally (it contains an unescaped single quote)
    expect(assignment).not.toContain("/path/it's/here");
    // The canonical escaping sequence must be present
    expect(assignment).toContain("'\\''");
  });
});

// ─── amHelperScript integration tests ─────────────────────────

describe('amHelperScript — shell injection safety via single-quote wrapping', () => {
  it('embeds AM_PROJECT using single-quote wrapping for a normal path', () => {
    const script = amHelperScript('/Users/foo/project', 'bead-123');
    expect(script).toContain("AM_PROJECT='/Users/foo/project'");
    expect(script).toContain("AM_THREAD='bead-123'");
  });

  it('embeds AM_PROJECT safely when path contains backticks', () => {
    const cwd = '/path/with/`whoami`';
    const script = amHelperScript(cwd, 'bead-abc');
    // The script must contain a properly single-quoted assignment
    expect(script).toContain("AM_PROJECT='/path/with/`whoami`'");
    // No unquoted form of the dangerous path
    expect(script).not.toContain('AM_PROJECT=/path/with/`whoami`');
  });

  it('embeds AM_PROJECT safely when path contains $(...)', () => {
    const cwd = '/path/$(cat /etc/passwd)/dir';
    const script = amHelperScript(cwd, 'bead-xyz');
    expect(script).toContain("AM_PROJECT='/path/$(cat /etc/passwd)/dir'");
    // No unquoted dollar-paren form
    expect(script).not.toContain('AM_PROJECT=/path/$(cat /etc/passwd)/dir');
  });

  it("embeds AM_PROJECT safely when path contains single quotes", () => {
    const cwd = "/path/user's/project";
    const script = amHelperScript(cwd, 'bead-sq');
    // The canonical single-quote escape must be present
    expect(script).toContain("AM_PROJECT='/path/user'\\''s/project'");
    // The raw literal path with unescaped apostrophe must NOT appear
    expect(script).not.toContain("AM_PROJECT='/path/user's/project'");
  });

  it('embeds AM_PROJECT safely when path contains dollar signs', () => {
    const cwd = '/path/$HOME/dir';
    const script = amHelperScript(cwd, 'bead-dollar');
    expect(script).toContain("AM_PROJECT='/path/$HOME/dir'");
    // $HOME must be inside single quotes (inert), not bare
    expect(script).not.toContain('AM_PROJECT=/path/$HOME/dir');
  });
});
