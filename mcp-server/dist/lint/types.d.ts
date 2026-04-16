export type Severity = "error" | "warn" | "info";
export interface Span {
    start: {
        line: number;
        column: number;
        offset?: number;
    };
    end: {
        line: number;
        column: number;
        offset?: number;
    };
}
export interface Finding {
    ruleId: string;
    severity: Severity;
    file: string;
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
    message: string;
    hint?: string;
    /** Set by baseline subtraction; do not produce findings with rulesetVersion explicit upstream. */
    rulesetVersion?: number;
}
export interface RuleContext {
    filePath: string;
    source: string;
}
export interface Rule {
    id: string;
    description: string;
    severity: Severity;
    check(doc: Document, ctx: RuleContext): Finding[] | Promise<Finding[]>;
}
/** Document tree placeholder — populated by parser in T2. */
export interface Document {
    source: string;
    filePath: string;
    /** Other fields added by T2; keep open-ended for now. */
    [key: string]: unknown;
}
export interface AuqOption {
    span: Span;
    label?: string;
    description?: string;
    isBareString: boolean;
}
export interface AuqQuestion {
    span: Span;
    question?: string;
    header?: string;
    options: AuqOption[];
    multiSelectExplicit: boolean;
    multiSelectValue?: boolean;
}
export interface AskUserQuestionCall {
    span: Span;
    questions: AuqQuestion[];
    parseError: boolean;
}
export interface SlashRef {
    span: Span;
    name: string;
    insideAuqPayload: boolean;
}
export interface PlaceholderTag {
    span: Span;
    name: string;
}
export interface DocumentHeader {
    span: Span;
    level: number;
    text: string;
}
export interface FenceInfo {
    span: Span;
    language: string;
    unclosed: boolean;
}
export interface ParsedDocument extends Document {
    fences: FenceInfo[];
    askUserQuestionCalls: AskUserQuestionCall[];
    slashReferences: SlashRef[];
    placeholders: PlaceholderTag[];
    headers: DocumentHeader[];
    parserFindings: Finding[];
}
export interface LintOptions {
    filePath: string;
    rules?: Rule[];
    /** When true, use only manifest + repo-local skills (skip ~/.claude/plugins). */
    ci?: boolean;
}
export interface LintResult {
    findings: Finding[];
    /** Internal errors (rules that threw or timed out). Aggregated separately from findings. */
    internalErrors: Array<{
        ruleId: string;
        message: string;
    }>;
}
export interface ReporterOptions {
    /** Force-disable colors even on TTY. */
    noColor?: boolean;
    /** Override which findings are visible (default: all severities). */
    minSeverity?: "error" | "warn" | "info";
}
//# sourceMappingURL=types.d.ts.map