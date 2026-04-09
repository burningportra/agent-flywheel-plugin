import type { ExecFn } from "./exec.js";
import type { Bead, BvInsights, BvNextPick } from "./types.js";
import { resilientExec, brExec, brExecJson } from "./cli-exec.js";
import { createLogger } from "./logger.js";

const log = createLogger("beads");

/**
 * Check if a bead ID matches the expected br-NNN pattern.
 * The br CLI generates IDs like "br-1", "br-42", "br-123".
 * Non-conforming IDs may break Agent Mail thread_id conventions.
 */
export function isValidBeadId(id: string): boolean {
  return /^[a-z][a-z0-9]*-\d+$/.test(id);
}

/**
 * Find beads with non-standard IDs in a list.
 */
export function findNonStandardIds(beads: Bead[]): string[] {
  return beads
    .map(b => b.id)
    .filter(id => !isValidBeadId(id));
}

export interface TemplateHygieneIssue {
  beadId: string;
  issueType: "raw-template-marker" | "template-shorthand" | "unresolved-placeholder" | "template-missing-structure";
  excerpt: string;
  reason: string;
}

export interface PlanAuditMatch {
  beadId: string;
  title: string;
  score: number;
}

export interface PlanAuditSection {
  heading: string;
  summary: string;
  matches: PlanAuditMatch[];
}

export interface PlanToBeadAudit {
  sections: PlanAuditSection[];
  uncoveredSections: PlanAuditSection[];
  weakMappings: PlanAuditSection[];
}

function tokenizePlanAudit(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[`*_#>-]/g, " ")
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 4)
    )
  );
}

function scorePlanAuditSection(sectionText: string, bead: Bead): number {
  const sectionTokens = tokenizePlanAudit(sectionText);
  if (sectionTokens.length === 0) return 0;

  const beadText = `${bead.title}\n${bead.description}`.toLowerCase();
  let hits = 0;
  for (const token of sectionTokens) {
    if (beadText.includes(token)) hits++;
  }
  return hits / sectionTokens.length;
}

function summarizePlanAuditSection(body: string): string {
  return body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^#+\s/.test(line))
    ?.slice(0, 160) ?? "";
}

export function auditPlanToBeads(plan: string, beads: Bead[]): PlanToBeadAudit {
  const normalized = plan.trim();
  if (!normalized) return { sections: [], uncoveredSections: [], weakMappings: [] };

  const headingPattern = /^#{1,3}\s+(.+)$/gm;
  const headingMatches = Array.from(normalized.matchAll(headingPattern));
  const rawSections = headingMatches.length > 0
    ? headingMatches.map((match, index) => {
        const heading = match[1].trim();
        const start = match.index! + match[0].length;
        const end = index + 1 < headingMatches.length ? headingMatches[index + 1].index! : normalized.length;
        const body = normalized.slice(start, end).trim();
        return { heading, body };
      })
    : [{ heading: "Plan", body: normalized }];

  const sections = rawSections
    .map(({ heading, body }) => {
      const sectionText = `${heading}\n${body}`;
      const matches = beads
        .map((bead) => ({ beadId: bead.id, title: bead.title, score: scorePlanAuditSection(sectionText, bead) }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      return {
        heading,
        summary: summarizePlanAuditSection(body),
        matches,
      } satisfies PlanAuditSection;
    })
    .filter((section) => section.summary.length > 0 || section.matches.length > 0);

  const uncoveredSections = sections.filter((section) => section.matches.length === 0);
  const weakMappings = sections.filter((section) => section.matches.length > 0 && section.matches[0].score < 0.35);
  return { sections, uncoveredSections, weakMappings };
}

// ─── bv (beads-viewer) Integration ────────────────────────────

let _bvAvailable: boolean | null = null;

/**
 * Detects whether the `bv` CLI is available. Result is cached.
 */
export async function detectBv(exec: ExecFn): Promise<boolean> {
  if (_bvAvailable !== null) return _bvAvailable;
  const result = await resilientExec(exec, "which", ["bv"], { timeout: 5000, maxRetries: 0, logWarnings: false });
  _bvAvailable = result.ok && result.value.stdout.trim().length > 0;
  return _bvAvailable;
}

/** Reset bv detection cache (for testing). */
export function resetBvCache(): void {
  _bvAvailable = null;
}

/**
 * Runs `bv --robot-insights` and returns typed graph health data.
 * Returns null if bv is unavailable or output can't be parsed.
 */
export async function bvInsights(
  exec: ExecFn,
  cwd: string
): Promise<BvInsights | null> {
  if (!(await detectBv(exec))) return null;
  const result = await resilientExec(exec, "bv", ["--robot-insights"], { timeout: 15000, cwd, maxRetries: 1, retryDelayMs: 300 });
  if (!result.ok) return null;
  try {
    return JSON.parse(result.value.stdout) as BvInsights;
  } catch {
    log.warn("bv --robot-insights returned unparseable JSON");
    return null;
  }
}

/**
 * Runs `bv --robot-triage` and returns a prioritised list of beads for
 * multiple parallel agents, each routed to a graph-safe non-contending bead.
 * Distinct from --robot-next (which picks one bead for one agent):
 * --robot-triage accounts for which beads can be worked on in parallel
 * without contending on the same bottleneck node.
 * Returns null if bv is unavailable or output can't be parsed.
 */
export async function bvTriage(
  exec: ExecFn,
  cwd: string
): Promise<BvNextPick[] | null> {
  if (!(await detectBv(exec))) return null;
  const result = await resilientExec(exec, "bv", ["--robot-triage", "--json"], { timeout: 15000, cwd, maxRetries: 1, retryDelayMs: 300 });
  if (!result.ok) return null;
  const stdout = result.value.stdout.trim();
  if (!stdout) return null;
  try {
    const data = JSON.parse(stdout);
    // --robot-triage may return an array or a single object
    if (Array.isArray(data)) return data as BvNextPick[];
    if (data && data.id) return [data as BvNextPick];
    return null;
  } catch {
    log.warn("bv --robot-triage returned unparseable JSON");
    return null;
  }
}

/**
 * Runs `bv --robot-next` and returns the highest-priority next bead.
 * Returns null if bv is unavailable, no actionable items, or parse error.
 */
export async function bvNext(
  exec: ExecFn,
  cwd: string
): Promise<BvNextPick | null> {
  if (!(await detectBv(exec))) return null;
  const result = await resilientExec(exec, "bv", ["--robot-next"], { timeout: 15000, cwd, maxRetries: 1, retryDelayMs: 300 });
  if (!result.ok) return null;
  const stdout = result.value.stdout.trim();
  if (!stdout) return null;
  try {
    const data = JSON.parse(stdout);
    if (!data || !data.id) return null;
    return data as BvNextPick;
  } catch {
    log.warn("bv --robot-next returned unparseable JSON");
    return null;
  }
}

/**
 * Runs `bv --robot-plan` and returns the raw output string.
 * Returns null if bv is unavailable, empty output, or error.
 */
export async function bvPlan(
  exec: ExecFn,
  cwd: string
): Promise<string | null> {
  if (!(await detectBv(exec))) return null;
  const result = await resilientExec(exec, "bv", ["--robot-plan"], { timeout: 15000, cwd, maxRetries: 1, retryDelayMs: 300 });
  if (!result.ok) return null;
  const stdout = result.value.stdout.trim();
  if (!stdout) return null;
  return stdout;
}

// ─── Beads Integration ────────────────────────────────────────

function validateBeadStatus(s: unknown): Bead["status"] | null {
  if (s === "open" || s === "in_progress" || s === "closed" || s === "deferred") return s;
  return null;
}

function parseBead(raw: unknown): Bead | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.title !== "string") return null;
  return {
    id: obj.id,
    title: obj.title,
    description: typeof obj.description === "string" ? obj.description : "",
    status: validateBeadStatus(obj.status) ?? "open",
    priority: typeof obj.priority === "number" ? obj.priority : 0,
    type: typeof obj.type === "string" ? obj.type : "task",
    labels: Array.isArray(obj.labels) ? obj.labels.filter((l): l is string => typeof l === "string") : [],
    estimate: typeof obj.estimate === "number" ? obj.estimate : undefined,
    parent: typeof obj.parent === "string" ? obj.parent : undefined,
    created_at: typeof obj.created_at === "string" ? obj.created_at : undefined,
    updated_at: typeof obj.updated_at === "string" ? obj.updated_at : undefined,
    closed_at: typeof obj.closed_at === "string" ? obj.closed_at : undefined,
  };
}

/**
 * Reads all beads via `br list --json`.
 */
export async function readBeads(
  exec: ExecFn,
  cwd: string
): Promise<Bead[]> {
  const result = await brExecJson<Bead[] | { issues: Bead[] }>(exec, [
    "list",
    "--json",
    "--fields", "id,title,description,status,priority,issue_type,labels,estimate,parent,created_at,updated_at,closed_at",
    "--deferred", // include deferred beads
  ], { timeout: 10000, cwd });
  if (!result.ok) return [];
  const data = result.value;
  const raw: unknown[] = Array.isArray(data) ? data : (data as any)?.issues ?? [];
  return raw.map(parseBead).filter((b): b is Bead => b !== null);
}

/**
 * Reads ready beads (unblocked) via `br ready --json`.
 */
export async function readyBeads(
  exec: ExecFn,
  cwd: string
): Promise<Bead[]> {
  const result = await brExecJson<Bead[] | { issues: Bead[] }>(exec, ["ready", "--json"], { timeout: 10000, cwd });
  if (!result.ok) return [];
  const data = result.value;
  // br ready --json returns a bare array, br list --json returns {issues: [...]}
  const raw: unknown[] = Array.isArray(data) ? data : (data as any)?.issues ?? [];
  return raw.map(parseBead).filter((b): b is Bead => b !== null);
}

/**
 * Gets a single bead by ID via `br show <id> --json`.
 */
export async function getBeadById(
  exec: ExecFn,
  cwd: string,
  id: string
): Promise<Bead | null> {
  const result = await brExecJson<Bead>(exec, ["show", id, "--json"], { timeout: 10000, cwd });
  if (!result.ok) return null;
  return result.value ?? null;
}

/**
 * Lists dependency IDs for a bead via `br dep list <id>`.
 */
export async function beadDeps(
  exec: ExecFn,
  cwd: string,
  id: string
): Promise<string[]> {
  const result = await brExec(exec, ["dep", "list", id], { timeout: 10000, cwd });
  if (!result.ok) return [];
  const lines = result.value.stdout.trim().split("\n").filter(Boolean);
  // Each line typically contains a bead ID; extract first token
  return lines.map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
}

/**
 * Extracts artifact file paths from a bead's description.
 * Looks for a '### Files:' section or bullet lines starting with known prefixes
 * (src/, lib/, test/, tests/, dist/, docs/). Files outside these directories
 * won't be detected unless they appear in a '### Files:' section.
 */
export function extractArtifacts(bead: Bead): string[] {
  const desc = bead.description ?? "";
  const paths: string[] = [];

  // Match lines like "- src/foo.ts" or "- lib/bar.js"
  const linePattern = /^[-*]\s+((?:src|lib|test|tests|dist|docs)\/\S+)/gm;
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(desc)) !== null) {
    paths.push(match[1]);
  }

  // Also check for a ### Files: section with indented paths
  const filesSection = desc.match(/###\s*Files:\s*\n([\s\S]*?)(?:\n###|\n\n|$)/);
  if (filesSection) {
    const sectionLines = filesSection[1].split("\n");
    for (const line of sectionLines) {
      const trimmed = line.replace(/^[-*\s]+/, "").trim();
      if (trimmed && /^[\w./]/.test(trimmed) && trimmed.includes("/")) {
        if (!paths.includes(trimmed)) paths.push(trimmed);
      }
    }
  }

  return paths;
}

/**
 * Updates the status of a bead.
 */
export async function updateBeadStatus(
  exec: ExecFn,
  cwd: string,
  beadId: string,
  status: "in_progress" | "closed" | "deferred"
): Promise<void> {
  await brExec(exec, ["update", beadId, "--status", status], {
    timeout: 10000,
    cwd,
  });
  // Non-fatal: brExec logs warning on failure, caller continues regardless
}

/**
 * Syncs beads to disk.
 */
export async function syncBeads(
  exec: ExecFn,
  cwd: string
): Promise<void> {
  await brExec(exec, ["sync", "--flush-only"], { timeout: 10000, cwd });
  // Non-fatal: brExec logs warning on failure, caller continues regardless
}

/**
 * Closes orphaned beads by setting their status to "closed".
 * Returns the list of IDs that were successfully closed.
 */
export async function remediateOrphans(
  exec: ExecFn,
  cwd: string,
  orphanIds: string[]
): Promise<{ closed: string[]; failed: string[] }> {
  const closed: string[] = [];
  const failed: string[] = [];
  for (const id of orphanIds) {
    const result = await brExec(exec, ["update", id, "--status", "closed"], { timeout: 10000, cwd });
    if (result.ok) {
      closed.push(id);
    } else {
      failed.push(id);
    }
  }
  return { closed, failed };
}

/**
 * Validates beads — checks for dependency cycles, orphaned open beads, and graph health.
 * When bv is available, uses graph-theoretic analysis for richer validation.
 */
export async function validateBeads(
  exec: ExecFn,
  cwd: string
): Promise<{ ok: boolean; orphaned: string[]; cycles: boolean; warnings: string[]; shallowBeads: { id: string; reason: string }[]; templateIssues: TemplateHygieneIssue[] }> {
  let cycles = false;
  let orphaned: string[] = [];
  const warnings: string[] = [];
  const shallowBeads: { id: string; reason: string }[] = [];
  const templateIssues: TemplateHygieneIssue[] = [];

  // Read all beads once — reuse for every check below to avoid 3× shell execs
  const allBeadsForFilter = await readBeads(exec, cwd);

  // Try bv insights first for richer analysis
  const insights = await bvInsights(exec, cwd);
  const openBeadIds = new Set(allBeadsForFilter.filter((b) => b.status === "open" || b.status === "in_progress").map((b) => b.id));

  if (insights) {
    // Use bv data for cycles and orphans — but filter to open beads only
    cycles = insights.Cycles !== null && insights.Cycles.some((cycle) => cycle.some((id) => openBeadIds.has(id)));
    orphaned = (insights.Orphans ?? []).filter((id) => openBeadIds.has(id));

    // Add warnings for bottlenecks (open beads only)
    for (const b of insights.Bottlenecks ?? []) {
      if (b.Value > 5 && openBeadIds.has(b.ID)) {
        warnings.push(`bead ${b.ID} is a bottleneck (betweenness=${b.Value.toFixed(1)}) — consider splitting`);
      }
    }

    // Add warnings for articulation points (open beads only)
    for (const id of insights.Articulation ?? []) {
      if (openBeadIds.has(id)) {
        warnings.push(`bead ${id} is a single point of failure in the dep graph`);
      }
    }
  } else {
    // Fallback: manual cycle/orphan detection
    const cycleResult = await resilientExec(exec, "br", ["dep", "cycles"], {
      timeout: 10000, cwd, maxRetries: 0, isTransient: () => false, logWarnings: false,
    });
    const cycleOutput = (cycleResult.ok
      ? cycleResult.value.stdout
      : cycleResult.error.stdout
    ).toLowerCase();
    if (cycleOutput) {
      const confirmsNoCycles =
        cycleOutput.includes("no dependency cycles detected") ||
        cycleOutput.includes("all dependency checks passed");
      const indicatesCycles =
        /detected\s+cycle|cycle\s+detected|dependency\s+cycles\s+detected/.test(cycleOutput);
      cycles = !confirmsNoCycles && indicatesCycles;
    }

    try {
      const openBeads = allBeadsForFilter.filter((b) => b.status === "open" || b.status === "in_progress");
      if (openBeads.length > 1) {
        const hasDeps = new Set<string>();
        const isDependedOn = new Set<string>();
        for (const bead of openBeads) {
          const deps = await beadDeps(exec, cwd, bead.id);
          if (deps.length > 0) {
            hasDeps.add(bead.id);
            for (const dep of deps) isDependedOn.add(dep);
          }
        }
        for (const bead of openBeads) {
          if (!hasDeps.has(bead.id) && !isDependedOn.has(bead.id)) {
            orphaned.push(bead.id);
          }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  // Warn about non-standard bead IDs (may break Agent Mail thread_id conventions)
  const nonStandardIds = findNonStandardIds(allBeadsForFilter);
  if (nonStandardIds.length > 0) {
    warnings.push(`Non-standard bead IDs (may break Agent Mail thread conventions): ${nonStandardIds.join(", ")}`);
  }

  // Detect shallow beads and template hygiene problems
  try {
    for (const bead of allBeadsForFilter) {
      const desc = bead.description ?? "";
      if (bead.status === "open" || bead.status === "in_progress") {
        if (desc.length === 0) {
          shallowBeads.push({ id: bead.id, reason: "Empty description" });
        } else if (desc.length < 50) {
          shallowBeads.push({ id: bead.id, reason: `Description too short (${desc.length} chars)` });
        } else if (!desc.includes("### Files:") && !/^[-*]\s+(?:src|lib|test|tests|dist|docs)\/\S+/m.test(desc)) {
          shallowBeads.push({ id: bead.id, reason: "Missing ### Files: section" });
        }
      }

      if (bead.status !== "open") continue;

      const lines = desc.split("\n");
      const hasFilesSection = desc.includes("### Files:") || /^[-*]\s+(?:src|lib|test|tests|dist|docs)\/\S+/m.test(desc);
      const acceptanceCriteriaCount = lines.filter((line) => line.trim().startsWith("- [ ]") || line.trim().startsWith("- [x]")).length;
      const templateSignals = new Set<TemplateHygieneIssue["issueType"]>();

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (/^\[?use template:/i.test(line)) {
          templateSignals.add("raw-template-marker");
          templateIssues.push({
            beadId: bead.id,
            issueType: "raw-template-marker",
            excerpt: line,
            reason: `bead ${bead.id} has a raw template marker instead of expanded instructions`,
          });
          continue;
        }

        if (/^see template\b/i.test(line) || /^use the template\b/i.test(line)) {
          templateSignals.add("template-shorthand");
          templateIssues.push({
            beadId: bead.id,
            issueType: "template-shorthand",
            excerpt: line,
            reason: `bead ${bead.id} uses template shorthand without expanded implementation details`,
          });
        }
      }

      for (const match of desc.matchAll(/{{\s*\w+\s*}}|<[A-Z][A-Z0-9_]{2,}>/g)) {
        const excerpt = match[0];
        templateSignals.add("unresolved-placeholder");
        templateIssues.push({
          beadId: bead.id,
          issueType: "unresolved-placeholder",
          excerpt,
          reason: `bead ${bead.id} still contains an unresolved template placeholder`,
        });
      }

      if (templateSignals.size > 0 && (!hasFilesSection || acceptanceCriteriaCount < 2)) {
        templateIssues.push({
          beadId: bead.id,
          issueType: "template-missing-structure",
          excerpt: !hasFilesSection ? "missing ### Files:" : `acceptance criteria count: ${acceptanceCriteriaCount}`,
          reason: `bead ${bead.id} has template artifacts but is missing concrete file scope or enough acceptance criteria`,
        });
      }
    }
  } catch {
    // Non-fatal
  }

  return { ok: !cycles && orphaned.length === 0 && templateIssues.length === 0, orphaned, cycles, warnings, shallowBeads, templateIssues };
}

/**
 * Quality check result for a single bead.
 */
export interface QualityFailure {
  beadId: string;
  check: string;
  reason: string;
}

/**
 * Validates each open bead against automated quality checks.
 */
export async function qualityCheckBeads(
  exec: ExecFn,
  cwd: string
): Promise<{ passed: boolean; failures: QualityFailure[] }> {
  const failures: QualityFailure[] = [];
  const allBeads = await readBeads(exec, cwd);
  const openBeads = allBeads.filter((b) => b.status === "open" || b.status === "in_progress");

  if (openBeads.length === 0) return { passed: true, failures };

  // Check cycles and template hygiene
  const validation = await validateBeads(exec, cwd);
  if (validation.cycles) {
    failures.push({ beadId: "*", check: "no-cycles", reason: "Dependency cycles detected in bead graph" });
  }
  for (const issue of validation.templateIssues) {
    failures.push({
      beadId: issue.beadId,
      check: "template-hygiene",
      reason: `${issue.issueType}: ${issue.excerpt}`,
    });
  }

  // Build dep graph for connectivity check
  const hasDeps = new Set<string>();
  const isDependedOn = new Set<string>();
  for (const bead of openBeads) {
    const deps = await beadDeps(exec, cwd, bead.id);
    if (deps.length > 0) {
      hasDeps.add(bead.id);
      for (const dep of deps) isDependedOn.add(dep);
    }
  }

  for (const bead of openBeads) {
    const desc = bead.description ?? "";

    // 1. Has substance
    if (desc.length < 100) {
      failures.push({ beadId: bead.id, check: "has-substance", reason: `Description too short (${desc.length} chars, need >= 100)` });
    }

    // 2. Has file scope
    if (!desc.includes("### Files:") && !/^[-*]\s+(?:src|lib|test|tests|dist|docs)\/\S+/m.test(desc)) {
      failures.push({ beadId: bead.id, check: "has-file-scope", reason: "No file scope found (missing ### Files: section or file paths)" });
    }

    // 3. Has acceptance criteria
    if (!desc.includes("- [ ]")) {
      failures.push({ beadId: bead.id, check: "has-acceptance-criteria", reason: "No acceptance criteria (missing - [ ] checkboxes)" });
    }

    // 4. Not oversimplified
    const wordCount = desc.split(/\s+/).filter(Boolean).length;
    if (wordCount < 50) {
      failures.push({ beadId: bead.id, check: "not-oversimplified", reason: `Description too brief (${wordCount} words, need >= 50)` });
    }

    // 6. Dependencies connected (skip for single-bead plans)
    if (openBeads.length > 1 && !hasDeps.has(bead.id) && !isDependedOn.has(bead.id)) {
      failures.push({ beadId: bead.id, check: "deps-connected", reason: "Bead is disconnected — no dependencies and not depended on by any bead" });
    }
  }

  // 7. File overlap among ready beads (parallel execution conflict)
  const ready = await readyBeads(exec, cwd);
  if (ready.length >= 2) {
    const artifactMap = new Map<string, string[]>(); // file -> bead IDs
    for (const bead of ready) {
      const files = extractArtifacts(bead);
      for (const file of files) {
        if (!artifactMap.has(file)) artifactMap.set(file, []);
        artifactMap.get(file)!.push(bead.id);
      }
    }
    for (const [file, ids] of artifactMap) {
      if (ids.length > 1) {
        failures.push({
          beadId: ids.join(","),
          check: "file-overlap",
          reason: `Beads ${ids.join(", ")} both modify ${file} — parallel execution may cause conflicts`,
        });
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

/**
 * Returns a human-readable summary of bead states.
 */
export function getBeadsSummary(beads: Bead[]): string {
  if (beads.length === 0) return "no beads tracked";

  let closed = 0;
  let inProgress = 0;
  let open = 0;
  let deferred = 0;

  for (const bead of beads) {
    const status = bead.status ?? "open";
    if (status === "closed") closed++;
    else if (status === "in_progress") inProgress++;
    else if (status === "deferred") deferred++;
    else open++;
  }

  const parts: string[] = [];
  if (closed > 0) parts.push(`${closed} closed`);
  if (inProgress > 0) parts.push(`${inProgress} in-progress`);
  if (open > 0) parts.push(`${open} open`);
  if (deferred > 0) parts.push(`${deferred} deferred`);
  return parts.join(", ") || "unknown";
}
