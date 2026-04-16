import { describe, it, expect } from 'vitest';
import { grepScanner, selectScanners } from '../todo-scanner.js';
import { createMockExec } from './helpers/mocks.js';

const GREP_ARGS = [
  '-rn',
  '--include=*.ts', '--include=*.js', '--include=*.tsx', '--include=*.jsx',
  '--include=*.py', '--include=*.rs', '--include=*.go', '--include=*.rb',
  '--include=*.java', '--include=*.kt', '--include=*.swift',
  '--exclude-dir=node_modules',
  '--exclude-dir=.git',
  '--exclude-dir=dist',
  '--exclude-dir=build',
  '--exclude-dir=vendor',
  '--exclude-dir=target',
  '--exclude-dir=__pycache__',
  '--exclude-dir=.venv',
  '--exclude-dir=.pi-flywheel',
  '-E', '(TODO|FIXME|HACK|XXX):',
  '.',
];

describe('grepScanner', () => {
  it('has name "grep"', () => {
    expect(grepScanner.name).toBe('grep');
  });

  it('parses grep output into TodoItems', async () => {
    const stdout = [
      './src/foo.ts:10:  // TODO: implement this',
      './src/bar.py:42:    # FIXME: broken edge case',
      './src/baz.rs:7:// HACK: workaround for upstream bug',
      './src/qux.go:3:// XXX: revisit',
    ].join('\n') + '\n';

    const exec = createMockExec([
      { cmd: 'grep', args: GREP_ARGS, result: { code: 0, stdout, stderr: '' } },
    ]);

    const todos = await grepScanner.scan(exec, '/fake/repo');

    expect(todos).toEqual([
      { file: 'src/foo.ts', line: 10, type: 'TODO', text: 'implement this' },
      { file: 'src/bar.py', line: 42, type: 'FIXME', text: 'broken edge case' },
      { file: 'src/baz.rs', line: 7, type: 'HACK', text: 'workaround for upstream bug' },
      { file: 'src/qux.go', line: 3, type: 'XXX', text: 'revisit' },
    ]);
  });

  it('returns empty array when grep exits non-zero (no matches)', async () => {
    const exec = createMockExec([
      { cmd: 'grep', args: GREP_ARGS, result: { code: 1, stdout: '', stderr: '' } },
    ]);

    const todos = await grepScanner.scan(exec, '/fake/repo');
    expect(todos).toEqual([]);
  });

  it('skips lines that do not match the expected format', async () => {
    const stdout = [
      './src/foo.ts:10:  // TODO: good one',
      'some-garbage-line',
      './src/bar.ts:no-line-number: TODO: bad',
    ].join('\n') + '\n';

    const exec = createMockExec([
      { cmd: 'grep', args: GREP_ARGS, result: { code: 0, stdout, stderr: '' } },
    ]);

    const todos = await grepScanner.scan(exec, '/fake/repo');
    expect(todos).toHaveLength(1);
    expect(todos[0]).toEqual({ file: 'src/foo.ts', line: 10, type: 'TODO', text: 'good one' });
  });

  it('caps output at 50 items', async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 75; i++) {
      lines.push(`./src/file${i}.ts:${i}:  // TODO: item ${i}`);
    }
    const exec = createMockExec([
      { cmd: 'grep', args: GREP_ARGS, result: { code: 0, stdout: lines.join('\n') + '\n', stderr: '' } },
    ]);

    const todos = await grepScanner.scan(exec, '/fake/repo');
    expect(todos).toHaveLength(50);
  });
});

describe('selectScanners', () => {
  it('returns [grepScanner] by default (empty env)', () => {
    const scanners = selectScanners({});
    expect(scanners).toEqual([grepScanner]);
  });

  it('returns [grepScanner] when FLYWHEEL_PROFILE_SCANNER=grep', () => {
    const scanners = selectScanners({ FLYWHEEL_PROFILE_SCANNER: 'grep' });
    expect(scanners).toEqual([grepScanner]);
  });

  it('returns [grepScanner] when called with no argument', () => {
    const scanners = selectScanners();
    expect(scanners).toContain(grepScanner);
  });
});
