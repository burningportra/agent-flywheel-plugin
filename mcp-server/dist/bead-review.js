import { join } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { FLYWHEEL_TMP_PREFIX, guardedRemoveDir } from "./utils/fs-safety.js";
/**
 * Send beads to an alternative model for cross-model review.
 * Uses pi --print with a different model to get a fresh perspective.
 */
export async function crossModelBeadReview(exec, cwd, beads, goal, signal) {
    // Pick an alternative model — try to use something different from the current session
    const altModel = pickAlternativeModel();
    const beadList = beads.map((b) => {
        return `### Bead ${b.id}: ${b.title}
Priority: ${b.priority} | Type: ${b.type} | Status: ${b.status}
${b.description}`;
    }).join("\n\n---\n\n");
    const prompt = `You are reviewing a set of implementation beads (tasks) for the goal: "${goal}"

## Beads to Review

${beadList}

## Your Task
Review these beads critically. Look for:
1. **Gaps in coverage** — is anything missing that the goal requires?
2. **Oversimplifications** — are any beads too vague or hand-wavy?
3. **Missing dependencies** — should any bead depend on another that it doesn't?
4. **Unclear scope** — would a fresh developer know exactly what to do?
5. **Split or merge candidates** — are any beads too large (should split) or too small (should merge)?
6. **Redundancies** — do any beads overlap significantly?

Output specific, actionable suggestions as a numbered list. Each suggestion should reference specific bead IDs.
Be specific. If everything looks solid, explain briefly why each bead is well-formed. Always output a numbered list.
Check for: parallel-ready beads that modify the same files, closure extraction feasibility, missing error handling, vague acceptance criteria.`;
    // Use FLYWHEEL_TMP_PREFIX so guardedRemoveDir recognises this scratch dir
    // as flywheel-owned under the tmpdir ownership rule. Hardcoding
    // `pi-bead-review-` would still work but would silently drift from the
    // allowlist the moment anyone changed either side.
    const outputDir = join(tmpdir(), `${FLYWHEEL_TMP_PREFIX}bead-review-${Date.now()}`);
    mkdirSync(outputDir, { recursive: true });
    const taskFile = join(outputDir, "review-task.md");
    writeFileSync(taskFile, prompt, "utf8");
    try {
        const args = [
            "--print",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--tools", "read,bash",
        ];
        if (altModel) {
            args.push("--model", altModel);
        }
        args.push(`@${taskFile}`);
        const result = await exec("pi", args, {
            timeout: 120000, // 2 min
            cwd,
        });
        const rawOutput = result.stdout.trim();
        const suggestions = parseSuggestions(rawOutput);
        const fallbackUsed = suggestions.length > 0 && !rawOutput.match(/^\s*\d+\.\s+/m) && !rawOutput.match(/^\s*[-*•]\s+/m);
        // Clean up temp files (guarded: refuses anything outside tmpdir prefix
        // or flywheel-managed dirs — never recursive-rm user-owned paths).
        try {
            guardedRemoveDir(outputDir, cwd);
        }
        catch { /* ignore */ }
        return {
            suggestions,
            rawOutput,
            model: altModel ?? "default",
            fallbackUsed: fallbackUsed || undefined,
        };
    }
    catch (err) {
        // Clean up temp files on error too
        try {
            guardedRemoveDir(outputDir, cwd);
        }
        catch { /* ignore */ }
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
            suggestions: [],
            rawOutput: errorMessage,
            model: altModel ?? "default",
            error: errorMessage,
        };
    }
}
/**
 * Pick an alternative model for cross-review.
 * Tries to select a model different from the likely current session model.
 */
function pickAlternativeModel() {
    // crossModelBeadReview uses exec("pi") which is not available in CC.
    // Return undefined so no --model flag is passed.
    return undefined;
}
/**
 * Parse suggestions from model output.
 * Supports numbered lists, bullet points, markdown headers, and paragraph fallback.
 */
export function parseSuggestions(output) {
    const lines = output.split("\n");
    const suggestions = [];
    let current = "";
    for (const line of lines) {
        // Numbered list: "1. something"
        const numMatch = line.match(/^\s*(\d+)\.\s+(.+)/);
        // Bullet point: "- something", "* something", "• something"
        const bulletMatch = !numMatch && line.match(/^\s*[-*•]\s+(.+)/);
        // Markdown header: "## something"
        const headerMatch = !numMatch && !bulletMatch && line.match(/^#{1,3}\s+(.+)/);
        if (numMatch) {
            if (current)
                suggestions.push(current.trim());
            current = numMatch[2];
        }
        else if (bulletMatch) {
            if (current)
                suggestions.push(current.trim());
            current = bulletMatch[1];
        }
        else if (headerMatch) {
            // Headers act as section delimiters — flush current, but don't start a new suggestion from the header itself
            if (current)
                suggestions.push(current.trim());
            current = "";
        }
        else if (current && line.trim()) {
            current += " " + line.trim();
        }
    }
    if (current)
        suggestions.push(current.trim());
    // Paragraph fallback: if nothing parsed, split on double newlines
    if (suggestions.length === 0 && output.trim()) {
        const paragraphs = output.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
        return paragraphs;
    }
    return suggestions;
}
//# sourceMappingURL=bead-review.js.map