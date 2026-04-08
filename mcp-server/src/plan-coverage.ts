/**
 * Plan-to-Bead Coverage Dashboard
 *
 * The Flywheel guide: "Tell agents to go through each bead and explicitly
 * check it against the markdown plan. Or vice versa." This module makes
 * the "nothing lost in conversion" guarantee quantitative and visible.
 *
 * Two modes:
 * 1. Fast (keyword) — uses the existing auditPlanToBeads() from beads.ts
 * 2. Deep (LLM) — semantic scoring via sub-agent for higher accuracy
 *
 * The fast mode runs every approval cycle. The deep mode runs on demand
 * or when the fast mode detects gaps.
 */

import type { Bead } from './types.js';

// ─── Types ──────────────────────────────────────────────────

export interface PlanSectionCoverage {
  /** Plan section heading. */
  heading: string;
  /** First ~150 chars of section content. */
  preview: string;
  /** Coverage score 0-100. */
  score: number;
  /** Bead IDs that address this section. */
  matchedBeadIds: string[];
  /** True if score < 50 (significant gap). */
  uncovered: boolean;
}

export interface PlanCoverageResult {
  /** Overall coverage score 0-100 (average of section scores). */
  overall: number;
  /** Per-section coverage. */
  sections: PlanSectionCoverage[];
  /** Sections with score < 50. */
  gaps: PlanSectionCoverage[];
  /** Number of plan sections analyzed. */
  totalSections: number;
  /** Number of sections with adequate coverage (score >= 50). */
  coveredSections: number;
}

// ─── Plan Parsing ───────────────────────────────────────────

export interface ParsedPlanSection {
  heading: string;
  body: string;
}

/**
 * Parse a markdown plan into sections by heading.
 * Groups content under each heading until the next heading of equal or higher level.
 */
export function parsePlanSections(plan: string): ParsedPlanSection[] {
  const lines = plan.split("\n");
  const sections: ParsedPlanSection[] = [];
  let currentHeading = "";
  let currentBody: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      if (currentHeading) {
        sections.push({ heading: currentHeading, body: currentBody.join("\n").trim() });
      }
      currentHeading = headingMatch[1].trim();
      currentBody = [];
    } else if (currentHeading) {
      currentBody.push(line);
    }
  }

  if (currentHeading) {
    sections.push({ heading: currentHeading, body: currentBody.join("\n").trim() });
  }

  // Filter out empty/trivial sections
  return sections.filter((s) => s.body.length > 20);
}

// ─── LLM Coverage Scoring ───────────────────────────────────

/**
 * Prompt for LLM-based semantic coverage scoring.
 * The LLM evaluates how well each plan section is covered by existing beads.
 */
export function planCoverageScoringPrompt(
  sections: ParsedPlanSection[],
  beads: Bead[]
): string {
  const sectionList = sections
    .map((s, i) => `${i + 1}. **${s.heading}**: ${s.body.slice(0, 200)}${s.body.length > 200 ? "..." : ""}`)
    .join("\n\n");

  const beadList = beads
    .map((b) => `- **${b.id}: ${b.title}** — ${b.description.slice(0, 150)}${b.description.length > 150 ? "..." : ""}`)
    .join("\n");

  return `## Plan-to-Bead Coverage Assessment

### Plan Sections
${sectionList}

### Existing Beads
${beadList}

### Task
For each plan section, assess how well the existing beads cover its requirements.

Score each section (0-100):
- 100 = fully covered, a bead explicitly addresses every requirement in this section
- 70 = mostly covered, minor details might be missing
- 40 = partially covered, significant requirements are not addressed by any bead
- 0 = completely uncovered, no bead addresses this section at all

### Output Format
Return ONLY a JSON array (no markdown fences):
[
  { "heading": "section heading", "score": <0-100>, "matchedBeadIds": ["bead-id-1"], "gap": "what's missing (or empty string)" }
]`;
}

/**
 * Parse the LLM output from planCoverageScoringPrompt.
 */
export function parsePlanCoverageResult(
  output: string,
  sections: ParsedPlanSection[]
): PlanCoverageResult {
  const parsed = extractJSONArray(output);

  if (parsed.length === 0) {
    // Return a "no data" result rather than crashing
    return {
      overall: 0,
      sections: sections.map((s) => ({
        heading: s.heading,
        preview: s.body.slice(0, 150),
        score: 0,
        matchedBeadIds: [],
        uncovered: true,
      })),
      gaps: sections.map((s) => ({
        heading: s.heading,
        preview: s.body.slice(0, 150),
        score: 0,
        matchedBeadIds: [],
        uncovered: true,
      })),
      totalSections: sections.length,
      coveredSections: 0,
    };
  }

  // Map LLM output to PlanSectionCoverage
  const coverageSections: PlanSectionCoverage[] = sections.map((section) => {
    // Find matching LLM result by heading (fuzzy match)
    const match = parsed.find((p) =>
      typeof p.heading === "string" &&
      (p.heading.toLowerCase() === section.heading.toLowerCase() ||
       section.heading.toLowerCase().includes(p.heading.toLowerCase()) ||
       p.heading.toLowerCase().includes(section.heading.toLowerCase()))
    );

    const score = match && typeof match.score === "number"
      ? Math.max(0, Math.min(100, Math.round(match.score)))
      : 0;

    const matchedBeadIds = match && Array.isArray(match.matchedBeadIds)
      ? match.matchedBeadIds.filter((id: unknown): id is string => typeof id === "string")
      : [];

    return {
      heading: section.heading,
      preview: section.body.slice(0, 150),
      score,
      matchedBeadIds,
      uncovered: score < 50,
    };
  });

  const gaps = coverageSections.filter((s) => s.uncovered);
  const coveredCount = coverageSections.filter((s) => !s.uncovered).length;
  const overall = coverageSections.length > 0
    ? Math.round(coverageSections.reduce((sum, s) => sum + s.score, 0) / coverageSections.length)
    : 0;

  return {
    overall,
    sections: coverageSections,
    gaps,
    totalSections: coverageSections.length,
    coveredSections: coveredCount,
  };
}

// ─── Fast Coverage (from existing keyword audit) ────────────

/**
 * Convert the existing PlanToBeadAudit into a PlanCoverageResult.
 * This provides instant coverage feedback without an LLM call.
 */
export function coverageFromKeywordAudit(
  audit: import('./beads.js').PlanToBeadAudit
): PlanCoverageResult {
  const sections: PlanSectionCoverage[] = audit.sections.map((section) => {
    const topMatch = section.matches[0];
    const score = topMatch ? Math.round(topMatch.score * 100) : 0;
    return {
      heading: section.heading,
      preview: section.summary ?? "",
      score,
      matchedBeadIds: section.matches.map((m) => m.beadId),
      uncovered: score < 50,
    };
  });

  const gaps = sections.filter((s) => s.uncovered);
  const coveredCount = sections.filter((s) => !s.uncovered).length;
  const overall = sections.length > 0
    ? Math.round(sections.reduce((sum, s) => sum + s.score, 0) / sections.length)
    : 0;

  return {
    overall,
    sections,
    gaps,
    totalSections: sections.length,
    coveredSections: coveredCount,
  };
}

// ─── Display Formatting ─────────────────────────────────────

/**
 * Format a PlanCoverageResult for display in the approval UI.
 */
export function formatPlanCoverage(result: PlanCoverageResult): string {
  if (result.totalSections === 0) return "";

  const pct = result.overall;
  const emoji = pct >= 80 ? "✅" : pct >= 60 ? "⚠️" : "⛔";
  const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));

  const lines = [
    `📋 **Plan Coverage: ${pct}%** ${bar} ${emoji} (${result.coveredSections}/${result.totalSections} sections)`,
  ];

  if (result.gaps.length > 0) {
    lines.push(`  Gaps (${result.gaps.length}):`);
    for (const gap of result.gaps.slice(0, 5)) {
      lines.push(`  - ⛔ **${gap.heading}** (${gap.score}%) — ${gap.preview.slice(0, 80)}${gap.preview.length > 80 ? "..." : ""}`);
    }
    if (result.gaps.length > 5) {
      lines.push(`  ... and ${result.gaps.length - 5} more`);
    }
  }

  return lines.join("\n");
}

// ─── JSON Parsing Helper ────────────────────────────────────

function extractJSONArray(output: string): Record<string, unknown>[] {
  const match = output.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => typeof item === "object" && item !== null);
  } catch {
    return [];
  }
}
