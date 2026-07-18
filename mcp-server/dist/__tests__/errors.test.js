import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_HINTS, DEFAULT_RETRYABLE, DEFAULT_TRY_THIS, FlywheelError, FlywheelStructuredErrorSchema, classifyExecError, errMsg, makeFlywheelErrorResult, registerTelemetryHook, } from '../errors.js';
afterEach(() => {
    registerTelemetryHook(() => undefined);
});
describe('makeFlywheelErrorResult', () => {
    it('returns the MCP error envelope with default hint and retryability', () => {
        const result = makeFlywheelErrorResult('flywheel_plan', 'planning', {
            code: 'cli_failure',
            message: 'br list failed',
        });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: 'text', text: 'br list failed' }]);
        expect(result.structuredContent).toMatchObject({
            tool: 'flywheel_plan',
            version: 1,
            status: 'error',
            phase: 'planning',
            data: {
                kind: 'error',
                error: {
                    code: 'cli_failure',
                    message: 'br list failed',
                    retryable: DEFAULT_RETRYABLE.cli_failure,
                    hint: DEFAULT_HINTS.cli_failure,
                    try_this: DEFAULT_TRY_THIS.cli_failure,
                    phase: 'planning',
                    tool: 'flywheel_plan',
                },
            },
        });
        expect(() => FlywheelStructuredErrorSchema.parse(result.structuredContent)).not.toThrow();
        expect(Date.parse(result.structuredContent.data.error.timestamp ?? '')).not.toBeNaN();
    });
    it('preserves caller overrides and sanitizes causes before returning them', () => {
        const result = makeFlywheelErrorResult('flywheel_doctor', 'idle', {
            code: 'internal_error',
            message: 'doctor failed',
            retryable: false,
            hint: 'Check the doctor output.',
            try_this: 'Run flywheel_doctor again with the same cwd.',
            cause: 'failed at /tmp/private/project/secret.txt',
            details: { checkName: 'dist_drift' },
        });
        const error = result.structuredContent.data.error;
        expect(error.retryable).toBe(false);
        expect(error.hint).toBe('Check the doctor output.');
        expect(error.try_this).toBe('Run flywheel_doctor again with the same cwd.');
        expect(error.cause).toContain('<path>/secret.txt');
        expect(error.cause).not.toContain('/tmp/private/project');
        expect(error.details).toEqual({ checkName: 'dist_drift' });
    });
});
describe('FlywheelError propagation', () => {
    it('keeps the tagged code when thrown through nested helpers', () => {
        const leaf = () => {
            throw new FlywheelError({
                code: 'blocked_state',
                message: 'checkpoint phase is blocked',
                details: { phase: 'review' },
            });
        };
        const third = () => leaf();
        const second = () => third();
        const first = () => second();
        expect(first).toThrow(FlywheelError);
        try {
            first();
            throw new Error('expected FlywheelError');
        }
        catch (err) {
            expect(err).toBeInstanceOf(FlywheelError);
            const flywheelErr = err;
            expect(flywheelErr.code).toBe('blocked_state');
            expect(flywheelErr.retryable).toBe(DEFAULT_RETRYABLE.blocked_state);
            expect(flywheelErr.hint).toBe(DEFAULT_HINTS.blocked_state);
            expect(flywheelErr.details).toEqual({ phase: 'review' });
        }
    });
    it('serializes custom metadata without losing the code', () => {
        const error = new FlywheelError({
            code: 'invalid_input',
            message: 'bad payload',
            retryable: true,
            hint: 'Use the documented argument shape.',
            try_this: 'Retry with a valid payload.',
            cause: 'zod parse failed',
            details: { field: 'cwd' },
        });
        expect(error.toJSON()).toEqual({
            code: 'invalid_input',
            message: 'bad payload',
            retryable: true,
            hint: 'Use the documented argument shape.',
            try_this: 'Retry with a valid payload.',
            cause: 'zod parse failed',
            details: { field: 'cwd' },
        });
    });
});
describe('registerTelemetryHook', () => {
    it('fires with the error code and hashable cause when an envelope is built', () => {
        const calls = [];
        registerTelemetryHook((code, ctx) => {
            calls.push({ code, ctx });
        });
        makeFlywheelErrorResult('flywheel_review', 'reviewing', {
            code: 'exec_timeout',
            message: 'review timed out',
            cause: 'Timed out after 8000ms',
        });
        expect(calls).toEqual([
            { code: 'exec_timeout', ctx: { hashable: 'Timed out after 8000ms' } },
        ]);
    });
    it('does not let telemetry hook failures break error envelope creation', () => {
        registerTelemetryHook(() => {
            throw new Error('telemetry unavailable');
        });
        const result = makeFlywheelErrorResult('flywheel_review', 'reviewing', {
            code: 'telemetry_store_failed',
            message: 'telemetry write failed',
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent.data.error.code).toBe('telemetry_store_failed');
    });
});
describe('classifyExecError', () => {
    it('maps timeout text, including ETIMEDOUT context, to exec_timeout', () => {
        const result = classifyExecError(new Error('Timed out after 1000ms: connect ETIMEDOUT'));
        expect(result).toEqual({
            code: 'exec_timeout',
            retryable: true,
            cause: 'Timed out after 1000ms: connect ETIMEDOUT',
        });
    });
    it('maps aborted errors to exec_aborted', () => {
        const result = classifyExecError(new DOMException('signal is aborted', 'AbortError'));
        expect(result.code).toBe('exec_aborted');
        expect(result.retryable).toBe(false);
        expect(result.cause).toBe('signal is aborted');
    });
    it('maps ENOENT and non-zero exit failures to cli_failure', () => {
        expect(classifyExecError(new Error('spawn br ENOENT'))).toEqual({
            code: 'cli_failure',
            retryable: true,
            cause: 'spawn br ENOENT',
        });
        expect(classifyExecError(new Error('Command failed with exit code 2'))).toEqual({
            code: 'cli_failure',
            retryable: true,
            cause: 'Command failed with exit code 2',
        });
    });
});
describe('errMsg', () => {
    it('returns messages for Error objects and raw strings', () => {
        expect(errMsg(new Error('boom'))).toBe('boom');
        expect(errMsg('plain failure')).toBe('plain failure');
    });
    it('coerces null, undefined, and circular objects without throwing', () => {
        const circular = {};
        circular.self = circular;
        expect(errMsg(null)).toBe('null');
        expect(errMsg(undefined)).toBe('undefined');
        expect(() => errMsg(circular)).not.toThrow();
        expect(errMsg(circular)).toBe('[object Object]');
    });
});
//# sourceMappingURL=errors.test.js.map