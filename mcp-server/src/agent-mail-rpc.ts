import type { ExecFn } from './exec.js';
import type { AgentMailResult } from './types.js';
import { parseAgentMailResponse } from './parsers.js';

export const AGENT_MAIL_URL = 'http://127.0.0.1:8765';

/**
 * Call an agent-mail MCP tool through its JSON-RPC HTTP endpoint.
 *
 * The transport returns a discriminated result. Policy layers such as
 * reservation conflict handling live above this module.
 */
export async function agentMailRPC<T = any>(
  exec: ExecFn,
  toolName: string,
  args: Record<string, unknown>,
): Promise<AgentMailResult<T>> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  });

  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await exec('curl', [
      '-s', '-X', 'POST', `${AGENT_MAIL_URL}/api`,
      '-H', 'Content-Type: application/json',
      '-d', body,
      '--max-time', '5',
    ], { timeout: 8000 });
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        kind: 'timeout',
        message: error instanceof Error ? error.message : 'exec timed out',
      },
    };
  }

  if (result.code !== 0) {
    return {
      ok: false,
      error: {
        kind: 'network',
        message: `curl exited with code ${result.code}`,
        code: result.code,
        stderr: result.stderr || undefined,
      },
    };
  }

  const parsed = parseAgentMailResponse<any>(result.stdout);
  if (!parsed.ok) {
    const isRpcError = parsed.error.startsWith('RPC error:');
    return {
      ok: false,
      error: {
        kind: isRpcError ? 'rpc_error' : 'parse',
        message: parsed.error,
        stderr: isRpcError ? undefined : result.stdout.slice(0, 200) || undefined,
      },
    };
  }

  const rpcResult = parsed.data as Record<string, unknown> | null;
  const data = (
    rpcResult != null && typeof rpcResult === 'object' && 'structuredContent' in rpcResult
      ? rpcResult.structuredContent
      : rpcResult
  ) as T | null;

  if (data == null) {
    return {
      ok: false,
      error: {
        kind: 'empty_response',
        message: `No data in response for ${toolName}`,
      },
    };
  }

  return { ok: true, data };
}
