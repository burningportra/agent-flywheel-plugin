import type {
  Document,
  DocumentHeader,
  Finding,
  ParsedDocument,
  Rule,
  RuleContext,
} from "../types.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findReferent(name: string, stepBody: string): boolean {
  const escaped = escapeRegExp(name);
  return (
    new RegExp(`\\*\\*${escaped}\\*\\*`, "i").test(stepBody) ||
    new RegExp(`(^|\\n)\\s*[-*]\\s+\\*\\*${escaped}\\*\\*\\s*:`, "i").test(stepBody) ||
    new RegExp(`\\b${escaped}\\s*[=:]`, "i").test(stepBody)
  );
}

function enclosingHeader(line: number, headers: DocumentHeader[]): DocumentHeader | undefined {
  let best: DocumentHeader | undefined;
  for (const h of headers) {
    if (h.span.start.line <= line && (!best || h.span.start.line > best.span.start.line)) {
      best = h;
    }
  }
  return best;
}

function stepBodyText(source: string, header: DocumentHeader, headers: DocumentHeader[]): string {
  const startOffset = header.span.end.offset ?? 0;
  const next = headers.find(
    (h) => h.span.start.line > header.span.start.line && h.level <= header.level,
  );
  const endOffset = next?.span.start.offset ?? source.length;
  return source.slice(startOffset, endOffset);
}

export const place001: Rule = {
  id: "PLACE001",
  description:
    "Placeholder tags (e.g. <USER_INPUT>) must be defined or referenced in the enclosing step.",
  severity: "warn",
  check(doc: Document, ctx: RuleContext): Finding[] {
    const findings: Finding[] = [];
    const parsed = doc as ParsedDocument;
    const source = parsed.source;
    const headers = parsed.headers ?? [];
    for (const ph of parsed.placeholders ?? []) {
      const header = enclosingHeader(ph.span.start.line, headers);
      if (!header) {
        findings.push({
          ruleId: "PLACE001",
          severity: "warn",
          file: ctx.filePath,
          line: ph.span.start.line,
          column: ph.span.start.column,
          message: `Placeholder <${ph.name}> appears outside any step (no preceding ## header).`,
          hint: `Either add a step header above this content or replace the placeholder with a literal value.`,
        });
        continue;
      }
      const body = stepBodyText(source, header, headers);
      if (findReferent(ph.name, body)) continue;
      findings.push({
        ruleId: "PLACE001",
        severity: "warn",
        file: ctx.filePath,
        line: ph.span.start.line,
        column: ph.span.start.column,
        message: `Placeholder <${ph.name}> at line ${ph.span.start.line} has no referent in enclosing step "${header.text}".`,
        hint: `Either replace it with a literal value or add a definition like "- **${ph.name}**: <description>" within the step body.`,
      });
    }
    return findings;
  },
};
