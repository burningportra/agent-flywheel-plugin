import type { McpToolResult } from '../types.js';
import { VERSION } from '../version.js';

export interface PingResult {
  tool: 'flywheel_ping';
  version: 1;
  status: 'ok';
  data: {
    kind: 'pong';
    serverName: string;
    serverVersion: string;
    timestampMs: number;
  };
}

/**
 * flywheel_ping — Health check for the agent-flywheel MCP server.
 *
 * Returns a pong response with the server name, version, and current timestamp.
 * Requires no arguments. Use this to verify the server is alive before running
 * other flywheel tools.
 */
export async function runPing(): Promise<McpToolResult<PingResult>> {
  const timestampMs = Date.now();
  const structuredContent: PingResult = {
    tool: 'flywheel_ping',
    version: 1,
    status: 'ok',
    data: {
      kind: 'pong',
      serverName: 'agent-flywheel',
      serverVersion: VERSION,
      timestampMs,
    },
  };
  return {
    content: [{ type: 'text', text: `pong — agent-flywheel v${VERSION}` }],
    structuredContent,
  };
}
