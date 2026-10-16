import type { ExecFn } from './exec.js';
import type { AgentMailResult } from './types.js';
export declare const AGENT_MAIL_URL = "http://127.0.0.1:8765";
export declare function agentMailRPC<T = any>(exec: ExecFn, toolName: string, args: Record<string, unknown>): Promise<AgentMailResult<T>>;
//# sourceMappingURL=agent-mail-rpc.d.ts.map