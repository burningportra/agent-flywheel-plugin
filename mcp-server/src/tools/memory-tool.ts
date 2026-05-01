import { promises as fsPromises } from 'node:fs';
import { join, relative, resolve as pathResolve } from 'node:path';

import type { ToolContext, McpToolResult, MemoryArgs, PostmortemDraft } from '../types.js';
import { classifyExecError, errMsg, makeFlywheelErrorResult } from '../errors.js';
import { draftPostmortem, draftSolutionDoc, formatPostmortemMarkdown } from '../episodic-memory.js';
import { renderSolutionDoc, type SolutionDoc } from '../solution-doc-schema.js';
import {
  refreshLearnings,
  type RefreshFs,
  type RefreshReport,
} from '../refresh-learnings.js';
import { resolveRealpathWithinRoot } from '../utils/path-safety.js';
import { makeToolResult } from './shared.js';

type PostmortemDraftStructuredContent = {
  tool: 'flywheel_memory';
  version: 1;
  status: 'ok';
  phase: string;
  data: {
    kind: 'postmortem_draft';
    draft: PostmortemDraft;
    markdown: string;
  };
};

type SolutionDocDraftStructuredContent = {
  tool: 'flywheel_memory';
  version: 1;
  status: 'ok';
  phase: string;
  data: {
    kind: 'solution_doc_draft';
    doc: SolutionDoc;
    /** Full rendered markdown (frontmatter + body) ready to write via Write tool. */
    rendered: string;
  };
};

type RefreshLearningsStructuredContent = {
  tool: 'flywheel_memory';
  version: 1;
  status: 'ok';
  phase: string;
  data: {
    kind: 'refresh_learnings_report';
    /** Absolute root that was scanned. */
    root: string;
    report: RefreshReport;
  };
};

/**
 * Real-filesystem adapter for `refreshLearnings`. Lives in this module — not
 * in `refresh-learnings.ts` itself — so the algorithm stays pure and tests
 * can supply an in-memory stub without touching disk.
 *
 * Walks `root/**\/*.md` recursively, skipping hidden directories and the
 * `_archive/` subtree (handled again upstream as a belt-and-braces guard).
 */
async function listMarkdownRecursive(root: string): Promise<string[]> {
  let realRoot: string;
  try {
    realRoot = await fsPromises.realpath(root);
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') {
      throw new Error(`refreshRoot not found: ${root}`);
    }
    throw new Error(
      `refreshRoot realpath failed: ${errMsg(err)}`,
    );
  }
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '_archive') continue;
        await walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(relative(realRoot, abs));
      }
    }
  }
  await walk(realRoot);
  return out;
}

const REAL_REFRESH_FS: RefreshFs = {
  listMarkdown: listMarkdownRecursive,
  readFile: (absPath) => fsPromises.readFile(absPath, 'utf8'),
};

/**
 * flywheel_memory — Search and interact with CASS memory (cm CLI).
 *
 * operation="search" (default)   — search CASS memory for relevant entries
 * operation="store"              — store a new memory entry
 * operation="draft_postmortem"   — synthesize a read-only session post-mortem
 *                                  draft from checkpoint + git + agent-mail.
 *                                  NEVER writes to CASS — user must manually
 *                                  invoke operation="store" to persist.
 */
export async function runMemory(ctx: ToolContext, args: MemoryArgs): Promise<McpToolResult> {
  const { exec, cwd, state, signal } = ctx;
  const operation = args.operation || 'search';
  const phase = state.phase;

  // ── draft_postmortem ──────────────────────────────────────────
  // Runs BEFORE the cm availability probe — the draft engine does not need
  // cm CLI (it reads git + agent-mail + telemetry). Persistence of the draft
  // goes back through operation="store", which will re-check cm availability.
  if (operation === 'draft_postmortem') {
    try {
      const draft = await draftPostmortem({
        cwd,
        goal: state.selectedGoal ?? '(no goal set)',
        phase,
        sessionStartSha: state.sessionStartSha,
        errorCodeTelemetry: state.errorCodeTelemetry,
        exec,
        signal,
      });

      const markdown = formatPostmortemMarkdown(draft);
      const structured: PostmortemDraftStructuredContent = {
        tool: 'flywheel_memory',
        version: 1,
        status: 'ok',
        phase,
        data: {
          kind: 'postmortem_draft',
          draft,
          markdown,
        },
      };
      return makeToolResult(markdown, structured);
    } catch (err: unknown) {
      // draftPostmortem is designed NOT to throw (degrades via warnings[]);
      // defensive classification at the tool boundary.
      const classified = classifyExecError(err);
      return makeFlywheelErrorResult('flywheel_memory', phase, {
        code: classified.code,
        message: errMsg(err),
        retryable: classified.retryable,
        hint:
          classified.code === 'exec_timeout'
            ? 'Postmortem drafting exceeded its timeout — retry, or inspect git/agent-mail latency with flywheel_doctor.'
            : 'Postmortem draft failed unexpectedly — rerun once; if persistent, set FW_LOG_LEVEL=debug to capture the underlying cause.',
        cause: classified.cause,
      });
    }
  }

  // ── draft_solution_doc ────────────────────────────────────────
  // Also runs BEFORE the cm availability probe — no cm CLI is touched.
  // Produces a SolutionDoc + rendered markdown that the wrap-up skill
  // Step 10.55 writes to `docs/solutions/<category>/<slug>-YYYY-MM-DD.md`.
  if (operation === 'draft_solution_doc') {
    if (!args.entryId || !args.entryId.trim()) {
      return makeFlywheelErrorResult('flywheel_memory', phase, {
        code: 'invalid_input',
        message: 'entryId is required for draft_solution_doc operation.',
        hint:
          'First run operation="store" to persist the post-mortem to CASS, capture the returned entry id, then call draft_solution_doc with { entryId }.',
      });
    }
    try {
      const doc = await draftSolutionDoc({
        cwd,
        goal: state.selectedGoal ?? '(no goal set)',
        phase,
        sessionStartSha: state.sessionStartSha,
        errorCodeTelemetry: state.errorCodeTelemetry,
        exec,
        signal,
        entryId: args.entryId.trim(),
      });
      const rendered = renderSolutionDoc(doc);
      const structured: SolutionDocDraftStructuredContent = {
        tool: 'flywheel_memory',
        version: 1,
        status: 'ok',
        phase,
        data: {
          kind: 'solution_doc_draft',
          doc,
          rendered,
        },
      };
      // Surface the target path up-front so the wrap-up skill can mkdir/Write.
      const textPreview = `Solution doc drafted.\nPath: ${doc.path}\n\n${rendered}`;
      return makeToolResult(textPreview, structured);
    } catch (err: unknown) {
      const classified = classifyExecError(err);
      return makeFlywheelErrorResult('flywheel_memory', phase, {
        code: classified.code,
        message: errMsg(err),
        retryable: classified.retryable,
        hint:
          'Solution-doc drafting failed. Rerun once; if persistent, set FW_LOG_LEVEL=debug and check that draft_postmortem succeeds on its own.',
        cause: classified.cause,
      });
    }
  }

  // ── refresh_learnings ─────────────────────────────────────────
  // Bead `bve` — pure read-only sweep of docs/solutions/. Does NOT need
  // the cm CLI (it operates entirely on markdown frontmatter). Surface
  // the RefreshReport verbatim; the caller (skill) decides what to
  // archive based on per-decision recommendations.
  if (operation === 'refresh_learnings') {
    const rawRoot = args.refreshRoot
      ? pathResolve(cwd, args.refreshRoot)
      : pathResolve(cwd, 'docs', 'solutions');
    const resolvedRoot = resolveRealpathWithinRoot(rawRoot, {
      root: cwd,
      label: 'refreshRoot',
      rootLabel: 'cwd',
    });
    if (!resolvedRoot.ok) {
      const code =
        resolvedRoot.reason === 'not_found' || resolvedRoot.reason === 'root_not_found'
          ? 'not_found'
          : 'invalid_input';
      return makeFlywheelErrorResult('flywheel_memory', phase, {
        code,
        message:
          code === 'not_found'
            ? resolvedRoot.message
            : `refreshRoot rejected by realpath guard (${resolvedRoot.reason}): ${resolvedRoot.message}`,
        hint:
          code === 'not_found'
            ? 'Check that <cwd>/docs/solutions exists and is readable; pass refreshRoot to override the default location.'
            : 'Pass an existing refreshRoot inside cwd. Symlinks that resolve outside the project root are rejected.',
        details: {
          refreshRoot: args.refreshRoot ?? 'docs/solutions',
          absolutePath: resolvedRoot.absolutePath,
          reason: resolvedRoot.reason,
        },
      });
    }
    const root = resolvedRoot.realPath;
    try {
      const report = await refreshLearnings(root, REAL_REFRESH_FS);
      const summary = summarizeRefreshReport(root, report);
      const structured: RefreshLearningsStructuredContent = {
        tool: 'flywheel_memory',
        version: 1,
        status: 'ok',
        phase,
        data: {
          kind: 'refresh_learnings_report',
          root,
          report,
        },
      };
      return makeToolResult(summary, structured);
    } catch (err: unknown) {
      const classified = classifyExecError(err);
      return makeFlywheelErrorResult('flywheel_memory', phase, {
        code: classified.code,
        message: errMsg(err),
        retryable: classified.retryable,
        hint:
          'refresh_learnings sweep failed. Check that <cwd>/docs/solutions exists and is readable; pass refreshRoot to override the default location.',
        cause: classified.cause,
      });
    }
  }

  // Check if cm is available
  let cmCheck;
  try {
    cmCheck = await exec('cm', ['--version'], { cwd, timeout: 5000, signal });
  } catch (err: unknown) {
    return makeFlywheelErrorResult('flywheel_memory', phase, {
      code: 'cli_not_available',
      message: 'CASS memory (cm CLI) is not available.',
      hint: 'Install cm with `npm install -g @cass/cm` (or your team-approved installer), then retry `flywheel_memory`.',
      cause: errMsg(err),
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
      storeResult = await exec('cm', ['add', args.content.trim()], { cwd, timeout: 10000, signal });
    } catch (err: unknown) {
      return makeFlywheelErrorResult('flywheel_memory', phase, {
        code: 'cli_failure',
        message: 'Failed to store memory.',
        hint: 'Run `cm add "<content>"` manually to inspect the CLI failure, then retry.',
        cause: errMsg(err),
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
      listResult = await exec('cm', ['ls', '--limit', '10'], { cwd, timeout: 10000, signal });
    } catch (err: unknown) {
      return makeFlywheelErrorResult('flywheel_memory', phase, {
        code: 'cli_failure',
        message: 'Failed to list memory.',
        hint: 'Run `cm ls --limit 10` manually to verify CASS storage health, then retry.',
        cause: errMsg(err),
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
    searchResult = await exec('cm', ['context', args.query.trim(), '--json'], { cwd, timeout: 10000, signal });
  } catch (err: unknown) {
    return makeFlywheelErrorResult('flywheel_memory', phase, {
      code: 'cli_failure',
      message: 'Search failed.',
      hint: 'Run `cm context "<query>" --json` manually to inspect the failure, then retry.',
      cause: errMsg(err),
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

function summarizeRefreshReport(root: string, report: RefreshReport): string {
  const counts: Record<string, number> = {};
  for (const d of report.decisions) {
    counts[d.classification] = (counts[d.classification] ?? 0) + 1;
  }
  const order = ['Keep', 'Update', 'Consolidate', 'Replace', 'Delete'];
  const summaryLine = order
    .map((c) => `${c}: ${counts[c] ?? 0}`)
    .join('  ');

  const lines: string[] = [];
  lines.push(`flywheel_memory.refresh_learnings — swept ${root}`);
  lines.push(`  Decisions: ${report.decisions.length} (${summaryLine})`);
  lines.push(`  Unparseable: ${report.unparseable.length}`);
  lines.push(`  Elapsed: ${report.elapsedMs}ms`);

  if (report.decisions.length > 0) {
    lines.push('');
    lines.push('  Per-group:');
    for (const d of report.decisions) {
      lines.push(`    [${d.classification}] ${d.docs.map((doc) => doc.path).join(' + ')}`);
      lines.push(`      reason: ${d.reason}`);
    }
  }

  if (report.unparseable.length > 0) {
    lines.push('');
    lines.push('  Unparseable entries (surface to user; never auto-acted on):');
    for (const u of report.unparseable) {
      lines.push(`    - ${u.path}: ${u.reason}`);
    }
  }

  return lines.join('\n');
}
