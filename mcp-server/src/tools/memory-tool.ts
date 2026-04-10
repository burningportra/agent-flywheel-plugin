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

  // Search with query — use `cm context` for task-aware semantic matching.
  // `cm similar` uses keyword mode and returns empty for most queries.
  const searchResult = await exec('cm', ['context', args.query.trim(), '--json'], { cwd, timeout: 10000 });
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

  // Parse cm context JSON to produce a readable summary
  let formatted = output;
  try {
    const parsed = JSON.parse(output);
    const data = parsed?.data ?? parsed;
    const parts: string[] = [];

    if (data.relevantBullets?.length > 0) {
      parts.push('### Relevant Rules');
      for (const b of data.relevantBullets) {
        const score = b.finalScore != null ? ` (score: ${b.finalScore.toFixed(1)})` : '';
        const cat = b.category ? ` [${b.category}]` : '';
        parts.push(`- **${b.id}**${cat}${score}: ${b.content ?? b.text ?? ''}`);
      }
    }
    if (data.antiPatterns?.length > 0) {
      parts.push('\n### Anti-Patterns');
      for (const ap of data.antiPatterns) {
        parts.push(`- **${ap.id}**: ${ap.content ?? ap.text ?? ''}`);
      }
    }
    if (data.historySnippets?.length > 0) {
      parts.push('\n### History');
      for (const h of data.historySnippets) {
        parts.push(`- ${h.snippet ?? h.text ?? ''}`);
      }
    }

    if (parts.length > 0) {
      formatted = parts.join('\n');
    }
  } catch {
    // If JSON parse fails, return raw output
  }

  return {
    content: [{ type: 'text', text: `## CASS memory: "${args.query}"\n\n${formatted}` }],
  };
}
