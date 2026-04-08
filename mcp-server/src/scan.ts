import type { ExecFn } from "./exec.js";
import { profileRepo } from "./profiler.js";
import type {
  RepoProfile,
  ScanCodebaseAnalysis,
  ScanErrorInfo,
  ScanInsight,
  ScanProvider,
  ScanRecommendation,
  ScanResult,
  ScanSource,
} from "./types.js";

const CCC_SCAN_QUERIES = [
  {
    id: "workflow-entrypoints",
    title: "Workflow and entrypoints",
    query: "orchestrator workflow command entrypoint state machine",
  },
  {
    id: "planning-review",
    title: "Planning and review flow",
    query: "planning review implementation gates prompts",
  },
  {
    id: "reliability-fallbacks",
    title: "Reliability and fallbacks",
    query: "fallback error handling recovery validation tests",
  },
] as const;

/**
 * Built-in provider backed by the existing repository profiler.
 */
const builtinScanProvider: ScanProvider = {
  id: "builtin",
  label: "Built-in profiler",
  async scan(exec, cwd, signal) {
    const profile = await profileRepo(exec, cwd, signal);
    return createBuiltinScanResult(profile);
  },
};

/**
 * ccc-backed provider. It uses ccc for live codebase scanning and retains the
 * legacy RepoProfile by pairing that analysis with the existing built-in
 * profiler output. If any ccc step fails, callers should fall back to the
 * built-in provider to preserve workflow behavior.
 */
const cccScanProvider: ScanProvider = {
  id: "ccc-cli",
  label: "ccc",
  async scan(exec, cwd, signal) {
    await ensureCccReady(exec, cwd, signal);

    const [profile, codebaseAnalysis] = await Promise.all([
      profileRepo(exec, cwd, signal),
      collectCccCodebaseAnalysis(exec, cwd, signal),
    ]);

    return {
      source: "ccc",
      provider: cccScanProvider.id,
      profile,
      codebaseAnalysis,
      sourceMetadata: {
        label: cccScanProvider.label,
      },
    };
  },
};

/**
 * Scan the repository through the shared scan contract.
 *
 * Downstream code should keep reading `result.profile` for the legacy
 * `RepoProfile` fields. When available, `codebaseAnalysis` carries richer
 * ccc-derived context that later workflow stages can prioritize.
 */
export async function scanRepo(
  exec: ExecFn,
  cwd: string,
  signal?: AbortSignal
): Promise<ScanResult> {
  try {
    return await cccScanProvider.scan(exec, cwd, signal);
  } catch (error) {
    const profile = await profileRepo(exec, cwd, signal);
    return createFallbackScanResult(profile, "ccc", toScanErrorInfo(error));
  }
}

export function createBuiltinScanResult(profile: RepoProfile): ScanResult {
  return {
    source: "builtin",
    provider: builtinScanProvider.id,
    profile,
    codebaseAnalysis: createEmptyCodebaseAnalysis(),
    sourceMetadata: {
      label: builtinScanProvider.label,
    },
  };
}

export function createFallbackScanResult(
  profile: RepoProfile,
  source: Exclude<ScanSource, "builtin">,
  error?: ScanErrorInfo
): ScanResult {
  return {
    source: "builtin",
    provider: builtinScanProvider.id,
    profile,
    codebaseAnalysis: createEmptyCodebaseAnalysis(),
    sourceMetadata: {
      label: builtinScanProvider.label,
      warnings: [`Fell back from ${source} to builtin scan provider.`],
    },
    fallback: {
      used: true,
      from: source,
      to: "builtin",
      reason: error?.message ?? `fallback from ${source} to builtin`,
      error,
    },
  };
}

export function createEmptyCodebaseAnalysis(): ScanCodebaseAnalysis {
  return {
    summary: undefined,
    recommendations: [],
    structuralInsights: [],
    qualitySignals: [],
  };
}

async function ensureCccReady(
  exec: ExecFn,
  cwd: string,
  signal?: AbortSignal
): Promise<void> {
  const versionCheck = await exec("ccc", ["--help"], {
    cwd,
    timeout: 5000,
  });
  if (versionCheck.code !== 0) {
    throw new Error(versionCheck.stderr.trim() || "ccc is not available");
  }

  const status = await exec("ccc", ["status"], {
    cwd,
    timeout: 10000,
  });

  const statusOutput = `${status.stdout}\n${status.stderr}`;
  if (status.code !== 0 && /Not in an initialized project directory/i.test(statusOutput)) {
    const init = await exec("ccc", ["init", "-f"], {
      cwd,
      timeout: 10000,
    });
    if (init.code !== 0) {
      throw new Error(init.stderr.trim() || init.stdout.trim() || "ccc init failed");
    }
  } else if (status.code !== 0) {
    throw new Error(status.stderr.trim() || status.stdout.trim() || "ccc status failed");
  }

  const index = await exec("ccc", ["index"], {
    cwd,
    timeout: 120000,
  });
  if (index.code !== 0) {
    throw new Error(index.stderr.trim() || index.stdout.trim() || "ccc index failed");
  }
}

async function collectCccCodebaseAnalysis(
  exec: ExecFn,
  cwd: string,
  signal?: AbortSignal
): Promise<ScanCodebaseAnalysis> {
  const searches = await Promise.all(
    CCC_SCAN_QUERIES.map(async (entry) => {
      const result = await exec(
        "ccc",
        ["search", "--limit", "3", ...entry.query.split(" ")],
        { cwd, timeout: 30000 }
      );
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || `ccc search failed for ${entry.id}`);
      }
      return {
        ...entry,
        results: parseCccSearchResults(result.stdout),
      };
    })
  );

  const recommendations: ScanRecommendation[] = searches.map((search) => ({
    id: search.id,
    title: search.title,
    detail:
      search.results.length > 0
        ? search.results.map((item) => `${item.location} — ${item.snippet}`).join(" | ")
        : `No ccc matches found for query: ${search.query}`,
    priority: "medium",
    payload: {
      query: search.query,
      results: search.results,
    },
  }));

  const structuralInsights: ScanInsight[] = searches.flatMap((search) =>
    search.results.slice(0, 2).map((item) => ({
      title: `${search.title}: ${item.location}`,
      detail: item.snippet,
    }))
  );

  return {
    summary: `ccc scanned ${searches.length} codebase slices and returned ${searches.reduce((sum, search) => sum + search.results.length, 0)} relevant matches.`,
    recommendations,
    structuralInsights,
    qualitySignals: [
      {
        label: "scan_provider",
        value: "ccc",
        detail: "ccc CLI search/index pipeline",
      },
      {
        label: "query_count",
        value: String(searches.length),
      },
    ],
  };
}

function parseCccSearchResults(output: string): Array<{ location: string; snippet: string }> {
  const blocks = output
    .split(/--- Result \d+ \(score: .*?\) ---/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block) => {
    const lines = block.split("\n");
    const fileLine = lines.find((line) => line.startsWith("File: ")) ?? "File: unknown";
    const location = fileLine.replace(/^File:\s*/, "").trim();
    const snippet = lines
      .slice(lines.indexOf(fileLine) + 1)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 280);
    return { location, snippet };
  });
}

function toScanErrorInfo(error: unknown): ScanErrorInfo {
  if (error instanceof Error) {
    return {
      message: error.message,
      recoverable: true,
    };
  }

  return {
    message: String(error),
    recoverable: true,
  };
}
