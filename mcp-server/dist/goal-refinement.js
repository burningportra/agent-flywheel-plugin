/**
 * Goal Refinement — questionnaire that sharpens a raw user goal
 * into a structured, unambiguous specification.
 *
 * Exports:
 *  - synthesizeGoal(rawGoal, answers)     — pure formatter, no LLM
 *  - extractConstraints(answers)          — pull constraint strings from answers
 *  - parseQuestionsJSON(output)           — parse LLM output into questions
 *
 * Note: LLM goal refinement (question generation and interactive questionnaire)
 * has been removed from this module. The caller should invoke goal refinement
 * via the CC Agent tool and pass the resulting answers to synthesizeGoal().
 * // LLM goal refinement: caller should invoke this via CC Agent tool
 */
// ─── synthesizeGoal ─────────────────────────────────────────
/**
 * Pure function — formats a raw goal + answers into structured sections.
 * Omits empty sections. No LLM calls, no side effects.
 */
export function synthesizeGoal(rawGoal, answers) {
    // Categorize each answer into exactly one bucket (first match wins).
    // This prevents an answer from appearing in multiple sections.
    const buckets = {
        scope: [],
        constraints: [],
        nonGoals: [],
        successCriteria: [],
        implNotes: [],
    };
    for (const a of answers) {
        if (a.id.includes("scope") || a.id.includes("target") || a.id.includes("layer")) {
            buckets.scope.push(a);
        }
        else if (a.id.includes("constraint")) {
            buckets.constraints.push(a);
        }
        else if (a.id.includes("non-goal") ||
            a.id.includes("exclude") ||
            a.id.includes("avoid") ||
            a.value.startsWith("no-") ||
            a.value.startsWith("avoid-")) {
            buckets.nonGoals.push(a);
        }
        else if (a.id.includes("success") ||
            a.id.includes("criteria") ||
            a.id.includes("quality") ||
            a.id.includes("test")) {
            buckets.successCriteria.push(a);
        }
        else {
            buckets.implNotes.push(a);
        }
    }
    const fmt = (items) => items.map((a) => `- ${a.label}`).join("\n");
    const fmtImpl = (items) => items.map((a) => `- **${a.id}**: ${a.label}`).join("\n");
    // Build output — omit empty sections
    const sections = [`## Goal\n${rawGoal}`];
    const scope = fmt(buckets.scope);
    const constraints = fmt(buckets.constraints);
    const nonGoals = fmt(buckets.nonGoals);
    const successCriteria = fmt(buckets.successCriteria);
    const implNotes = fmtImpl(buckets.implNotes);
    if (scope)
        sections.push(`## Scope\n${scope}`);
    if (constraints)
        sections.push(`## Constraints\n${constraints}`);
    if (nonGoals)
        sections.push(`## Non-Goals\n${nonGoals}`);
    if (successCriteria)
        sections.push(`## Success Criteria\n${successCriteria}`);
    if (implNotes)
        sections.push(`## Implementation Notes\n${implNotes}`);
    return sections.join("\n\n");
}
// ─── Helpers ────────────────────────────────────────────────
/** Extract constraint strings from refinement answers for the planner. */
export function extractConstraints(answers) {
    return answers
        .filter((a) => a.id.includes("constraint") ||
        a.id.includes("non-goal") ||
        a.id.includes("avoid") ||
        a.id.includes("exclude"))
        .map((a) => a.label)
        .filter(Boolean);
}
/**
 * Parse LLM output as a JSON array of questions. Handles markdown
 * code fences. Falls back to a single generic question on parse failure.
 */
export function parseQuestionsJSON(output) {
    // Strip markdown code fences if present
    let jsonStr = output;
    const fenceMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
        jsonStr = fenceMatch[1].trim();
    }
    try {
        const parsed = JSON.parse(jsonStr);
        if (!Array.isArray(parsed)) {
            throw new Error("Expected JSON array");
        }
        // Validate and normalize each question
        return parsed
            .filter((q) => q &&
            typeof q.id === "string" &&
            typeof q.prompt === "string" &&
            Array.isArray(q.options) &&
            q.options.length > 0)
            .map((q) => ({
            id: q.id,
            label: q.label || q.id,
            prompt: q.prompt,
            options: q.options
                .filter((o) => o && typeof o.value === "string" && typeof o.label === "string")
                .map((o) => ({
                value: o.value,
                label: o.label,
                description: o.description,
            })),
            allowOther: q.allowOther !== false,
        }));
    }
    catch {
        // Fallback: single generic question
        return [
            {
                id: "approach",
                label: "Approach",
                prompt: "How would you like to approach this goal?",
                options: [
                    { value: "minimal", label: "Minimal — smallest possible change" },
                    { value: "standard", label: "Standard — balanced approach" },
                    { value: "thorough", label: "Thorough — cover all cases and edge conditions" },
                ],
                allowOther: true,
            },
        ];
    }
}
//# sourceMappingURL=goal-refinement.js.map