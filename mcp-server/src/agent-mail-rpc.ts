import type { ExecFn } from './exec.js';
import type { AgentMailResult } from './types.js';
import { parseAgentMailResponse } from './parsers.js';

export const AGENT_MAIL_URL = 'http://127.0.0.1:8765';

function contentText(rpcResult: Record<string, unknown>): string | undefined {
  const content = rpcResult.content;
  if (!Array.isArray(content)) return undefined;
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  return first?.type === 'text' && typeof first.text === 'string' ? first.text : undefined;
}

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

  const rpcResult = parsed.data as Record<string, unknown> | null | undefined;
  const isObject = rpcResult !== null && rpcResult !== undefined && typeof rpcResult === 'object';

  if (isObject && rpcResult.isError === true) {
    const text = contentText(rpcResult);
    return {
      ok: false,
      error: {
        kind: 'rpc_error',
        message: `Tool error from ${toolName}: ${text ?? 'no detail'}`,
      },
    };
  }

  // The Rust server's /api answers with only `content[0].text` (a JSON string)
  // and no `structuredContent`, so parse the text when that's all there is.
  let payload: unknown = rpcResult;
  if (isObject && 'structuredContent' in rpcResult) {
    payload = rpcResult.structuredContent;
  } else if (isObject) {
    const text = contentText(rpcResult);
    if (text !== undefined) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
  }
  const data = payload as T | null | undefined;

  if (data === null || data === undefined) {
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
