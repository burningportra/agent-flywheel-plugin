/**
 * Automatic Bead Splitting for Parallelism
 *
 * When bv reports high-betweenness beads (bottlenecks), proposes splits
 * by analyzing descriptions for independently implementable sub-tasks
 * with disjoint file ownership.
 */
// ─── Helpers ───────────────────────────────────────────────
/** Escape characters that are dangerous inside double-quoted shell strings. */
function shellEscape(s) {
    return s
        .replace(/[\n\r]/g, " ") // newlines/carriage returns become spaces
        .replace(/[\\"$`!]/g, "\\$&"); // escape shell metacharacters
}
// ─── Bottleneck Detection ───────────────────────────────────
/**
 * Identify beads that should be split based on bv insights.
 * A bead is a split candidate if its betweenness centrality >= threshold.
 */
export function identifyBottlenecks(insights, beads, threshold = 0.3) {
    return (insights.Bottlenecks ?? [])
        .filter((b) => typeof b.Value === "number" && !Number.isNaN(b.Value) && b.Value >= threshold)
        .map((b) => {
        const bead = beads.find((bead) => bead.id === b.ID);
        return bead ? { bead, betweenness: b.Value } : null;
    })
        .filter((item) => item != null)
        .sort((a, b) => b.betweenness - a.betweenness);
}
// ─── Split Proposal Prompt ──────────────────────────────────
/**
 * Prompt for LLM-based split proposal.
 * The LLM analyzes the bead and proposes concrete child beads.
 */
export function beadSplitProposalPrompt(bead, betweenness) {
    return `## Bead Split Analysis

This bead is a dependency bottleneck (betweenness centrality: ${betweenness.toFixed(2)}). Many other beads depend on paths through it, creating a serialization point that limits parallelism.

### Bead to Split
**${bead.id}: ${bead.title}**
Priority: ${bead.priority} | Type: ${bead.type}

${bead.description}

### Task
Analyze whether this bead can be split into 2-3 independent sub-tasks. Each child must:
- Have **disjoint file ownership** (different files from siblings)
- Be **independently implementable** (no child depends on another child)
- Have **clear acceptance criteria**
- Together **fully cover** the parent bead's scope

### Output Format
Return ONLY a JSON object:
\`\`\`json
{
  "splittable": true,
  "reason": "explanation of why it can/cannot be split",
  "children": [
    {
      "title": "Child bead title",
      "description": "What to implement, why, acceptance criteria",
      "files": ["src/file1.ts", "src/file2.ts"]
    }
  ]
}
\`\`\`

If the bead is inherently sequential (cannot be meaningfully split), set "splittable": false with a reason and "children": [].`;
}
// ─── Parsing ────────────────────────────────────────────────
/**
 * Parse the LLM output into a SplitProposal.
 */
export function parseSplitProposal(output, beadId, beadTitle, betweenness) {
    const match = output.match(/\{[\s\S]*"splittable"[\s\S]*\}/);
    if (!match) {
        return {
            originalBeadId: beadId,
            originalTitle: beadTitle,
            betweennessScore: betweenness,
            dependentCount: 0,
            children: [],
            splittable: false,
            reason: "Failed to parse split proposal output",
        };
    }
    try {
        const parsed = JSON.parse(match[0]);
        const splittable = parsed.splittable === true;
        const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
        const children = [];
        if (splittable && Array.isArray(parsed.children)) {
            for (const child of parsed.children) {
                if (typeof child !== "object" || !child)
                    continue;
                const title = typeof child.title === "string" ? child.title : "";
                const description = typeof child.description === "string" ? child.description : "";
                const files = Array.isArray(child.files)
                    ? child.files.filter((f) => typeof f === "string")
                    : [];
                if (title) {
                    children.push({ title, description, files });
                }
            }
        }
        // Detect overlapping files across children
        const fileCounts = new Map();
        for (const child of children) {
            for (const f of child.files) {
                fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
            }
        }
        const overlapping = [...fileCounts.entries()]
            .filter(([, count]) => count > 1)
            .map(([f]) => f);
        let finalSplittable = splittable && children.length >= 2;
        let finalReason = reason;
        // Single-child override
        if (splittable && children.length < 2) {
            finalSplittable = false;
            const overrideMsg = `LLM proposed split but returned ${children.length} child(ren) — need at least 2 for meaningful parallelism`;
            finalReason = finalReason ? `${finalReason}; ${overrideMsg}` : overrideMsg;
        }
        // Overlapping files warning
        if (overlapping.length > 0) {
            const warnMsg = `Warning: overlapping files across children: ${overlapping.join(", ")}`;
            finalReason = finalReason ? `${finalReason}; ${warnMsg}` : warnMsg;
        }
        return {
            originalBeadId: beadId,
            originalTitle: beadTitle,
            betweennessScore: betweenness,
            dependentCount: 0,
            children,
            splittable: finalSplittable,
            reason: finalReason,
        };
    }
    catch {
        return {
            originalBeadId: beadId,
            originalTitle: beadTitle,
            betweennessScore: betweenness,
            dependentCount: 0,
            children: [],
            splittable: false,
            reason: "JSON parse error in split proposal",
        };
    }
}
// ─── Formatting ─────────────────────────────────────────────
/**
 * Format a split proposal for display.
 */
export function formatSplitProposal(proposal) {
    if (!proposal.splittable) {
        return `### ${proposal.originalBeadId}: ${proposal.originalTitle}\n` +
            `Cannot split: ${proposal.reason ?? "inherently sequential"}`;
    }
    const lines = [
        `### ${proposal.originalBeadId}: ${proposal.originalTitle}`,
        `Betweenness: ${proposal.betweennessScore.toFixed(2)} — split into ${proposal.children.length} children:`,
        "",
    ];
    for (let i = 0; i < proposal.children.length; i++) {
        const child = proposal.children[i];
        lines.push(`**${i + 1}. ${child.title}**`);
        if (child.description) {
            lines.push(`   ${child.description.slice(0, 200)}${child.description.length > 200 ? "..." : ""}`);
        }
        if (child.files.length > 0) {
            lines.push(`   Files: ${child.files.join(", ")}`);
        }
        lines.push("");
    }
    return lines.join("\n");
}
/**
 * Format split proposals as br CLI commands for the agent to execute.
 */
export function formatSplitCommands(proposal) {
    if (!proposal.splittable || proposal.children.length === 0)
        return "";
    const commands = [
        `# Split bottleneck bead ${proposal.originalBeadId}: ${proposal.originalTitle}`,
        "",
    ];
    for (const child of proposal.children) {
        const desc = shellEscape(child.description);
        const title = shellEscape(child.title);
        const filesLine = child.files.length > 0 ? `\\n### Files: ${child.files.map(shellEscape).join(", ")}` : "";
        commands.push(`br create "${title}" -t task -p 2 --description "${desc}${filesLine}"`);
    }
    commands.push("");
    commands.push(`# After creating children, transfer dependencies:`);
    commands.push(`# 1. Find what depended on ${proposal.originalBeadId}: br dep list ${proposal.originalBeadId}`);
    commands.push(`# 2. Add those deps to the appropriate child bead: br dep add <dependent> <child-id>`);
    commands.push(`# 3. Close the original: br update ${proposal.originalBeadId} --status closed`);
    return commands.join("\n");
}
//# sourceMappingURL=bead-splitting.js.map