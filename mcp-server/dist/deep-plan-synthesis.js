// Section-wise synthesis helpers for deep-plan planner outputs.
//
// This module prepares merged markdown from multiple planner outputs. It does
// NOT spawn any LLMs. The orchestrating skill is responsible for invoking a
// model to resolve any "Synthesis required" blocks.
//
// Strategy:
//   1. Split each planner's markdown by top-level `^## ` section headings.
//   2. Iterate sections in first-seen order across all planners.
//   3. For each section:
//        - If every planner produced byte-identical content → emit verbatim.
//        - Otherwise → emit a "Synthesis required" block enumerating variants.
//   4. Fallback to whole-file concatenation if requested or any plan lacks
//      `##` structure.
/** Threshold above which section-wise synthesis is worth its overhead. */
const SECTION_WISE_FILE_THRESHOLD = 500;
/**
 * Split a markdown document into sections keyed by normalized `## ` heading.
 *
 * - Content before the first `## ` heading is stored under the empty-string key
 *   (preamble), if non-empty.
 * - The returned map preserves insertion order (first-seen wins on duplicate
 *   headings — subsequent duplicates are appended to the existing section).
 * - Keys are the trimmed heading text (without the leading `## `).
 */
export function splitBySections(markdown) {
    const out = new Map();
    const lines = markdown.split(/\r?\n/);
    let currentKey = "";
    let buffer = [];
    const flush = () => {
        if (buffer.length === 0)
            return;
        const content = buffer.join("\n");
        if (currentKey === "" && content.trim() === "") {
            buffer = [];
            return;
        }
        const prior = out.get(currentKey);
        out.set(currentKey, prior === undefined ? content : `${prior}\n${content}`);
        buffer = [];
    };
    for (const line of lines) {
        const headingMatch = /^##\s+(.+?)\s*$/.exec(line);
        if (headingMatch) {
            flush();
            currentKey = headingMatch[1].trim();
            buffer = [line];
        }
        else {
            buffer.push(line);
        }
    }
    flush();
    return out;
}
/** Return true when the repo is large enough to benefit from section-wise mode. */
export function shouldUseSectionWise(repoFileCount) {
    return repoFileCount >= SECTION_WISE_FILE_THRESHOLD;
}
/**
 * Prepare a merged plan from multiple planner outputs.
 *
 * This function is synchronous at heart but returns a Promise so the signature
 * matches the intended orchestration point (where real LLM synthesis could be
 * awaited). No model calls happen here.
 */
export async function synthesizePlans(plans, opts = {}) {
    if (plans.length === 0) {
        return "# Synthesized Plan\n\n(No planner outputs provided.)\n";
    }
    const lacksStructure = plans.some((p) => !hasTopLevelSections(p.plan));
    if (opts.whole || lacksStructure) {
        return renderWholeFallback(plans, {
            reason: opts.whole
                ? "whole mode requested"
                : "one or more plans lack `##` section structure",
        });
    }
    // Build per-plan section maps and the union of section titles in first-seen order.
    const splits = plans.map((p) => ({
        name: p.name,
        model: p.model,
        sections: splitBySections(p.plan),
    }));
    const orderedTitles = [];
    const seen = new Set();
    for (const s of splits) {
        for (const title of s.sections.keys()) {
            if (!seen.has(title)) {
                seen.add(title);
                orderedTitles.push(title);
            }
        }
    }
    const chunks = [];
    chunks.push("# Synthesized Plan (section-wise)\n");
    chunks.push(`_Assembled from ${plans.length} planner output(s): ${plans
        .map((p) => `${p.name} (${p.model})`)
        .join(", ")}_\n`);
    for (const title of orderedTitles) {
        const variants = splits.map((s) => ({
            name: s.name,
            model: s.model,
            content: s.sections.get(title),
        }));
        const present = variants.filter((v) => v.content !== undefined);
        if (present.length === 0)
            continue;
        const first = present[0].content;
        const allIdentical = present.every((v) => v.content === first);
        if (allIdentical) {
            // Identical-section shortcut — include verbatim.
            chunks.push(first.trimEnd() + "\n");
            continue;
        }
        // Divergent — emit a Synthesis required block per variant.
        const header = title === "" ? "(preamble)" : title;
        chunks.push(`## ${header}\n`);
        chunks.push(`<!-- Synthesis required: ${present.length} planner(s) produced divergent content for "${header}". -->\n`);
        chunks.push("> **Synthesis required**\n>");
        chunks.push(`> ${present.length} planner variants for section "${header}". Merge manually or via LLM.\n`);
        for (const v of present) {
            chunks.push(`### Variant: ${v.name} (${v.model})\n`);
            chunks.push("```markdown");
            chunks.push(v.content.trimEnd());
            chunks.push("```\n");
        }
    }
    return chunks.join("\n");
}
function hasTopLevelSections(markdown) {
    return /^##\s+\S/m.test(markdown);
}
function renderWholeFallback(plans, opts) {
    const parts = [];
    parts.push("# Synthesized Plan (whole-file fallback)\n");
    parts.push(`> **Warning:** section-wise synthesis skipped — ${opts.reason}. Concatenating planner outputs verbatim.\n`);
    for (const p of plans) {
        parts.push(`\n---\n\n## Planner: ${p.name} (${p.model})\n`);
        parts.push(p.plan.trimEnd() + "\n");
    }
    return parts.join("\n");
}
//# sourceMappingURL=deep-plan-synthesis.js.map