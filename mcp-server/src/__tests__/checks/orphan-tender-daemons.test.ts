/**
 * Tests for the orphan-tender-daemons doctor check (bead n3a).
 */

import { describe, it, expect } from 'vitest';

import {
  ORPHAN_TENDER_DAEMONS_CHECK_NAME,
  checkOrphanTenderDaemons,
  classifyOrphans,
  parseTenderDaemonProcesses,
  parseTmuxSessions,
} from '../../checks/orphan-tender-daemons.js';
import type { ExecFn } from '../../exec.js';

// ─── pure parsers ─────────────────────────────────────────────────────────

describe('parseTenderDaemonProcesses', () => {
  it('extracts pid and --session from a tender-daemon line', () => {
    const ps = [
      '  101 /usr/bin/zsh',
      '  202 node /opt/flywheel/mcp-server/dist/tender-daemon.js --session swarm-alpha --foo bar',
      '  303 node tender-daemon.js --session swarm-beta',
      '  404 node /unrelated.js',
    ].join('\n');

    const out = parseTenderDaemonProcesses(ps);
    expect(out).toEqual([
      { pid: 202, session: 'swarm-alpha', rawCommand: expect.stringContaining('tender-daemon.js') },
      { pid: 303, session: 'swarm-beta', rawCommand: expect.stringContaining('tender-daemon.js') },
    ]);
  });

  it('returns session=null when --session is absent', () => {
    const ps = '  555 node tender-daemon.js --some-other-flag x';
    const out = parseTenderDaemonProcesses(ps);
    expect(out).toEqual([{ pid: 555, session: null, rawCommand: expect.any(String) }]);
  });

  it('skips blank lines and lines with no pid', () => {
    const ps = '\n  not-a-pid tender-daemon.js\n  777 node tender-daemon.js --session live\n';
    const out = parseTenderDaemonProcesses(ps);
    expect(out).toHaveLength(1);
    expect(out[0]!.pid).toBe(777);
  });
});

describe('parseTmuxSessions', () => {
  it('parses a list of session names', () => {
    expect(parseTmuxSessions('alpha\nbeta\n  \ngamma\n')).toEqual(new Set(['alpha', 'beta', 'gamma']));
  });
  it('returns empty set on empty output', () => {
    expect(parseTmuxSessions('')).toEqual(new Set());
  });
});

describe('classifyOrphans', () => {
  it('reports daemons whose session is not live as orphans', () => {
    const daemons = [
      { pid: 1, session: 'live-one', rawCommand: '' },
      { pid: 2, session: 'dead-one', rawCommand: '' },
      { pid: 3, session: null, rawCommand: '' }, // no --session arg → orphan
    ];
    const live = new Set(['live-one']);
    const orphans = classifyOrphans(daemons, live);
    expect(orphans.map((o) => o.pid)).toEqual([2, 3]);
  });

  it('returns empty when every daemon is live', () => {
    const daemons = [
      { pid: 1, session: 'a', rawCommand: '' },
      { pid: 2, session: 'b', rawCommand: '' },
    ];
    expect(classifyOrphans(daemons, new Set(['a', 'b']))).toEqual([]);
  });
});

// ─── async check ──────────────────────────────────────────────────────────

interface ExecCall {
  cmd: string;
  args: readonly string[];
  result: { code: number; stdout: string; stderr: string };
}

function makeExec(calls: ExecCall[]): ExecFn {
  return async (cmd, args) => {
    const match = calls.find(
      (c) => c.cmd === cmd && c.args.length === args.length && c.args.every((a, i) => a === args[i]),
    );
    if (!match) {
      // Loose match by first arg (good enough for `ps -eo pid,command`,
      // `tmux list-sessions -F '#S'`).
      const loose = calls.find((c) => c.cmd === cmd && c.args[0] === args[0]);
      if (loose) return loose.result;
      return { code: 1, stdout: '', stderr: `not mocked: ${cmd} ${args.join(' ')}` };
    }
    return match.result;
  };
}

describe('checkOrphanTenderDaemons', () => {
  const ac = new AbortController();
  const now = () => Date.now();

  it('green when no tender-daemons are running', async () => {
    const exec = makeExec([
      { cmd: 'ps', args: ['-eo', 'pid,command'], result: { code: 0, stdout: '\n', stderr: '' } },
    ]);
    const out = await checkOrphanTenderDaemons(exec, '/tmp', ac.signal, 2000, now);
    expect(out.name).toBe(ORPHAN_TENDER_DAEMONS_CHECK_NAME);
    expect(out.severity).toBe('green');
    expect(out.message).toMatch(/no tender-daemons/);
  });

  it('green when every running daemon has a live tmux session', async () => {
    const exec = makeExec([
      {
        cmd: 'ps',
        args: ['-eo', 'pid,command'],
        result: {
          code: 0,
          stdout: '  111 node tender-daemon.js --session live-one\n',
          stderr: '',
        },
      },
      {
        cmd: 'tmux',
        args: ['list-sessions', '-F', '#S'],
        result: { code: 0, stdout: 'live-one\nother\n', stderr: '' },
      },
    ]);
    const out = await checkOrphanTenderDaemons(exec, '/tmp', ac.signal, 2000, now);
    expect(out.severity).toBe('green');
    expect(out.message).toMatch(/1 tender-daemon running, all sessions live/);
  });

  it('yellow with PIDs and kill -TERM hint when an orphan is found', async () => {
    const exec = makeExec([
      {
        cmd: 'ps',
        args: ['-eo', 'pid,command'],
        result: {
          code: 0,
          stdout: [
            '  201 node tender-daemon.js --session live-one',
            '  202 node tender-daemon.js --session ghost-session',
            '  203 node tender-daemon.js --session another-ghost',
          ].join('\n'),
          stderr: '',
        },
      },
      {
        cmd: 'tmux',
        args: ['list-sessions', '-F', '#S'],
        result: { code: 0, stdout: 'live-one\n', stderr: '' },
      },
    ]);
    const out = await checkOrphanTenderDaemons(exec, '/tmp', ac.signal, 2000, now);
    expect(out.severity).toBe('yellow');
    expect(out.message).toMatch(/2 orphan tender-daemons detected/);
    expect(out.message).toMatch(/pid 202/);
    expect(out.message).toMatch(/pid 203/);
    expect(out.hint).toBeDefined();
    expect(out.hint!).toMatch(/kill -TERM 202 203/);
  });

  it('treats missing tmux as "no live sessions" — every daemon becomes orphan', async () => {
    const exec = makeExec([
      {
        cmd: 'ps',
        args: ['-eo', 'pid,command'],
        result: { code: 0, stdout: '  500 node tender-daemon.js --session orphaned\n', stderr: '' },
      },
      // tmux not installed.
      {
        cmd: 'tmux',
        args: ['list-sessions', '-F', '#S'],
        result: { code: 1, stdout: '', stderr: 'no server' },
      },
    ]);
    const out = await checkOrphanTenderDaemons(exec, '/tmp', ac.signal, 2000, now);
    expect(out.severity).toBe('yellow');
    expect(out.message).toMatch(/pid 500/);
  });

  it('yellow when ps itself fails (cannot probe)', async () => {
    const exec = makeExec([
      { cmd: 'ps', args: ['-eo', 'pid,command'], result: { code: 1, stdout: '', stderr: 'denied' } },
    ]);
    const out = await checkOrphanTenderDaemons(exec, '/tmp', ac.signal, 2000, now);
    expect(out.severity).toBe('yellow');
    expect(out.message).toMatch(/ps -eo pid,command failed/);
  });
});
