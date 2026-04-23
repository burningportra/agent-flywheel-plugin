import { describe, it, expect } from 'vitest';
import { FLYWHEEL_ERROR_CODES, FlywheelErrorCodeSchema, FlywheelToolErrorSchema, FlywheelStructuredErrorSchema, DEFAULT_RETRYABLE, FlywheelError, throwFlywheelError, makeFlywheelErrorResult, classifyExecError, } from '../errors.js';
describe('FLYWHEEL_ERROR_CODES', () => {
    it('has exactly 26 codes (16 legacy + 10 v3.4.0 additions)', () => {
        expect(FLYWHEEL_ERROR_CODES).toHaveLength(26);
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
    it('round-trips every error code through FlywheelStructuredErrorSchema with structural equality', () => {
        for (const code of FLYWHEEL_ERROR_CODES) {
            const result = makeFlywheelErrorResult('flywheel_profile', 'idle', {
                code,
                message: `test ${code}`,
            });
            const parsed = FlywheelStructuredErrorSchema.parse(result.structuredContent);
            expect(parsed).toEqual(result.structuredContent);
        }
    });
    it('defaults empty_plan to retryable=false', () => {
        const result = makeFlywheelErrorResult('flywheel_plan', 'planning', {
            code: 'empty_plan',
            message: 'plan is empty',
        });
        expect(result.structuredContent.data.error.retryable).toBe(false);
    });
    it('defaults exec_aborted to retryable=false', () => {
        const result = makeFlywheelErrorResult('flywheel_review', 'reviewing', {
            code: 'exec_aborted',
            message: 'aborted',
        });
        expect(result.structuredContent.data.error.retryable).toBe(false);
    });
    it('defaults deep_plan_all_failed to retryable=true', () => {
        const result = makeFlywheelErrorResult('flywheel_plan', 'planning', {
            code: 'deep_plan_all_failed',
            message: 'all planners failed',
        });
        expect(result.structuredContent.data.error.retryable).toBe(true);
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
describe('classifyExecError', () => {
    it('classifies timeout errors', () => {
        const result = classifyExecError(new Error('Timed out after 8000ms: br show br-5 --json'));
        expect(result).toEqual({ code: 'exec_timeout', retryable: true, cause: 'Timed out after 8000ms: br show br-5 --json' });
    });
    it('classifies abort errors', () => {
        const result = classifyExecError(new Error('Aborted'));
        expect(result).toEqual({ code: 'exec_aborted', retryable: false, cause: 'Aborted' });
        const result2 = classifyExecError(new DOMException('signal is aborted', 'AbortError'));
        expect(result2.code).toBe('exec_aborted');
        expect(result2.retryable).toBe(false);
    });
    it('classifies generic errors as cli_failure', () => {
        const result = classifyExecError(new Error('spawn ENOENT'));
        expect(result).toEqual({ code: 'cli_failure', retryable: true, cause: 'spawn ENOENT' });
    });
    it('handles non-Error values', () => {
        const result = classifyExecError('string error');
        expect(result).toEqual({ code: 'cli_failure', retryable: true, cause: 'string error' });
    });
});
// ─── bead-478: hint propagation through the Zod envelope ──────────
//
// Covers at least three representative codes (missing_prerequisite,
// concurrent_write, exec_timeout) to prove downstream consumers
// (skill-side `data.error.hint` renderer, future codex-rescue handoff
// bead `1qn`) can rely on hint as a load-bearing field.
describe('hint propagation through the Zod envelope', () => {
    it('missing_prerequisite hint survives FlywheelStructuredErrorSchema parse', () => {
        const hint = 'Run /flywheel-setup to install missing deps';
        const result = makeFlywheelErrorResult('flywheel_approve_beads', 'idle', {
            code: 'missing_prerequisite',
            message: 'No goal selected.',
            hint,
        });
        // The raw object must parse against the public schema — consumers will
        // Zod-validate before reading hint.
        expect(() => FlywheelStructuredErrorSchema.parse(result.structuredContent)).not.toThrow();
        expect(result.structuredContent.data.error.hint).toBe(hint);
        expect(result.structuredContent.data.error.code).toBe('missing_prerequisite');
    });
    it('concurrent_write hint survives the envelope', () => {
        const hint = 'Another agent holds the lock; wait or run /flywheel-cleanup';
        const result = makeFlywheelErrorResult('flywheel_approve_beads', 'implementing', {
            code: 'concurrent_write',
            message: 'Another invocation is in-flight.',
            hint,
        });
        expect(() => FlywheelStructuredErrorSchema.parse(result.structuredContent)).not.toThrow();
        expect(result.structuredContent.data.error.hint).toBe(hint);
        expect(result.structuredContent.data.error.retryable).toBe(true);
    });
    it('exec_timeout hint survives the envelope', () => {
        const hint = 'Increase timeout or split the task; see FW_LOG_LEVEL=debug for cause';
        const result = makeFlywheelErrorResult('flywheel_plan', 'planning', {
            code: 'exec_timeout',
            message: 'Timed out after 8000ms.',
            hint,
            cause: 'Timed out after 8000ms: br list --json',
        });
        expect(() => FlywheelStructuredErrorSchema.parse(result.structuredContent)).not.toThrow();
        expect(result.structuredContent.data.error.hint).toBe(hint);
        expect(result.structuredContent.data.error.cause).toBe('Timed out after 8000ms: br list --json');
    });
    it('FlywheelError → toJSON → envelope preserves hint end-to-end', () => {
        const hint = 'Wait for reviewing phase.';
        const err = new FlywheelError({
            code: 'blocked_state',
            message: 'wrong phase',
            hint,
        });
        const result = makeFlywheelErrorResult('flywheel_review', 'implementing', err.toJSON());
        expect(result.structuredContent.data.error.hint).toBe(hint);
    });
    it('hint is optional — omitting it produces a valid envelope without hint', () => {
        const result = makeFlywheelErrorResult('flywheel_memory', 'idle', {
            code: 'cli_not_available',
            message: 'cm CLI is not available.',
        });
        expect(() => FlywheelStructuredErrorSchema.parse(result.structuredContent)).not.toThrow();
        expect(result.structuredContent.data.error.hint).toBeUndefined();
    });
});
//# sourceMappingURL=error-contract.test.js.map