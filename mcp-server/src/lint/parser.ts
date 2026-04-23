import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root, Code, Heading, RootContent } from "mdast";
import { FlywheelError } from "../errors.js";
import type {
  AskUserQuestionCall,
  AuqOption,
  AuqQuestion,
  DocumentHeader,
  FenceInfo,
  Finding,
  ParsedDocument,
  PlaceholderTag,
  SlashRef,
  Span,
} from "./types.js";

const HTML_TAG_ALLOWLIST = new Set([
  "br",
  "em",
  "strong",
  "code",
  "pre",
  "a",
  "img",
  "sup",
  "sub",
  "kbd",
  "summary",
  "details",
  "div",
  "span",
  "p",
  "ul",
  "ol",
  "li",
  "table",
  "tr",
  "td",
  "th",
  "thead",
  "tbody",
]);

const AUQ_ANCHOR_RE = /AskUserQuestion\s*\(/g;
const SLASH_RE = /(?<![A-Za-z0-9/.~])\/([a-z][a-z0-9-]*)\b/g;
const PLACEHOLDER_RE = /<([a-z][a-z0-9_-]*)>/gi;
const HTTP_METHOD_LINE_RE = /\b(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\//;
const URL_PREFIX_RE = /(?:https?:|file:)\/?$/i;

interface OffsetToLineCol {
  (offset: number): { line: number; column: number };
}

function buildOffsetMap(source: string): OffsetToLineCol {
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      lineStarts.push(i + 1);
    }
  }
  return (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo]! + 1 };
  };
}

function spanFromOffsets(start: number, end: number, toLC: OffsetToLineCol): Span {
  const s = toLC(start);
  const e = toLC(Math.max(end, start));
  return {
    start: { line: s.line, column: s.column, offset: start },
    end: { line: e.line, column: e.column, offset: end },
  };
}

function preprocess(source: string): { text: string; hadBom: boolean } {
  let text = source;
  let hadBom = false;
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
    hadBom = true;
  }
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return { text, hadBom };
}

interface ScanState {
  i: number;
  src: string;
}

function skipStringLiteral(state: ScanState, quote: string): boolean {
  const { src } = state;
  state.i++;
  while (state.i < src.length) {
    const ch = src[state.i]!;
    if (ch === "\\") {
      state.i += 2;
      continue;
    }
    if (ch === quote) {
      state.i++;
      return true;
    }
    if (quote !== "`" && ch === "\n") {
      return false;
    }
    state.i++;
  }
  return false;
}

function skipComment(state: ScanState): boolean {
  const { src } = state;
  if (src[state.i] !== "/") return false;
  if (src[state.i + 1] === "/") {
    state.i += 2;
    while (state.i < src.length && src[state.i] !== "\n") state.i++;
    return true;
  }
  if (src[state.i + 1] === "*") {
    state.i += 2;
    while (state.i < src.length - 1) {
      if (src[state.i] === "*" && src[state.i + 1] === "/") {
        state.i += 2;
        return true;
      }
      state.i++;
    }
    state.i = src.length;
    return true;
  }
  return false;
}

/** Find matching closing bracket for opener at openIdx (which points at the opener). */
function findMatchingClose(
  src: string,
  openIdx: number,
  open: string,
  close: string,
): number {
  const state: ScanState = { i: openIdx + 1, src };
  let depth = 1;
  while (state.i < src.length) {
    const ch = src[state.i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      if (!skipStringLiteral(state, ch)) return -1;
      continue;
    }
    if (ch === "/" && (src[state.i + 1] === "/" || src[state.i + 1] === "*")) {
      if (!skipComment(state)) return -1;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return state.i;
    }
    state.i++;
  }
  return -1;
}

interface Token {
  kind: "ident" | "string" | "punct" | "number" | "keyword" | "regex";
  value: string;
  start: number;
  end: number;
}

function tokenize(src: string, from: number, to: number): Token[] {
  const tokens: Token[] = [];
  const state: ScanState = { i: from, src };
  while (state.i < to) {
    const ch = src[state.i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      state.i++;
      continue;
    }
    if (ch === "/" && (src[state.i + 1] === "/" || src[state.i + 1] === "*")) {
      if (!skipComment(state)) break;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = state.i;
      if (!skipStringLiteral(state, ch)) break;
      tokens.push({ kind: "string", value: src.slice(start, state.i), start, end: state.i });
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = state.i;
      while (state.i < to && /[A-Za-z0-9_$]/.test(src[state.i]!)) state.i++;
      const value = src.slice(start, state.i);
      const kind: Token["kind"] =
        value === "true" || value === "false" || value === "null" || value === "undefined"
          ? "keyword"
          : "ident";
      tokens.push({ kind, value, start, end: state.i });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = state.i;
      while (state.i < to && /[0-9.]/.test(src[state.i]!)) state.i++;
      tokens.push({ kind: "number", value: src.slice(start, state.i), start, end: state.i });
      continue;
    }
    tokens.push({ kind: "punct", value: ch, start: state.i, end: state.i + 1 });
    state.i++;
  }
  return tokens;
}

function unquote(literal: string): string | undefined {
  if (literal.length < 2) return undefined;
  const first = literal[0];
  const last = literal[literal.length - 1];
  if (first !== last) return undefined;
  if (first !== '"' && first !== "'" && first !== "`") return undefined;
  const inner = literal.slice(1, -1);
  return inner.replace(/\\(.)/g, (_, c) => {
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      default:
        return c;
    }
  });
}

interface ObjectField {
  key: string;
  valueStart: number;
  valueEnd: number;
  valueTokens: Token[];
}

/** Parse an object literal whose opening { is at openIdx; returns fields between { and matching }. */
function parseObjectFields(src: string, openIdx: number): ObjectField[] | null {
  const closeIdx = findMatchingClose(src, openIdx, "{", "}");
  if (closeIdx === -1) return null;
  const tokens = tokenize(src, openIdx + 1, closeIdx);
  const fields: ObjectField[] = [];
  let i = 0;
  while (i < tokens.length) {
    const keyTok = tokens[i]!;
    let key: string | null = null;
    if (keyTok.kind === "ident" || keyTok.kind === "keyword") key = keyTok.value;
    else if (keyTok.kind === "string") key = unquote(keyTok.value) ?? null;
    if (key === null) {
      i++;
      continue;
    }
    if (i + 1 >= tokens.length || tokens[i + 1]!.value !== ":") {
      i++;
      continue;
    }
    const valueStartTokIdx = i + 2;
    if (valueStartTokIdx >= tokens.length) break;
    const valueTokens: Token[] = [];
    let depth = 0;
    let j = valueStartTokIdx;
    while (j < tokens.length) {
      const t = tokens[j]!;
      if (depth === 0 && t.value === ",") break;
      if (t.value === "{" || t.value === "[" || t.value === "(") depth++;
      else if (t.value === "}" || t.value === "]" || t.value === ")") depth--;
      valueTokens.push(t);
      j++;
    }
    if (valueTokens.length > 0) {
      fields.push({
        key,
        valueStart: valueTokens[0]!.start,
        valueEnd: valueTokens[valueTokens.length - 1]!.end,
        valueTokens,
      });
    }
    i = j + 1;
  }
  return fields;
}

/** Tokenize a range and parse key:value, key:value... fields (no enclosing braces). */
function parseInnerFields(src: string, from: number, to: number): ObjectField[] | null {
  const tokens = tokenize(src, from, to);
  const fields: ObjectField[] = [];
  let i = 0;
  while (i < tokens.length) {
    const keyTok = tokens[i]!;
    let key: string | null = null;
    if (keyTok.kind === "ident" || keyTok.kind === "keyword") key = keyTok.value;
    else if (keyTok.kind === "string") key = unquote(keyTok.value) ?? null;
    if (key === null) {
      i++;
      continue;
    }
    if (i + 1 >= tokens.length || tokens[i + 1]!.value !== ":") {
      i++;
      continue;
    }
    const valueStartTokIdx = i + 2;
    if (valueStartTokIdx >= tokens.length) break;
    const valueTokens: Token[] = [];
    let depth = 0;
    let j = valueStartTokIdx;
    while (j < tokens.length) {
      const t = tokens[j]!;
      if (depth === 0 && t.value === ",") break;
      if (t.value === "{" || t.value === "[" || t.value === "(") depth++;
      else if (t.value === "}" || t.value === "]" || t.value === ")") depth--;
      valueTokens.push(t);
      j++;
    }
    if (valueTokens.length > 0) {
      fields.push({
        key,
        valueStart: valueTokens[0]!.start,
        valueEnd: valueTokens[valueTokens.length - 1]!.end,
        valueTokens,
      });
    }
    i = j + 1;
  }
  return fields;
}

/** Find top-level array elements between [ and matching ]. Each element returned as start/end offsets. */
function splitArrayElements(
  src: string,
  openIdx: number,
): Array<{ start: number; end: number }> | null {
  const closeIdx = findMatchingClose(src, openIdx, "[", "]");
  if (closeIdx === -1) return null;
  const tokens = tokenize(src, openIdx + 1, closeIdx);
  const elems: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let elemStart = -1;
  let elemEnd = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (depth === 0 && t.value === ",") {
      if (elemStart !== -1) elems.push({ start: elemStart, end: elemEnd });
      elemStart = -1;
      elemEnd = -1;
      continue;
    }
    if (t.value === "{" || t.value === "[" || t.value === "(") depth++;
    else if (t.value === "}" || t.value === "]" || t.value === ")") depth--;
    if (elemStart === -1) elemStart = t.start;
    elemEnd = t.end;
  }
  if (elemStart !== -1) elems.push({ start: elemStart, end: elemEnd });
  return elems;
}

function firstNonWhitespace(src: string, from: number, to: number): number {
  let i = from;
  while (i < to && /\s/.test(src[i]!)) i++;
  return i;
}

function parseAuqQuestion(
  src: string,
  start: number,
  end: number,
  toLC: OffsetToLineCol,
): AuqQuestion | null {
  const objStart = firstNonWhitespace(src, start, end);
  if (src[objStart] !== "{") return null;
  const fields = parseObjectFields(src, objStart);
  if (!fields) return null;
  const closeIdx = findMatchingClose(src, objStart, "{", "}");
  const span = spanFromOffsets(objStart, closeIdx === -1 ? end : closeIdx + 1, toLC);
  const q: AuqQuestion = {
    span,
    options: [],
    multiSelectExplicit: false,
  };
  for (const field of fields) {
    if (field.key === "question") {
      const tok = field.valueTokens[0];
      if (tok && tok.kind === "string") {
        const v = unquote(tok.value);
        if (v !== undefined) q.question = v;
      }
    } else if (field.key === "header") {
      const tok = field.valueTokens[0];
      if (tok && tok.kind === "string") {
        const v = unquote(tok.value);
        if (v !== undefined) q.header = v;
      }
    } else if (field.key === "multiSelect") {
      const tok = field.valueTokens[0];
      if (tok && tok.kind === "keyword" && (tok.value === "true" || tok.value === "false")) {
        q.multiSelectExplicit = true;
        q.multiSelectValue = tok.value === "true";
      }
    } else if (field.key === "options") {
      const tok = field.valueTokens[0];
      if (tok && tok.value === "[") {
        const elems = splitArrayElements(src, tok.start);
        if (elems) {
          for (const elem of elems) {
            const opt = parseAuqOption(src, elem.start, elem.end, toLC);
            if (opt) q.options.push(opt);
          }
        }
      }
    }
  }
  return q;
}

function parseAuqOption(
  src: string,
  start: number,
  end: number,
  toLC: OffsetToLineCol,
): AuqOption | null {
  const head = firstNonWhitespace(src, start, end);
  const ch = src[head];
  if (ch === '"' || ch === "'" || ch === "`") {
    const subTokens = tokenize(src, head, end);
    const tok = subTokens[0];
    if (!tok || tok.kind !== "string") return null;
    const label = unquote(tok.value);
    return {
      span: spanFromOffsets(tok.start, tok.end, toLC),
      label,
      isBareString: true,
    };
  }
  if (ch !== "{") return null;
  const closeIdx = findMatchingClose(src, head, "{", "}");
  const fields = parseObjectFields(src, head);
  if (!fields) return null;
  const opt: AuqOption = {
    span: spanFromOffsets(head, closeIdx === -1 ? end : closeIdx + 1, toLC),
    isBareString: false,
  };
  for (const field of fields) {
    if (field.key === "label") {
      const tok = field.valueTokens[0];
      if (tok && tok.kind === "string") {
        const v = unquote(tok.value);
        if (v !== undefined) opt.label = v;
      }
    } else if (field.key === "description") {
      const tok = field.valueTokens[0];
      if (tok && tok.kind === "string") {
        const v = unquote(tok.value);
        if (v !== undefined) opt.description = v;
      }
    }
  }
  return opt;
}

function extractAuqCalls(src: string, toLC: OffsetToLineCol): AskUserQuestionCall[] {
  const calls: AskUserQuestionCall[] = [];
  AUQ_ANCHOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AUQ_ANCHOR_RE.exec(src)) !== null) {
    const anchorEnd = m.index + m[0].length;
    const parenIdx = anchorEnd - 1;
    const closeParen = findMatchingClose(src, parenIdx, "(", ")");
    if (closeParen === -1) {
      calls.push({
        span: spanFromOffsets(m.index, anchorEnd, toLC),
        questions: [],
        parseError: true,
      });
      continue;
    }
    const callSpan = spanFromOffsets(m.index, closeParen + 1, toLC);
    let parseError = false;
    const questions: AuqQuestion[] = [];
    try {
      const inner = src.slice(parenIdx + 1, closeParen);
      const innerStartAbs = parenIdx + 1;
      const objStart = firstNonWhitespace(inner, 0, inner.length);
      // Two supported forms:
      //   1) AskUserQuestion({ questions: [...] })  — outer object literal
      //   2) AskUserQuestion(questions: [...])      — labeled args (no outer braces)
      let fields: ObjectField[] | null = null;
      if (inner[objStart] === "{") {
        fields = parseObjectFields(src, innerStartAbs + objStart);
      } else {
        // Synthesize a virtual object by tokenizing the inner range directly.
        fields = parseInnerFields(src, innerStartAbs, parenIdx + 1 + inner.length);
      }
      if (!fields) {
        parseError = true;
      } else {
        const qField = fields.find((f) => f.key === "questions");
        if (qField) {
          const arrTok = qField.valueTokens[0];
          if (arrTok && arrTok.value === "[") {
            const elems = splitArrayElements(src, arrTok.start);
            if (elems === null) {
              parseError = true;
            } else {
              for (const elem of elems) {
                const q = parseAuqQuestion(src, elem.start, elem.end, toLC);
                if (q) questions.push(q);
                else parseError = true;
              }
            }
          }
        } else {
          parseError = true;
        }
      }
    } catch {
      parseError = true;
    }
    calls.push({ span: callSpan, questions, parseError });
  }
  return calls;
}

interface ProseRange {
  start: number;
  end: number;
}

function collectProseRanges(
  tree: Root,
  source: string,
  excludeHtml: boolean,
): ProseRange[] {
  const codeRanges: ProseRange[] = [];
  const visit = (node: RootContent | Root): void => {
    const isCode = node.type === "code" || node.type === "inlineCode";
    const isHtml = node.type === "html";
    if (isCode || (excludeHtml && isHtml)) {
      const pos = (node as { position?: { start?: { offset?: number }; end?: { offset?: number } } })
        .position;
      if (pos?.start?.offset !== undefined && pos?.end?.offset !== undefined) {
        codeRanges.push({ start: pos.start.offset, end: pos.end.offset });
      }
    }
    const children = (node as { children?: RootContent[] }).children;
    if (children) for (const c of children) visit(c);
  };
  visit(tree);
  codeRanges.sort((a, b) => a.start - b.start);
  const prose: ProseRange[] = [];
  let cursor = 0;
  for (const r of codeRanges) {
    if (cursor < r.start) prose.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < source.length) prose.push({ start: cursor, end: source.length });
  return prose;
}

function isInsideRange(offset: number, ranges: ProseRange[]): boolean {
  for (const r of ranges) {
    if (offset >= r.start && offset < r.end) return true;
  }
  return false;
}

function extractSlashRefs(
  src: string,
  proseRanges: ProseRange[],
  auqCalls: AskUserQuestionCall[],
  toLC: OffsetToLineCol,
): SlashRef[] {
  const refs: SlashRef[] = [];
  const seen = new Set<number>();

  const scan = (text: string, baseOffset: number, insideAuq: boolean): void => {
    SLASH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SLASH_RE.exec(text)) !== null) {
      const matchOffset = baseOffset + m.index;
      if (seen.has(matchOffset)) continue;
      const name = m[1]!;
      const before = text.slice(Math.max(0, m.index - 6), m.index);
      if (URL_PREFIX_RE.test(before)) continue;
      const lineStart = text.lastIndexOf("\n", m.index - 1) + 1;
      const lineEnd = text.indexOf("\n", m.index);
      const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
      if (HTTP_METHOD_LINE_RE.test(line)) continue;
      const afterIdx = m.index + m[0].length;
      if (text[afterIdx] === "/") continue;
      seen.add(matchOffset);
      refs.push({
        span: spanFromOffsets(matchOffset, matchOffset + m[0].length, toLC),
        name,
        insideAuqPayload: insideAuq,
      });
    }
  };

  for (const r of proseRanges) {
    scan(src.slice(r.start, r.end), r.start, false);
  }
  for (const call of auqCalls) {
    for (const q of call.questions) {
      for (const opt of q.options) {
        if (opt.description !== undefined) {
          const startOff = opt.span.start.offset ?? 0;
          const endOff = opt.span.end.offset ?? startOff;
          const slice = src.slice(startOff, endOff);
          scan(slice, startOff, true);
        }
      }
    }
  }
  return refs;
}

function extractPlaceholders(
  src: string,
  proseRanges: ProseRange[],
  toLC: OffsetToLineCol,
): PlaceholderTag[] {
  const placeholders: PlaceholderTag[] = [];
  for (const r of proseRanges) {
    const text = src.slice(r.start, r.end);
    PLACEHOLDER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
      const name = m[1]!.toLowerCase();
      if (HTML_TAG_ALLOWLIST.has(name)) continue;
      const off = r.start + m.index;
      placeholders.push({
        span: spanFromOffsets(off, off + m[0].length, toLC),
        name,
      });
    }
  }
  return placeholders;
}

function extractFences(tree: Root, source: string, toLC: OffsetToLineCol): {
  fences: FenceInfo[];
  parserFindings: Finding[];
  filePath: string;
} {
  const fences: FenceInfo[] = [];
  const parserFindings: Finding[] = [];
  const visit = (node: RootContent | Root): void => {
    if (node.type === "code") {
      const code = node as Code;
      const pos = code.position;
      if (pos?.start?.offset !== undefined && pos?.end?.offset !== undefined) {
        const text = source.slice(pos.start.offset, pos.end.offset);
        const openMatch = text.match(/^(`{3,}|~{3,})/);
        let unclosed = false;
        if (openMatch) {
          const fenceChar = openMatch[1]![0];
          const openLen = openMatch[1]!.length;
          const closeRe = new RegExp(
            `\\n[ ]{0,3}${fenceChar === "`" ? "`" : "~"}{${openLen},}\\s*$`,
            "m",
          );
          if (!closeRe.test(text)) {
            unclosed = true;
          }
        }
        const span = spanFromOffsets(pos.start.offset, pos.end.offset, toLC);
        fences.push({
          span,
          language: code.lang ?? "",
          unclosed,
        });
        if (unclosed) {
          parserFindings.push({
            ruleId: "SKILL-010",
            severity: "error",
            file: "",
            line: span.start.line,
            column: span.start.column,
            endLine: span.end.line,
            endColumn: span.end.column,
            message: `Unclosed code fence opened at line ${span.start.line}`,
          });
        }
      }
    }
    const children = (node as { children?: RootContent[] }).children;
    if (children) for (const c of children) visit(c);
  };
  visit(tree);
  return { fences, parserFindings, filePath: "" };
}

function extractHeaders(tree: Root, source: string, toLC: OffsetToLineCol): DocumentHeader[] {
  const headers: DocumentHeader[] = [];
  const visit = (node: RootContent | Root): void => {
    if (node.type === "heading") {
      const h = node as Heading;
      const pos = h.position;
      if (pos?.start?.offset !== undefined && pos?.end?.offset !== undefined) {
        const text = source
          .slice(pos.start.offset, pos.end.offset)
          .replace(/^#+\s*/, "")
          .replace(/\s*#*\s*$/, "")
          .trim();
        headers.push({
          span: spanFromOffsets(pos.start.offset, pos.end.offset, toLC),
          level: h.depth,
          text,
        });
      }
    }
    const children = (node as { children?: RootContent[] }).children;
    if (children) for (const c of children) visit(c);
  };
  visit(tree);
  return headers;
}

/**
 * Detect a SKILL.md that opens with a YAML frontmatter fence (`---` on line 1)
 * but never closes it. A permissive parser silently treats the whole file as
 * body, installing a skill with empty metadata (no name, no tools) — see CE
 * phase4 blunder #4 (frontmatter.ts:22-25). We refuse to load such files and
 * return a targeted hint so a contributor can repair the fence in one step.
 *
 * Scope: only the line-1 opener case. A `---` appearing mid-body (thematic
 * break) is NOT a frontmatter opener and is left untouched.
 */
function assertFrontmatterFenceClosed(text: string, filePath: string): void {
  // Require `---` on line 1 exactly (trailing whitespace tolerated).
  const firstNewline = text.indexOf("\n");
  const firstLine = firstNewline === -1 ? text : text.slice(0, firstNewline);
  if (firstLine.trimEnd() !== "---") return;
  // Look for a closing `---` line anywhere after line 1. A closing fence must
  // be on its own line (trailing whitespace tolerated, no other content).
  const rest = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
  const closeRe = /(^|\n)---[ \t]*(\n|$)/;
  if (closeRe.test(rest)) return;
  throw new FlywheelError({
    code: "parse_failure",
    message: `SKILL.md frontmatter fence opened at line 1 but never closed (${filePath}).`,
    hint: "frontmatter started at line 1 but never closed — add ---",
    details: { filePath },
  });
}

export async function parse(source: string, filePath: string): Promise<ParsedDocument> {
  const { text } = preprocess(source);
  assertFrontmatterFenceClosed(text, filePath);
  const toLC = buildOffsetMap(text);

  const processor = unified().use(remarkParse);
  let tree: Root;
  try {
    tree = processor.parse(text) as Root;
  } catch {
    tree = { type: "root", children: [] };
  }

  const { fences, parserFindings } = extractFences(tree, text, toLC);
  for (const f of parserFindings) f.file = filePath;
  const headers = extractHeaders(tree, text, toLC);
  const askUserQuestionCalls = extractAuqCalls(text, toLC);
  const proseRangesForSlash = collectProseRanges(tree, text, true);
  const proseRangesForPlaceholder = collectProseRanges(tree, text, false);
  const slashReferences = extractSlashRefs(text, proseRangesForSlash, askUserQuestionCalls, toLC);
  const placeholders = extractPlaceholders(text, proseRangesForPlaceholder, toLC);

  return {
    source: text,
    filePath,
    fences,
    askUserQuestionCalls,
    slashReferences,
    placeholders,
    headers,
    parserFindings,
  };
}
