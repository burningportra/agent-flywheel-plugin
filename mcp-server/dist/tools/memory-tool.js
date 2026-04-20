import { makeFlywheelErrorResult } from '../errors.js';
/**
 * flywheel_memory — Search and interact with CASS memory (cm CLI).
 *
 * operation="search" (default) — search CASS memory for relevant entries
 * operation="store"            — store a new memory entry
 */
export async function runMemory(ctx, args) {
    const { exec, cwd, state } = ctx;
    const operation = args.operation || 'search';
    const phase = state.phase;
    // Check if cm is available
    let cmCheck;
    try {
        cmCheck = await exec('cm', ['--version'], { cwd, timeout: 5000 });
    }
    catch (err) {
        return makeFlywheelErrorResult('flywheel_memory', phase, {
            code: 'cli_not_available',
            message: 'CASS memory (cm CLI) is not available.',
            hint: 'Install cm with `npm install -g @cass/cm` (or your team-approved installer), then retry `flywheel_memory`.',
            cause: err instanceof Error ? err.message : String(err),
            details: { command: 'cm --version' },
        });
    }
    const cmAvailable = cmCheck.code === 0;
    if (!cmAvailable) {
        return makeFlywheelErrorResult('flywheel_memory', phase, {
            code: 'cli_not_available',
            message: 'CASS memory (cm CLI) is not available.',
            hint: 'Install cm with `npm install -g @cass/cm` (or your team-approved installer), then retry `flywheel_memory`.',
            cause: cmCheck.stderr.trim() || `cm --version exited with code ${cmCheck.code}`,
            details: {
                command: 'cm --version',
                exitCode: cmCheck.code,
                ...(cmCheck.stderr.trim() && { stderr: cmCheck.stderr.trim() }),
            },
        });
    }
    // ── store ─────────────────────────────────────────────────────
    if (operation === 'store') {
        if (!args.content || !args.content.trim()) {
            return makeFlywheelErrorResult('flywheel_memory', phase, {
                code: 'invalid_input',
                message: 'content is required for store operation.',
                hint: 'Provide non-empty content, for example: `{ operation: "store", content: "decision: ..." }`.',
            });
        }
        let storeResult;
        try {
            storeResult = await exec('cm', ['add', args.content.trim()], { cwd, timeout: 10000 });
        }
        catch (err) {
            return makeFlywheelErrorResult('flywheel_memory', phase, {
                code: 'cli_failure',
                message: 'Failed to store memory.',
                hint: 'Run `cm add "<content>"` manually to inspect the CLI failure, then retry.',
                cause: err instanceof Error ? err.message : String(err),
                details: { command: 'cm add' },
            });
        }
        if (storeResult.code !== 0) {
            return makeFlywheelErrorResult('flywheel_memory', phase, {
                code: 'cli_failure',
                message: `Failed to store memory: ${storeResult.stderr.trim() || `exit code ${storeResult.code}`}`,
                hint: 'Run `cm add "<content>"` manually to inspect the CLI failure, then retry.',
                details: {
                    command: 'cm add',
                    exitCode: storeResult.code,
                    ...(storeResult.stderr.trim() && { stderr: storeResult.stderr.trim() }),
                },
            });
        }
        return {
            content: [{ type: 'text', text: `Memory stored successfully.\n\n${storeResult.stdout.trim()}` }],
        };
    }
    // ── search (default) ─────────────────────────────────────────
    if (!args.query || !args.query.trim()) {
        // No query — list recent entries
        let listResult;
        try {
            listResult = await exec('cm', ['ls', '--limit', '10'], { cwd, timeout: 10000 });
        }
        catch (err) {
            return makeFlywheelErrorResult('flywheel_memory', phase, {
                code: 'cli_failure',
                message: 'Failed to list memory.',
                hint: 'Run `cm ls --limit 10` manually to verify CASS storage health, then retry.',
                cause: err instanceof Error ? err.message : String(err),
                details: { command: 'cm ls --limit 10' },
            });
        }
        if (listResult.code !== 0) {
            return makeFlywheelErrorResult('flywheel_memory', phase, {
                code: 'cli_failure',
                message: `Failed to list memory: ${listResult.stderr.trim() || `exit code ${listResult.code}`}`,
                hint: 'Run `cm ls --limit 10` manually to verify CASS storage health, then retry.',
                details: {
                    command: 'cm ls --limit 10',
                    exitCode: listResult.code,
                    ...(listResult.stderr.trim() && { stderr: listResult.stderr.trim() }),
                },
            });
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
    let searchResult;
    try {
        searchResult = await exec('cm', ['context', args.query.trim(), '--json'], { cwd, timeout: 10000 });
    }
    catch (err) {
        return makeFlywheelErrorResult('flywheel_memory', phase, {
            code: 'cli_failure',
            message: 'Search failed.',
            hint: 'Run `cm context "<query>" --json` manually to inspect the failure, then retry.',
            cause: err instanceof Error ? err.message : String(err),
            details: {
                command: 'cm context --json',
                query: args.query.trim(),
            },
        });
    }
    if (searchResult.code !== 0) {
        return makeFlywheelErrorResult('flywheel_memory', phase, {
            code: 'cli_failure',
            message: `Search failed: ${searchResult.stderr.trim() || `exit code ${searchResult.code}`}`,
            hint: 'Run `cm context "<query>" --json` manually to inspect the failure, then retry.',
            details: {
                command: 'cm context --json',
                query: args.query.trim(),
                exitCode: searchResult.code,
                ...(searchResult.stderr.trim() && { stderr: searchResult.stderr.trim() }),
            },
        });
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
        const parts = [];
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
    }
    catch {
        // If JSON parse fails, return raw output
    }
    return {
        content: [{ type: 'text', text: `## CASS memory: "${args.query}"\n\n${formatted}` }],
    };
}
//# sourceMappingURL=memory-tool.js.map