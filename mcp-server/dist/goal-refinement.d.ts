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
export interface QuestionOption {
    value: string;
    label: string;
    description?: string;
}
export interface RefinementQuestion {
    id: string;
    label: string;
    prompt: string;
    options: QuestionOption[];
    allowOther: boolean;
}
export interface RefinementAnswer {
    id: string;
    value: string;
    label: string;
    wasCustom: boolean;
}
export interface RefinementResult {
    answers: RefinementAnswer[];
    cancelled: boolean;
}
export interface GoalRefinementOutcome {
    enrichedGoal: string;
    answers: RefinementAnswer[];
    skipped: boolean;
}
/**
 * Pure function — formats a raw goal + answers into structured sections.
 * Omits empty sections. No LLM calls, no side effects.
 */
export declare function synthesizeGoal(rawGoal: string, answers: RefinementAnswer[]): string;
/** Extract constraint strings from refinement answers for the planner. */
export declare function extractConstraints(answers: RefinementAnswer[]): string[];
/**
 * Parse LLM output as a JSON array of questions. Handles markdown
 * code fences. Falls back to a single generic question on parse failure.
 */
export declare function parseQuestionsJSON(output: string): RefinementQuestion[];
//# sourceMappingURL=goal-refinement.d.ts.map