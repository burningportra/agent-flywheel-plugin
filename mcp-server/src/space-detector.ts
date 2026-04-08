/**
 * Wrong-Space Detector
 *
 * Detects when an agent is doing plan-space work in code-space.
 * Three heuristics (all fast, no LLM):
 * 1. Architecture invention — files modified outside bead's ### Files
 * 2. Scope creep — files changed >> bead's file list
 * 3. Uncertainty language — hedging in implementation summary
 */

import type { Bead } from "./types.js";

// ─── Types ──────────────────────────────────────────────────

export type SpaceViolationType =
  | "architecture_invention"
  | "scope_creep"
  | "uncertainty";

export type SpaceViolationSeverity = "info" | "warning" | "critical";

export interface SpaceViolation {
  type: SpaceViolationType;
  severity: SpaceViolationSeverity;
  evidence: string;
  suggestion: string;
}

// ─── File Extraction ────────────────────────────────────────

/**
 * Extract expected files from a bead's description.
 * Looks for ### Files: section and inline file references.
 * Returns normalized paths (no leading ./ or /).
 */
export function extractBeadFiles(bead: Bead): string[] {
  const desc = bead.description ?? "";
  const paths: string[] = [];

  // Match ### Files: section
  const filesSection = desc.match(/###\s*Files:\s*([^\n#]+(?:\n(?!###)[^\n#]*)*)/);
  if (filesSection) {
    const content = filesSection[1];
    // Split by commas, newlines, or list markers
    const candidates = content.split(/[,\n]/).map((s) =>
      s.replace(/^[-*\s]+/, "").trim()
    );
    for (const c of candidates) {
      const cleaned = c.replace(/^\.\//, "").trim();
      if (cleaned && /\.\w+$/.test(cleaned) && !cleaned.includes(" ")) {
        paths.push(cleaned);
      }
    }
  }

  // Also match inline file references like `src/foo.ts`
  const inlinePattern = /`((?:src|lib|test|tests|docs|scripts|bin)\/[\w./-]+\.\w+)`/g;
  let match: RegExpExecArray | null;
  while ((match = inlinePattern.exec(desc)) !== null) {
    const p = match[1];
    if (!paths.includes(p)) paths.push(p);
  }

  return paths;
}

// ─── Uncertainty Detection ──────────────────────────────────

const UNCERTAINTY_PATTERNS = [
  /\bi think\b/i,
  /\bmight need\b/i,
  /\bnot sure if\b/i,
  /\bnot sure whether\b/i,
  /\bprobably\b/i,
  /\bmaybe we should\b/i,
  /\bunclear whether\b/i,
  /\bI'm not confident\b/i,
  /\bthis is a guess\b/i,
  /\bneeds further investigation\b/i,
  /\bTODO.*figure out\b/i,
  /\bnot entirely sure\b/i,
  /\bthis might break\b/i,
  /\bhacky\b/i,
  /\bworkaround\b/i,
] as const;

/**
 * Count uncertainty signals in text.
 * Returns the number of distinct pattern matches.
 */
export function countUncertaintySignals(text: string): number {
  return UNCERTAINTY_PATTERNS.filter((p) => p.test(text)).length;
}

// ─── Core Detection ─────────────────────────────────────────

/**
 * Detect space violations after a bead implementation.
 * All heuristic — no LLM calls, runs in <1ms.
 *
 * @param bead The bead that was just implemented
 * @param summary The agent's implementation summary
 * @param feedback The agent's review feedback
 * @param filesChanged Files changed according to git diff (paths relative to repo root)
 */
export function detectSpaceViolations(
  bead: Bead,
  summary: string,
  feedback: string,
  filesChanged: string[]
): SpaceViolation[] {
  const violations: SpaceViolation[] = [];
  const beadFiles = extractBeadFiles(bead);
  const text = `${summary} ${feedback}`;

  // Skip detection if the bead has no file list (can't compare)
  if (beadFiles.length === 0) return violations;

  // ── 1. Architecture invention ──────────────────────────
  // Files created/modified that aren't in the bead's expected file list.
  // Normalize both sides for comparison (strip leading src/ etc. for fuzzy match).
  const unexpectedFiles = filesChanged.filter((changed) => {
    // Exact match
    if (beadFiles.some((bf) => changed === bf || changed.endsWith(`/${bf}`))) return false;
    // Fuzzy: check if the changed file's basename matches any bead file's basename
    const changedBase = changed.split("/").pop() ?? "";
    if (beadFiles.some((bf) => bf.split("/").pop() === changedBase)) return false;
    return true;
  });

  if (unexpectedFiles.length > beadFiles.length && unexpectedFiles.length >= 3) {
    violations.push({
      type: "architecture_invention",
      severity: unexpectedFiles.length > beadFiles.length * 2 ? "critical" : "warning",
      evidence: `${unexpectedFiles.length} files modified outside bead scope: ${unexpectedFiles.slice(0, 5).join(", ")}${unexpectedFiles.length > 5 ? ` (+${unexpectedFiles.length - 5} more)` : ""}`,
      suggestion: "This looks like plan-space work happening in code-space. Consider creating new beads for the unexpected scope.",
    });
  }

  // ── 2. Scope creep ────────────────────────────────────
  // Total files changed significantly exceeds bead's file list.
  if (filesChanged.length > beadFiles.length * 3 && filesChanged.length >= 5) {
    violations.push({
      type: "scope_creep",
      severity: filesChanged.length > beadFiles.length * 5 ? "critical" : "warning",
      evidence: `Bead lists ${beadFiles.length} files but ${filesChanged.length} were changed (${(filesChanged.length / beadFiles.length).toFixed(1)}x expansion)`,
      suggestion: "The bead may be under-specified. Consider splitting into multiple beads with explicit file ownership.",
    });
  }

  // ── 3. Uncertainty language ────────────────────────────
  // Hedging in the implementation summary suggests the bead was too vague.
  const uncertaintyCount = countUncertaintySignals(text);
  if (uncertaintyCount >= 3) {
    violations.push({
      type: "uncertainty",
      severity: uncertaintyCount >= 5 ? "critical" : "warning",
      evidence: `Implementation summary contains ${uncertaintyCount} uncertainty signals (e.g., "not sure", "might need", "probably")`,
      suggestion: "The bead description may be too vague. Enrich it with more context, rationale, and acceptance criteria before continuing.",
    });
  }

  return violations;
}

// ─── Formatting ─────────────────────────────────────────────

/**
 * Format space violations for display in the review UI.
 */
export function formatSpaceViolations(violations: SpaceViolation[]): string {
  if (violations.length === 0) return "";

  const severityEmoji: Record<SpaceViolationSeverity, string> = {
    info: "ℹ️",
    warning: "⚠️",
    critical: "🔴",
  };

  const typeLabels: Record<SpaceViolationType, string> = {
    architecture_invention: "Architecture Invention",
    scope_creep: "Scope Creep",
    uncertainty: "Uncertainty Detected",
  };

  const lines = ["### ⚠️ Space Violation Detected", ""];
  for (const v of violations) {
    lines.push(`${severityEmoji[v.severity]} **${typeLabels[v.type]}**: ${v.evidence}`);
    lines.push(`  → ${v.suggestion}`);
    lines.push("");
  }

  lines.push("This may indicate the plan or beads were insufficient for this work.");
  return lines.join("\n");
}
