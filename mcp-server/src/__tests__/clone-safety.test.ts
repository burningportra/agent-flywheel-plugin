import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_ALLOWED_HOSTS,
  CloneSafetyError,
  validateCloneUrl,
  validateGitRef,
  safeClone,
  formatProvenance,
} from '../utils/clone-safety.js';
import type { ExecFn } from '../exec.js';

describe('validateCloneUrl', () => {
  it('accepts a canonical github.com https URL', () => {
    const { url, source } = validateCloneUrl('https://github.com/foo/bar.git');
    expect(url.hostname).toBe('github.com');
    expect(source).toBe('github.com/foo/bar');
  });

  it('accepts all default allowed hosts', () => {
    for (const host of DEFAULT_ALLOWED_HOSTS) {
      expect(() => validateCloneUrl(`https://${host}/foo/bar`)).not.toThrow();
    }
  });

  it('rejects empty URL', () => {
    expect(() => validateCloneUrl('')).toThrow(CloneSafetyError);
  });

  it('rejects URL containing newline (log-injection / arg-smuggling)', () => {
    expect(() => validateCloneUrl('https://github.com/foo/bar\n--upload-pack=x')).toThrow(
      /control characters/
    );
  });

  it('rejects URL starting with "-" (arg-masquerading)', () => {
    expect(() => validateCloneUrl('--upload-pack=evil')).toThrow(/must not start with/);
  });

  it('rejects malformed URLs', () => {
    expect(() => validateCloneUrl('not a url')).toThrow(/not a valid URL/);
  });

  it('rejects non-https by default', () => {
    expect(() => validateCloneUrl('http://github.com/foo/bar')).toThrow(/https/);
  });

  it('allows non-https when FLYWHEEL_ALLOW_INSECURE_CLONE=1', () => {
    expect(() =>
      validateCloneUrl('http://github.com/foo/bar', {
        env: { FLYWHEEL_ALLOW_INSECURE_CLONE: '1' } as NodeJS.ProcessEnv,
      })
    ).not.toThrow();
  });

  it('rejects file:// even with insecure bypass', () => {
    expect(() =>
      validateCloneUrl('file:///etc/passwd', {
        env: { FLYWHEEL_ALLOW_INSECURE_CLONE: '1' } as NodeJS.ProcessEnv,
      })
    ).toThrow(/protocol not allowed/);
  });

  it('rejects javascript: URLs', () => {
    expect(() =>
      validateCloneUrl('javascript:alert(1)', {
        env: { FLYWHEEL_ALLOW_INSECURE_CLONE: '1' } as NodeJS.ProcessEnv,
      })
    ).toThrow();
  });

  it('rejects hosts not in allowlist', () => {
    expect(() => validateCloneUrl('https://evil.example.com/foo/bar')).toThrow(
      /not in allowlist/
    );
  });

  it('accepts hosts added via extraAllowedHosts (e.g. GHE)', () => {
    expect(() =>
      validateCloneUrl('https://ghe.corp.example/foo/bar', {
        extraAllowedHosts: ['ghe.corp.example'],
      })
    ).not.toThrow();
  });

  it('rejects URLs with embedded credentials', () => {
    expect(() => validateCloneUrl('https://user:pass@github.com/foo/bar')).toThrow(
      /embedded credentials/
    );
  });

  it('normalizes source (strips .git suffix)', () => {
    const { source } = validateCloneUrl('https://github.com/foo/bar.git');
    expect(source).toBe('github.com/foo/bar');
  });
});

describe('validateGitRef', () => {
  it('accepts a normal branch name', () => {
    expect(() => validateGitRef('main')).not.toThrow();
    expect(() => validateGitRef('feature/x')).not.toThrow();
    expect(() => validateGitRef('v1.2.3')).not.toThrow();
  });

  it('rejects empty ref', () => {
    expect(() => validateGitRef('')).toThrow(/empty/);
  });

  it('rejects ref starting with "-"', () => {
    expect(() => validateGitRef('--upload-pack=x')).toThrow(/must not start/);
  });

  it('rejects whitespace in ref', () => {
    expect(() => validateGitRef('my branch')).toThrow(/whitespace/);
  });

  it('rejects ".." in ref', () => {
    expect(() => validateGitRef('..')).toThrow(/invalid sequence/);
  });

  it('rejects ":" in ref', () => {
    expect(() => validateGitRef('foo:bar')).toThrow(/invalid sequence/);
  });
});

describe('safeClone', () => {
  function makeMockExec(
    rev: string = 'abcdef1234567890abcdef1234567890abcdef12'
  ): { exec: ExecFn; calls: Array<{ cmd: string; args: string[] }> } {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec: ExecFn = vi.fn(async (cmd, args, _opts) => {
      calls.push({ cmd, args });
      if (cmd === 'git' && args[0] === 'clone') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'git' && args[0] === 'rev-parse') {
        return { code: 0, stdout: rev + '\n', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected cmd' };
    });
    return { exec, calls };
  }

  it('clones and returns pinned HEAD SHA', async () => {
    const { exec, calls } = makeMockExec();
    const result = await safeClone(exec, 'https://github.com/foo/bar.git', '/tmp/x');
    expect(result.path).toBe('/tmp/x');
    expect(result.head_sha).toBe('abcdef1234567890abcdef1234567890abcdef12');
    expect(result.source).toBe('github.com/foo/bar');
    // Clone args include defense-in-depth flags
    const cloneCall = calls[0];
    expect(cloneCall.args).toContain('--depth');
    expect(cloneCall.args).toContain('--single-branch');
    expect(cloneCall.args).toContain('--no-tags');
    expect(cloneCall.args).toContain('--recurse-submodules=no');
    expect(cloneCall.args).toContain('--');
  });

  it('passes validated branch through', async () => {
    const { exec, calls } = makeMockExec();
    await safeClone(exec, 'https://github.com/foo/bar.git', '/tmp/x', {
      branch: 'main',
    });
    expect(calls[0].args).toContain('--branch');
    expect(calls[0].args).toContain('main');
  });

  it('rejects malicious branch ref', async () => {
    const { exec } = makeMockExec();
    await expect(
      safeClone(exec, 'https://github.com/foo/bar.git', '/tmp/x', {
        branch: '--upload-pack=evil',
      })
    ).rejects.toThrow(CloneSafetyError);
  });

  it('rejects non-allowed host without touching exec', async () => {
    const exec = vi.fn() as unknown as ExecFn;
    await expect(
      safeClone(exec, 'https://evil.example.com/foo/bar', '/tmp/x')
    ).rejects.toThrow(/allowlist/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('throws CloneSafetyError when clone exits non-zero', async () => {
    const exec: ExecFn = vi.fn(async () => ({
      code: 128,
      stdout: '',
      stderr: 'not found',
    }));
    await expect(
      safeClone(exec, 'https://github.com/foo/bar.git', '/tmp/x')
    ).rejects.toThrow(/clone failed/);
  });

  it('throws when HEAD SHA is not a valid git object id', async () => {
    const exec: ExecFn = vi.fn(async (cmd, args) => {
      if (args[0] === 'clone') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: 'not-a-sha\n', stderr: '' };
    });
    await expect(
      safeClone(exec, 'https://github.com/foo/bar.git', '/tmp/x')
    ).rejects.toThrow(/object id/);
  });
});

describe('formatProvenance', () => {
  it('formats a readable one-liner for research artifacts', () => {
    const s = formatProvenance({
      path: '/tmp/x',
      head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
      url: 'https://github.com/foo/bar.git',
      source: 'github.com/foo/bar',
    });
    expect(s).toBe('github.com/foo/bar @ abcdef1 (https://github.com/foo/bar.git)');
  });
});
