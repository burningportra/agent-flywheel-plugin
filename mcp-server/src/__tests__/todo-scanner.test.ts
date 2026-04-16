import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  grepScanner,
  tsAstScanner,
  pythonTodoScanner,
  selectScanners,
  mergeAndDedup,
  _resetTsModuleCache,
} from '../todo-scanner.js';
import { createMockExec } from './helpers/mocks.js';
import type { TodoItem } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'todo-scanner');

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

// Dummy exec for scanners that don't use it (TS AST, Python).
const noopExec = createMockExec([]);

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

describe('tsAstScanner', () => {
  beforeEach(() => {
    _resetTsModuleCache();
  });

  it('has name "ts-ast"', () => {
    expect(tsAstScanner.name).toBe('ts-ast');
  });

  it('finds all 4 markers in ts-positive.ts', async () => {
    const items = await tsAstScanner.scan(noopExec, FIXTURE_DIR);
    const posItems = items.filter((t) => t.file === 'ts-positive.ts');

    // @todo refactor, @todo desc, TODO no colon, TODO: classic
    expect(posItems.length).toBe(4);

    const texts = posItems.map((t) => t.text);
    expect(texts).toContain('refactor this function');
    expect(texts).toContain('desc for jsdoc');
    expect(texts).toContain('no colon here');
    expect(texts).toContain('classic colon style');
  });

  it('finds zero markers in ts-negative.ts', async () => {
    const items = await tsAstScanner.scan(noopExec, FIXTURE_DIR);
    const negItems = items.filter((t) => t.file === 'ts-negative.ts');
    expect(negItems).toHaveLength(0);
  });
});

describe('pythonTodoScanner', () => {
  it('has name "python"', () => {
    expect(pythonTodoScanner.name).toBe('python');
  });

  it('finds all 3 markers in py-positive.py', async () => {
    const items = await pythonTodoScanner.scan(noopExec, FIXTURE_DIR);
    const posItems = items.filter((t) => t.file === 'py-positive.py');

    // # TODO classic, # XXX no colon, docstring TODO
    expect(posItems.length).toBe(3);

    const types = posItems.map((t) => t.type);
    expect(types).toContain('TODO');
    expect(types).toContain('XXX');
  });

  it('finds zero markers in py-negative.py', async () => {
    const items = await pythonTodoScanner.scan(noopExec, FIXTURE_DIR);
    const negItems = items.filter((t) => t.file === 'py-negative.py');
    expect(negItems).toHaveLength(0);
  });
});

describe('mergeAndDedup', () => {
  it('deduplicates on (file, line) — first wins', () => {
    const input: TodoItem[] = [
      { file: 'a.ts', line: 10, type: 'TODO', text: 'first' },
      { file: 'a.ts', line: 10, type: 'TODO', text: 'second' },
      { file: 'a.ts', line: 20, type: 'FIXME', text: 'different line' },
      { file: 'b.ts', line: 10, type: 'HACK', text: 'different file' },
    ];
    const result = mergeAndDedup(input);
    expect(result).toHaveLength(3);
    expect(result[0].text).toBe('first');
  });

  it('returns empty for empty input', () => {
    expect(mergeAndDedup([])).toEqual([]);
  });
});

describe('selectScanners', () => {
  it('returns all 3 scanners by default (empty env)', () => {
    const scanners = selectScanners({});
    expect(scanners).toHaveLength(3);
    expect(scanners.map((s) => s.name)).toEqual(['grep', 'ts-ast', 'python']);
  });

  it('returns [grepScanner] when FLYWHEEL_PROFILE_SCANNER=grep', () => {
    const scanners = selectScanners({ FLYWHEEL_PROFILE_SCANNER: 'grep' });
    expect(scanners).toEqual([grepScanner]);
  });

  it('returns all 3 when called with no argument', () => {
    const scanners = selectScanners();
    expect(scanners).toContain(grepScanner);
    expect(scanners.length).toBeGreaterThanOrEqual(3);
  });
});
