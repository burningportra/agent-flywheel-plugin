import { z } from 'zod';
export const FLYWHEEL_ERROR_CODES = [
    'missing_prerequisite',
    'invalid_input',
    'not_found',
    'cli_failure',
    'cli_not_available',
    'parse_failure',
    'exec_timeout',
    'exec_aborted',
    'blocked_state',
    'concurrent_write',
    'agent_mail_unreachable',
    'deep_plan_all_failed',
    'empty_plan',
    'already_closed',
    'unsupported_action',
    'internal_error',
];
export const FlywheelErrorCodeSchema = z.enum(FLYWHEEL_ERROR_CODES);
export const FlywheelToolErrorSchema = z.object({
    code: FlywheelErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean().optional(),
    hint: z.string().optional(),
    cause: z.string().optional(),
    phase: z.string().optional(),
    tool: z.string().optional(),
    timestamp: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
});
export const FlywheelStructuredErrorSchema = z.object({
    tool: z.string(),
    version: z.literal(1),
    status: z.literal('error'),
    phase: z.string(),
    data: z.object({
        kind: z.literal('error'),
        error: FlywheelToolErrorSchema,
    }),
});
export const DEFAULT_RETRYABLE = {
    missing_prerequisite: false,
    invalid_input: false,
    not_found: false,
    cli_failure: true,
    cli_not_available: false,
    parse_failure: false,
    exec_timeout: true,
    exec_aborted: false,
    blocked_state: true,
    concurrent_write: true,
    agent_mail_unreachable: true,
    deep_plan_all_failed: true,
    empty_plan: false,
    already_closed: false,
    unsupported_action: false,
    internal_error: true,
};
export class FlywheelError extends Error {
    code;
    retryable;
    hint;
    cause;
    details;
    constructor(input) {
        super(input.message);
        this.name = 'FlywheelError';
        this.code = input.code;
        this.retryable = input.retryable ?? DEFAULT_RETRYABLE[input.code];
        this.hint = input.hint;
        this.cause = input.cause;
        this.details = input.details;
    }
    toJSON() {
        return {
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            ...(this.hint != null && { hint: this.hint }),
            ...(this.cause != null && { cause: this.cause }),
            ...(this.details != null && { details: this.details }),
        };
    }
}
export function throwFlywheelError(input) {
    throw new FlywheelError(input);
}
export function makeFlywheelErrorResult(tool, phase, input) {
    const error = {
        ...input,
        retryable: input.retryable ?? DEFAULT_RETRYABLE[input.code],
        phase,
        tool,
        timestamp: new Date().toISOString(),
    };
    return {
        content: [{ type: 'text', text: input.message }],
        isError: true,
        structuredContent: {
            tool,
            version: 1,
            status: 'error',
            phase,
            data: { kind: 'error', error },
        },
    };
}
//# sourceMappingURL=errors.js.map