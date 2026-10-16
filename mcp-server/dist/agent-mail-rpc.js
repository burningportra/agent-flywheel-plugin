import { parseAgentMailResponse } from './parsers.js';
export const AGENT_MAIL_URL = 'http://127.0.0.1:8765';
export async function agentMailRPC(exec, toolName, args) {
    const body = JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: toolName, arguments: args },
    });
    let result;
    try {
        result = await exec('curl', [
            '-s', '-X', 'POST', `${AGENT_MAIL_URL}/api`,
            '-H', 'Content-Type: application/json',
            '-d', body,
            '--max-time', '5',
        ], { timeout: 8000 });
    }
    catch (error) {
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
    const parsed = parseAgentMailResponse(result.stdout);
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
    const rpcResult = parsed.data;
    const data = (rpcResult !== null && rpcResult !== undefined && typeof rpcResult === 'object' && 'structuredContent' in rpcResult
        ? rpcResult.structuredContent
        : rpcResult);
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
//# sourceMappingURL=agent-mail-rpc.js.map