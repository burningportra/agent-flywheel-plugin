/**
 * Self-Improvement Loop — Feedback & Prompt Tracking
 *
 * A. Post-flywheel feedback — structured survey saved after completion
 * B. Automatic CASS context injection — prepend relevant rules to prompts
 * C. Prompt effectiveness tracking — track which prompts produce real changes
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, appendFileSync } from "fs";
import { join } from "path";
import { parseFeedbackFile } from "./parsers.js";
import { createLogger } from "./logger.js";
const log = createLogger("feedback");
const FEEDBACK_DIR = ".pi/flywheel-feedback";
/**
 * Collect feedback from the current flywheel state.
 */
export function collectFeedback(state) {
    const beadResults = Object.values(state.beadResults ?? {});
    const completedCount = beadResults.filter((r) => r.status === "success").length;
    return {
        timestamp: new Date().toISOString(),
        goal: state.selectedGoal ?? "unknown",
        beadCount: state.activeBeadIds?.length ?? 0,
        completedCount,
        totalRounds: state.iterationRound,
        planQualityScore: state.planReadinessScore?.overall,
        foregoneScore: state.foregoneScore?.overall,
        polishRounds: state.polishRound,
        converged: state.polishConverged,
        regressions: [], // Populated from session history if available
        spaceViolationCount: 0, // Populated from session history if available
    };
}
/**
 * Save feedback to the project-local feedback directory.
 */
export function saveFeedback(cwd, feedback) {
    const dir = join(cwd, FEEDBACK_DIR);
    mkdirSync(dir, { recursive: true });
    const filename = `feedback-${Date.now()}.json`;
    const filepath = join(dir, filename);
    writeFileSync(filepath, JSON.stringify(feedback, null, 2), "utf8");
    return filepath;
}
/**
 * Load all feedback files from the project.
 */
export function loadAllFeedback(cwd) {
    const dir = join(cwd, FEEDBACK_DIR);
    if (!existsSync(dir))
        return [];
    try {
        return readdirSync(dir)
            .filter((f) => f.endsWith(".json"))
            .sort() // chronological order
            .map((f) => {
            try {
                const raw = readFileSync(join(dir, f), "utf8");
                const parsed = parseFeedbackFile(raw);
                return parsed.ok ? parsed.data : null;
            }
            catch (err) {
                log.warn("failed to read feedback file", { code: "parse_failure", file: f, cause: err instanceof Error ? err.message : String(err) });
                return null;
            }
        })
            .filter((f) => f != null);
    }
    catch (err) {
        log.warn("failed to read feedback directory", { code: "parse_failure", cause: err instanceof Error ? err.message : String(err) });
        return [];
    }
}
export function computeFeedbackStats(feedbacks) {
    if (feedbacks.length === 0) {
        return {
            totalFlywheelRuns: 0,
            avgBeadCount: 0,
            avgCompletionRate: 0,
            avgPolishRounds: 0,
            convergenceRate: 0,
            avgPlanQuality: null,
            avgForegoneScore: null,
        };
    }
    const n = feedbacks.length;
    const avgBeadCount = feedbacks.reduce((s, f) => s + f.beadCount, 0) / n;
    const avgCompletionRate = feedbacks.reduce((s, f) => {
        return s + (f.beadCount > 0 ? f.completedCount / f.beadCount : 1);
    }, 0) / n;
    const avgPolishRounds = feedbacks.reduce((s, f) => s + f.polishRounds, 0) / n;
    const convergenceRate = feedbacks.filter((f) => f.converged).length / n;
    const planScores = feedbacks.filter((f) => f.planQualityScore != null).map((f) => f.planQualityScore);
    const foregoneScores = feedbacks.filter((f) => f.foregoneScore != null).map((f) => f.foregoneScore);
    return {
        totalFlywheelRuns: n,
        avgBeadCount: Math.round(avgBeadCount * 10) / 10,
        avgCompletionRate: Math.round(avgCompletionRate * 100),
        avgPolishRounds: Math.round(avgPolishRounds * 10) / 10,
        convergenceRate: Math.round(convergenceRate * 100),
        avgPlanQuality: planScores.length > 0 ? Math.round(planScores.reduce((s, v) => s + v, 0) / planScores.length) : null,
        avgForegoneScore: foregoneScores.length > 0 ? Math.round(foregoneScores.reduce((s, v) => s + v, 0) / foregoneScores.length) : null,
    };
}
export function formatFeedbackStats(stats) {
    if (stats.totalFlywheelRuns === 0)
        return "No flywheel history yet.";
    const lines = [
        `📊 **Flywheel History** (${stats.totalFlywheelRuns} runs)`,
        `  Avg beads/run:      ${stats.avgBeadCount}`,
        `  Completion rate:     ${stats.avgCompletionRate}%`,
        `  Avg polish rounds:   ${stats.avgPolishRounds}`,
        `  Convergence rate:    ${stats.convergenceRate}%`,
    ];
    if (stats.avgPlanQuality != null) {
        lines.push(`  Avg plan quality:    ${stats.avgPlanQuality}/100`);
    }
    if (stats.avgForegoneScore != null) {
        lines.push(`  Avg foregone score:  ${stats.avgForegoneScore}/100`);
    }
    return lines.join("\n");
}
// ─── B. Automatic CASS Context Injection ────────────────────
/** Prepend CASS context to a prompt if available. */
export function withCassContext(prompt, cwd, taskDescription) {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { readMemory } = require('./memory.js');
        const memory = readMemory(cwd, taskDescription);
        if (!memory)
            return prompt;
        return `## Context from Prior Flywheel Runs\n${memory}\n\n---\n\n${prompt}`;
    }
    catch (err) {
        log.warn("CASS context injection failed", { code: "cli_not_available", cause: err instanceof Error ? err.message : String(err) });
        return prompt;
    }
}
// In-memory tracking for the current session
const _promptTracker = new Map();
/**
 * Track a prompt use and its outcome.
 */
export function trackPromptUse(name, changesProduced) {
    const existing = _promptTracker.get(name) ?? { name, uses: 0, changesProduced: 0, effectiveUses: 0 };
    existing.uses++;
    existing.changesProduced += changesProduced;
    if (changesProduced > 0)
        existing.effectiveUses++;
    _promptTracker.set(name, existing);
}
/**
 * Get all prompt tracking records for the current session.
 */
export function getPromptRecords() {
    return Array.from(_promptTracker.values());
}
/**
 * Get the effectiveness rate for a specific prompt (0-1).
 */
export function getPromptEffectiveness(name) {
    const record = _promptTracker.get(name);
    if (!record || record.uses === 0)
        return null;
    return record.effectiveUses / record.uses;
}
/**
 * Format prompt effectiveness for display.
 */
export function formatPromptEffectiveness() {
    const records = getPromptRecords();
    if (records.length === 0)
        return "";
    const sorted = records.sort((a, b) => {
        const aRate = a.uses > 0 ? a.effectiveUses / a.uses : 0;
        const bRate = b.uses > 0 ? b.effectiveUses / b.uses : 0;
        return bRate - aRate;
    });
    const lines = ["### Prompt Effectiveness (this session)"];
    for (const r of sorted) {
        const rate = r.uses > 0 ? Math.round((r.effectiveUses / r.uses) * 100) : 0;
        const bar = "█".repeat(Math.round(rate / 10)) + "░".repeat(10 - Math.round(rate / 10));
        lines.push(`  ${r.name}: ${bar} ${rate}% (${r.effectiveUses}/${r.uses} effective, ${r.changesProduced} total changes)`);
    }
    return lines.join("\n");
}
/**
 * Reset tracking (for testing).
 */
export function resetPromptTracking() {
    _promptTracker.clear();
}
/**
 * Prompt text for collecting structured tool feedback from an agent.
 * Paste this into the agent's context after it finishes using a tool.
 */
export function toolFeedbackPrompt(toolName) {
    return `## Tool Feedback Survey: ${toolName}\n\nYou just used ${toolName}. Please provide structured feedback so we can improve it.\n\n### Rate on 1-5:\n- **Usability**: How easy was it to use correctly?\n- **Ergonomics**: Did the API surface feel natural and agent-friendly?\n\n### Qualitative:\n- **Strengths**: What worked well? (list 1-3 items)\n- **Weaknesses**: What was confusing, missing, or annoying? (list 1-3 items)\n- **Suggestions**: Specific improvements you'd make (list 1-3 items)\n\n### Output Format (JSON)\n\`\`\`json\n{\n  "usability": <1-5>,\n  "ergonomics": <1-5>,\n  "strengths": ["..."],\n  "weaknesses": ["..."],\n  "suggestions": ["..."]\n}\n\`\`\``;
}
export function parseToolFeedback(output, toolName) {
    const match = output.match(/```json\s*([\s\S]*?)```/);
    if (!match)
        return null;
    try {
        const p = JSON.parse(match[1]);
        return {
            toolName,
            timestamp: Date.now(),
            usability: Math.min(5, Math.max(1, Math.round(p.usability ?? 3))),
            ergonomics: Math.min(5, Math.max(1, Math.round(p.ergonomics ?? 3))),
            strengths: Array.isArray(p.strengths) ? p.strengths : [],
            weaknesses: Array.isArray(p.weaknesses) ? p.weaknesses : [],
            suggestions: Array.isArray(p.suggestions) ? p.suggestions : [],
        };
    }
    catch (err) {
        log.warn("failed to parse tool feedback", { code: "parse_failure", cause: err instanceof Error ? err.message : String(err) });
        return null;
    }
}
/** Save tool feedback to .pi-flywheel-feedback/tools/<toolName>.jsonl */
export function saveToolFeedback(cwd, feedback) {
    try {
        const dir = join(cwd, ".pi-flywheel-feedback", "tools");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${feedback.toolName}.jsonl`);
        appendFileSync(file, JSON.stringify(feedback) + "\n", "utf8");
    }
    catch (err) {
        log.warn("failed to save tool feedback", { code: "cli_failure", cause: err instanceof Error ? err.message : String(err) });
    }
}
//# sourceMappingURL=feedback.js.map