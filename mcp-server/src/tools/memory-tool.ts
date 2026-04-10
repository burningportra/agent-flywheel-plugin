import { execSync } from 'node:child_process';
import type { ToolContext, McpToolResult, MemoryArgs } from '../types.js';

/**
 * orch_memory — Search and interact with CASS memory (cm CLI).
 *
 * operation="search" (default) — search CASS memory for relevant entries
 * operation="store"            — store a new memory entry
 */
export async function runMemory(ctx: ToolContext, args: MemoryArgs): Promise<McpToolResult> {
  const { exec, cwd } = ctx;
  const operation = args.operation || 'search';

  // Check if cm is available
  const cmCheck = await exec('cm', ['--version'], { cwd, timeout: 5000 });
  const cmAvailable = cmCheck.code === 0;

  if (!cmAvailable) {
    return {
      content: [{
        type: 'text',
        text: `CASS memory (cm CLI) is not available.\n\nInstall it with: \`npm install -g @cass/cm\` or follow the cm installation guide.\n\nWithout CASS, the orchestrator cannot access prior session learnings.`,
      }],
    };
  }

  // ── store ─────────────────────────────────────────────────────
  if (operation === 'store') {
    if (!args.content || !args.content.trim()) {
      return {
        content: [{ type: 'text', text: 'Error: content is required for store operation.' }],
        isError: true,
      };
    }

    const storeResult = await exec('cm', ['add', args.content.trim()], { cwd, timeout: 10000 });
    if (storeResult.code !== 0) {
      return {
        content: [{ type: 'text', text: `Failed to store memory: ${storeResult.stderr}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: `Memory stored successfully.\n\n${storeResult.stdout.trim()}` }],
    };
  }

  // ── search (default) ─────────────────────────────────────────
  if (!args.query || !args.query.trim()) {
    // No query — list recent entries
    const listResult = await exec('cm', ['ls', '--limit', '10'], { cwd, timeout: 10000 });
    if (listResult.code !== 0) {
      return {
        content: [{ type: 'text', text: `Failed to list memory: ${listResult.stderr}` }],
        isError: true,
      };
    }

    const output = listResult.stdout.trim();
    if (!output) {
      return {
        content: [{ type: 'text', text: 'No memory entries found. Use operation="store" to add entries.' }],
      };
    }

    return {
      content: [{ type: 'text', text: `## Recent CASS memory entries\n\n${output}` }],
    };
  }

  // Search with query
  const searchResult = await exec('cm', ['similar', args.query.trim(), '--json'], { cwd, timeout: 10000 });
  if (searchResult.code !== 0) {
    return {
      content: [{ type: 'text', text: `Search failed: ${searchResult.stderr}` }],
      isError: true,
    };
  }

  const output = searchResult.stdout.trim();
  if (!output) {
    return {
      content: [{ type: 'text', text: `No memory entries match "${args.query}".` }],
    };
  }

  return {
    content: [{ type: 'text', text: `## CASS memory: "${args.query}"\n\n${output}` }],
  };
}
