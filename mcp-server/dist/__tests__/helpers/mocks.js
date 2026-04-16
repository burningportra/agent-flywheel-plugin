import { createInitialState } from '../../types.js';
/**
 * Creates a mock ExecFn that returns pre-programmed responses.
 * Unmatched commands return { code: 1, stdout: '', stderr: 'not mocked' }.
 */
export function createMockExec(calls = []) {
    return async (cmd, args, _opts) => {
        const match = calls.find(c => c.cmd === cmd && c.args.length === args.length && c.args.every((a, i) => args[i] === a));
        return match?.result ?? { code: 1, stdout: '', stderr: 'not mocked' };
    };
}
export function makeState(overrides = {}) {
    return { ...createInitialState(), ...overrides };
}
//# sourceMappingURL=mocks.js.map