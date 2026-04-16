export const slash001 = {
    id: "SLASH001",
    description: "Slash references (e.g. /idea-wizard) must resolve to an installed skill.",
    severity: "warn",
    check(doc, ctx) {
        const findings = [];
        const registry = ctx.registry;
        if (!registry)
            return findings;
        const parsed = doc;
        for (const ref of parsed.slashReferences ?? []) {
            if (registry.has(ref.name))
                continue;
            const suggestions = registry.suggest(ref.name, 3);
            const hint = suggestions.length > 0
                ? `Did you mean ${suggestions.map((s) => "/" + s).join(", ")}?`
                : `Add "${ref.name}" to mcp-server/.lintskill-allowlist.json knownExternalSlashes if it's an external CLI built-in.`;
            findings.push({
                ruleId: "SLASH001",
                severity: "warn",
                file: ctx.filePath,
                line: ref.span.start.line,
                column: ref.span.start.column,
                endLine: ref.span.end.line,
                endColumn: ref.span.end.column,
                message: `Slash reference "/${ref.name}" does not resolve to any installed skill.`,
                hint,
            });
        }
        return findings;
    },
};
export default slash001;
//# sourceMappingURL=slashReferences.js.map