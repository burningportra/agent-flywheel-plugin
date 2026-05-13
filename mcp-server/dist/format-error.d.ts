import { FlywheelError, type FlywheelToolError } from './errors.js';
/** The subset of a FlywheelError this renderer needs. */
export type RenderableError = {
    readonly code: FlywheelToolError['code'];
    readonly message: string;
    readonly hint?: string | undefined;
    readonly try_this?: string | undefined;
};
export declare function renderError(err: RenderableError | FlywheelError): string;
//# sourceMappingURL=format-error.d.ts.map