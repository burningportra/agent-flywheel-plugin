import { createInitialState } from '../../types.js';
import type { FlywheelState } from '../../types.js';

export interface ExecCall {
  cmd: string;
  args: string[];
  result: { code: number; stdout: string; stderr: string };
}

/**
 * Creates a mock ExecFn that returns pre-programmed responses.
 * Unmatched commands return { code: 1, stdout: '', stderr: 'not mocked' }.
 */
export function createMockExec(calls: ExecCall[] = []) {
  return async (cmd: string, args: string[], _opts?: unknown) => {
    const match = calls.find(c => c.cmd === cmd && c.args.length === args.length && c.args.every((a, i) => args[i] === a));
    return match?.result ?? { code: 1, stdout: '', stderr: 'not mocked' };
  };
}

export function makeState(overrides: Partial<FlywheelState> = {}): FlywheelState {
  return { ...createInitialState(), ...overrides };
}
