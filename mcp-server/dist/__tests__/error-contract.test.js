import { describe, it, expect } from 'vitest';
import { FLYWHEEL_ERROR_CODES, FlywheelErrorCodeSchema, FlywheelToolErrorSchema, FlywheelStructuredErrorSchema, DEFAULT_RETRYABLE, FlywheelError, throwFlywheelError, makeFlywheelErrorResult, } from '../errors.js';
describe('FLYWHEEL_ERROR_CODES', () => {
    it('has exactly 16 codes', () => {
        expect(FLYWHEEL_ERROR_CODES).toHaveLength(16);
    });
    it('DEFAULT_RETRYABLE covers every code', () => {
        expect(Object.keys(DEFAULT_RETRYABLE).sort()).toEqual([...FLYWHEEL_ERROR_CODES].sort());
    });
});
describe('makeFlywheelErrorResult', () => {
    it('returns a valid FlywheelStructuredError envelope', () => {
        const result = makeFlywheelErrorResult('flywheel_plan', 'planning', {
            code: 'cli_failure',
            message: 'br list failed',
            hint: 'Install br first.',
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe('br list failed');
        const parsed = FlywheelStructuredErrorSchema.parse(result.structuredContent);
        expect(parsed.tool).toBe('flywheel_plan');
        expect(parsed.version).toBe(1);
        expect(parsed.status).toBe('error');
        expect(parsed.phase).toBe('planning');
        expect(parsed.data.kind).toBe('error');
        expect(parsed.data.error.code).toBe('cli_failure');
    });
    it('auto-populates ISO-8601 timestamp', () => {
        const result = makeFlywheelErrorResult('flywheel_review', 'reviewing', {
            code: 'not_found',
            message: 'Bead not found',
        });
        const ts = result.structuredContent.data.error.timestamp;
        expect(ts).toBeDefined();
        expect(new Date(ts).toISOString()).toBe(ts);
    });
    it('reads retryable default from DEFAULT_RETRYABLE when not set', () => {
        const retryableResult = makeFlywheelErrorResult('flywheel_plan', 'planning', {
            code: 'cli_failure',
            message: 'failed',
        });
        expect(retryableResult.structuredContent.data.error.retryable).toBe(true);
        const nonRetryableResult = makeFlywheelErrorResult('flywheel_plan', 'planning', {
            code: 'invalid_input',
            message: 'bad input',
        });
        expect(nonRetryableResult.structuredContent.data.error.retryable).toBe(false);
    });
    it('allows overriding retryable', () => {
        const result = makeFlywheelErrorResult('flywheel_plan', 'planning', {
            code: 'cli_failure',
            message: 'deterministic failure',
            retryable: false,
        });
        expect(result.structuredContent.data.error.retryable).toBe(false);
    });
    it('round-trips every error code through FlywheelStructuredErrorSchema', () => {
        for (const code of FLYWHEEL_ERROR_CODES) {
            const result = makeFlywheelErrorResult('flywheel_profile', 'idle', {
                code,
                message: `test ${code}`,
            });
            expect(() => FlywheelStructuredErrorSchema.parse(result.structuredContent)).not.toThrow();
        }
    });
});
describe('FlywheelError', () => {
    it('toJSON() returns the exact schema shape', () => {
        const err = new FlywheelError({
            code: 'exec_timeout',
            message: 'timed out',
            hint: 'Increase timeout.',
            cause: 'SIGTERM',
            details: { elapsedMs: 8000 },
        });
        const json = err.toJSON();
        expect(() => FlywheelToolErrorSchema.parse(json)).not.toThrow();
        expect(json.code).toBe('exec_timeout');
        expect(json.message).toBe('timed out');
        expect(json.retryable).toBe(true);
        expect(json.hint).toBe('Increase timeout.');
        expect(json.cause).toBe('SIGTERM');
        expect(json.details).toEqual({ elapsedMs: 8000 });
    });
    it('defaults retryable from DEFAULT_RETRYABLE', () => {
        const err = new FlywheelError({ code: 'parse_failure', message: 'bad json' });
        expect(err.retryable).toBe(false);
        const err2 = new FlywheelError({ code: 'internal_error', message: 'oops' });
        expect(err2.retryable).toBe(true);
    });
    it('has name FlywheelError', () => {
        const err = new FlywheelError({ code: 'not_found', message: 'x' });
        expect(err.name).toBe('FlywheelError');
        expect(err).toBeInstanceOf(Error);
    });
});
describe('throwFlywheelError', () => {
    it('throws a FlywheelError preserving all fields', () => {
        try {
            throwFlywheelError({
                code: 'blocked_state',
                message: 'wrong phase',
                hint: 'Wait for planning.',
                cause: 'phase=idle',
                details: { currentPhase: 'idle' },
            });
            expect.unreachable('should have thrown');
        }
        catch (err) {
            expect(err).toBeInstanceOf(FlywheelError);
            const fe = err;
            expect(fe.code).toBe('blocked_state');
            expect(fe.message).toBe('wrong phase');
            expect(fe.hint).toBe('Wait for planning.');
            expect(fe.cause).toBe('phase=idle');
            expect(fe.details).toEqual({ currentPhase: 'idle' });
        }
    });
});
describe('FlywheelErrorCodeSchema', () => {
    it('validates known codes', () => {
        for (const code of FLYWHEEL_ERROR_CODES) {
            expect(FlywheelErrorCodeSchema.parse(code)).toBe(code);
        }
    });
    it('rejects unknown codes', () => {
        expect(() => FlywheelErrorCodeSchema.parse('bogus_code')).toThrow();
    });
});
//# sourceMappingURL=error-contract.test.js.map