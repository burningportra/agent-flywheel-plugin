/**
 * Plan Quality Oracle
 *
 * Scores plans on 5 dimensions and gates the plan→bead transition.
 * If the score is too low, the plan gets sent back for refinement.
 */

// ─── Types ──────────────────────────────────────────────────

export interface PlanQualityScore {
  /** Overall composite score 0-100 (weighted average of dimensions). */
  overall: number;
  /** User-facing workflows with step-by-step detail (0-100). */
  workflows: number;
  /** Failure modes and edge cases explicitly addressed (0-100). */
  edgeCases: number;
  /** Architectural decisions with rationale, not bare assertions (0-100). */
  architecture: number;
  /** Types, signatures, params — concrete vs vague (0-100). */
  specificity: number;
  /** Test cases derivable from the plan (0-100). */
  testability: number;
  /** Sections that dragged the score down. */
  weakSections: string[];
  /** Gate recommendation. */
  recommendation: "block" | "warn" | "proceed";
}

// ─── Scoring Prompt ─────────────────────────────────────────

/**
 * Prompt for LLM-based plan quality scoring.
 * Returns structured JSON that can be parsed by parsePlanQualityScore().
 */
export function planQualityScoringPrompt(plan: string, goal: string): string {
  return `## Plan Quality Assessment

Score this implementation plan for the goal: "${goal}"

### Plan Content

${plan}

### Score on 5 dimensions (0-100 each):

**1. Workflow Completeness (0-100)**
Does every user-facing workflow have step-by-step detail?
- 100 = every workflow is a numbered sequence with inputs, outputs, error states
- 70 = most workflows detailed but a few are hand-wavy
- 40 = workflows mentioned but not stepped through
- 0 = no workflow detail at all

**2. Edge Case Density (0-100)**
Are failure modes explicitly addressed per workflow?
- 100 = every workflow has explicit "what if X fails" sections with recovery
- 70 = main failure modes covered, some gaps
- 40 = happy path only with a generic "error handling" section
- 0 = no failure mode discussion

**3. Architectural Decision Coverage (0-100)**
Does every non-obvious design choice have a rationale?
- 100 = every choice justified with tradeoff analysis ("chose X over Y because Z")
- 70 = most decisions explained, a few bare assertions
- 40 = architecture stated but reasoning sparse
- 0 = no rationale for any decision

**4. Type/API Specificity (0-100)**
Are function signatures, parameter types, return types specified?
- 100 = a developer could write type declarations from the plan alone
- 70 = most APIs have shapes, some vague
- 40 = general descriptions without concrete types
- 0 = "create an API for X" with no shape

**5. Testability (0-100)**
Can test cases be mechanically derived from the plan?
- 100 = test strategy section with specific scenarios and expected behaviors
- 70 = test plan with general coverage areas
- 40 = "add tests" mentioned but no specifics
- 0 = no testing discussion

### Output Format
Return ONLY a JSON object (no markdown fences, no explanation):
{"workflows": <0-100>, "edgeCases": <0-100>, "architecture": <0-100>, "specificity": <0-100>, "testability": <0-100>, "weakSections": ["section name 1", "section name 2"]}`;
}

// ─── Score Parsing ──────────────────────────────────────────

/**
 * Parse the LLM output from planQualityScoringPrompt into a PlanQualityScore.
 * Handles common LLM output quirks (markdown fences, extra text around JSON).
 */
export function parsePlanQualityScore(output: string): PlanQualityScore | null {
  // Try to extract JSON from the output
  const jsonMatch = output.match(/\{[\s\S]*?"workflows"[\s\S]*?\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    const workflows = clampScore(parsed.workflows);
    const edgeCases = clampScore(parsed.edgeCases);
    const architecture = clampScore(parsed.architecture);
    const specificity = clampScore(parsed.specificity);
    const testability = clampScore(parsed.testability);
    const weakSections = Array.isArray(parsed.weakSections)
      ? parsed.weakSections.filter((s: unknown) => typeof s === "string").slice(0, 10)
      : [];

    // Weighted average: workflows 25%, edgeCases 20%, architecture 20%, specificity 20%, testability 15%
    const overall = Math.round(
      workflows * 0.25 +
      edgeCases * 0.20 +
      architecture * 0.20 +
      specificity * 0.20 +
      testability * 0.15
    );

    const recommendation: PlanQualityScore["recommendation"] =
      overall < 60 ? "block" : overall < 80 ? "warn" : "proceed";

    return {
      overall,
      workflows,
      edgeCases,
      architecture,
      specificity,
      testability,
      weakSections,
      recommendation,
    };
  } catch {
    return null;
  }
}

/** Clamp a score to 0-100, defaulting to 50 for non-numeric values. */
function clampScore(value: unknown): number {
  if (typeof value !== "number" || isNaN(value)) return 50;
  return Math.max(0, Math.min(100, Math.round(value)));
}

// ─── Display Formatting ─────────────────────────────────────

/**
 * Format a PlanQualityScore for display in the approval UI.
 */
export function formatPlanQualityScore(score: PlanQualityScore): string {
  const bar = (value: number): string => {
    const filled = Math.round(value / 10);
    return "█".repeat(filled) + "░".repeat(10 - filled);
  };

  const recEmoji = score.recommendation === "proceed" ? "✅"
    : score.recommendation === "warn" ? "⚠️"
    : "⛔";

  const lines = [
    `📊 **Plan Quality: ${score.overall}/100** ${recEmoji}`,
    `  Workflows:    ${bar(score.workflows)} ${score.workflows}%`,
    `  Edge Cases:   ${bar(score.edgeCases)} ${score.edgeCases}%`,
    `  Architecture: ${bar(score.architecture)} ${score.architecture}%`,
    `  Specificity:  ${bar(score.specificity)} ${score.specificity}%`,
    `  Testability:  ${bar(score.testability)} ${score.testability}%`,
  ];

  if (score.weakSections.length > 0) {
    lines.push(`  Weak spots: ${score.weakSections.join(", ")}`);
  }

  if (score.recommendation === "block") {
    lines.push(`  ⛔ Score too low — refine the plan before creating beads`);
  } else if (score.recommendation === "warn") {
    lines.push(`  ⚠️ Acceptable but could benefit from another refinement round`);
  }

  return lines.join("\n");
}
