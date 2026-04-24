import { fetchInbox } from "./agent-mail.js";
import { makeExec } from "./exec.js";
import { createLogger } from "./logger.js";
export interface TenderDaemonArgs {
    session: string;
    project: string;
    interval: number;
    logfile: string;
    agent: string;
    ntmTimeoutMs: number;
}
export interface ParseArgsSuccess {
    ok: true;
    args: TenderDaemonArgs;
}
export interface ParseArgsFailure {
    ok: false;
    error: string;
}
export type ParseArgsResult = ParseArgsSuccess | ParseArgsFailure;
export interface RunCommandResult {
    stdout: string;
    stderr: string;
}
export type RunCommandFn = (command: string, opts: {
    cwd: string;
    timeout: number;
    signal?: AbortSignal;
}) => Promise<RunCommandResult>;
export interface TenderDaemonDeps {
    fetchInboxFn?: typeof fetchInbox;
    makeExecFn?: typeof makeExec;
    runCommandFn?: RunCommandFn;
    createLoggerFn?: typeof createLogger;
}
export interface TenderDaemonController {
    stop: (reason?: string) => Promise<void>;
    logfile: string;
}
export declare function usageText(): string;
export declare function parseTenderDaemonArgs(argv: string[]): ParseArgsResult;
export declare function parsePaneStates(raw: string): Record<string, string>;
export declare function startTenderDaemon(args: TenderDaemonArgs, deps?: TenderDaemonDeps): Promise<TenderDaemonController>;
export declare function runCli(argv: string[], deps?: TenderDaemonDeps): Promise<number>;
//# sourceMappingURL=tender-daemon.d.ts.map