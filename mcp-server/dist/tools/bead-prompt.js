import { listTemplates } from '../bead-templates.js';
function formatBuiltInTemplateIds() {
    const ids = [...new Set(listTemplates().map((template) => template.id))].sort();
    return ids.map((id) => `- ${id}`).join('\n');
}
export function buildBeadCreationPrompt(opts) {
    const sections = [];
    sections.push(`## Goal\n${opts.goal}`);
    if (opts.constraints && opts.constraints.length > 0) {
        sections.push(`## Constraints\n${opts.constraints.map(c => `- ${c}`).join('\n')}`);
    }
    if (opts.planPath) {
        const preview = opts.planPreview
            ? `\n\n### Plan preview\n\`\`\`\n${opts.planPreview}\n\`\`\``
            : '';
        sections.push(`## Approved plan\nRead the full plan from \`${opts.planPath}\` before creating beads.${preview}`);
    }
    if (opts.repoContext) {
        sections.push(`## Repository Context\n${opts.repoContext}`);
    }
    sections.push(`## Bead creation rules

Each bead is one focused unit of work (1-4 hours). Scope beads to single concerns — no mega-beads. Order by dependency: foundation beads before feature beads.

Use the \`br\` CLI. The canonical commands are:

\`\`\`
br create --title "Verb phrase" --description "WHAT/WHY/HOW" --priority <0-4> --type task
br dep add <downstream> <upstream>
br update <id> --status <open|in_progress|deferred|closed>
br close <id> --reason "..."
\`\`\`

**Dependency syntax:** \`br dep add\` takes two positional arguments — the downstream (dependent) bead first, then the upstream (dependency) it waits on. Do not pass any flags; br silently accepts unknown flags and returns empty output, so a mistyped flag looks like success but creates no edge.

**Priority:** 0 (highest) through 4 (lowest).

Each bead description must include:

- **WHAT**: concrete implementation steps
- **WHY**: business or technical rationale
- **HOW**: specific files to create or modify (a \`### Files:\` section listing each path)
- **Acceptance criteria** as a checklist (\`- [ ] ...\`)`);
    sections.push(`## Template Library\n${formatBuiltInTemplateIds()}

Templates are optional shortcuts for common bead shapes, not requirements. If a template fits, include a machine-readable \`Template: <id>\` line near the top of the final bead description so \`flywheel_calibrate\` can aggregate per-template effort. If no template fits, omit the line.`);
    if (opts.provenance) {
        sections.push(`## Provenance\n${opts.provenance}`);
    }
    sections.push(opts.nextAction
        ? `## Next\n${opts.nextAction}`
        : `## Next\nAfter creating beads, call \`flywheel_approve_beads\` to review and approve the bead graph before implementation begins.`);
    return sections.join('\n\n');
}
const DEPENDS_ON_PATTERN = /--depends-on\b/;
export function containsForbiddenDependsOnFlag(text) {
    return DEPENDS_ON_PATTERN.test(text);
}
//# sourceMappingURL=bead-prompt.js.map