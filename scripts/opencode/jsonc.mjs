/**
 * Zero-dependency, pinned JSONC document editor for the OpenCode config merge.
 *
 * The OpenCode config (`opencode.json` / `opencode.jsonc`) is a user-owned file
 * that carries comments, trailing commas, key order, and — critically — provider
 * secrets. A naive `JSON.parse` + `JSON.stringify` round-trip would silently
 * strip all of that. This module instead parses the document into a positional
 * AST and splices *only* the `mcp.<configKey>` value, leaving every other byte
 * untouched.
 *
 * There is no runtime registry fetch and no external dependency: the parser is
 * hand-rolled here so the capability is always available at write time. Callers
 * that reach an unavailable editing path must fail before writing rather than
 * fall back to a whole-document rewrite.
 *
 * Error messages are intentionally position-only (byte offset + generic reason)
 * and never echo document content, so a parse failure cannot leak a secret.
 */

/** Structural error raised by the parser. Position-only, never content. */
export class JsoncError extends Error {
  constructor(message, position) {
    super(message);
    this.name = "JsoncError";
    this.position = position;
  }
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v", " ", "﻿"]);

function makeScanner(text, label) {
  let i = 0;
  const n = text.length;

  const fail = (reason, at = i) => {
    throw new JsoncError(`${label}: JSONC syntax error at position ${at}: ${reason}`, at);
  };

  const skipTrivia = () => {
    while (i < n) {
      const c = text[i];
      if (WHITESPACE.has(c)) {
        i += 1;
        continue;
      }
      if (c === "/" && text[i + 1] === "/") {
        i += 2;
        while (i < n && text[i] !== "\n" && text[i] !== "\r") i += 1;
        continue;
      }
      if (c === "/" && text[i + 1] === "*") {
        i += 2;
        while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
        if (i >= n) fail("unterminated block comment");
        i += 2;
        continue;
      }
      break;
    }
  };

  const parseString = () => {
    // Caller guarantees text[i] === '"'.
    i += 1;
    let out = "";
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        i += 1;
        return out;
      }
      if (c === "\\") {
        const e = text[i + 1];
        switch (e) {
          case '"':
            out += '"';
            i += 2;
            break;
          case "\\":
            out += "\\";
            i += 2;
            break;
          case "/":
            out += "/";
            i += 2;
            break;
          case "b":
            out += "\b";
            i += 2;
            break;
          case "f":
            out += "\f";
            i += 2;
            break;
          case "n":
            out += "\n";
            i += 2;
            break;
          case "r":
            out += "\r";
            i += 2;
            break;
          case "t":
            out += "\t";
            i += 2;
            break;
          case "u": {
            const hex = text.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid \\u escape in string");
            out += String.fromCharCode(Number.parseInt(hex, 16));
            i += 6;
            break;
          }
          default:
            fail("invalid escape sequence in string");
        }
        continue;
      }
      if (c === "\n" || c === "\r") fail("unterminated string");
      out += c;
      i += 1;
    }
    return fail("unterminated string");
  };

  const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const parseNumber = (start) => {
    NUMBER_RE.lastIndex = i;
    const match = NUMBER_RE.exec(text);
    if (!match || match.index !== i) return fail("invalid number");
    i += match[0].length;
    return { type: "number", start, end: i, value: Number(match[0]) };
  };

  const parseObject = (start) => {
    i += 1; // consume '{'
    const members = [];
    while (true) {
      skipTrivia();
      if (i >= n) fail("unterminated object");
      if (text[i] === "}") {
        i += 1;
        break;
      }
      if (text[i] !== '"') fail("expected string key in object");
      const keyStart = i;
      const key = parseString();
      const keyEnd = i;
      skipTrivia();
      if (text[i] !== ":") fail("expected ':' after object key");
      i += 1; // consume ':'
      const value = parseValue();
      members.push({ key, keyStart, keyEnd, valueStart: value.start, valueEnd: value.end, value });
      skipTrivia();
      if (text[i] === ",") {
        i += 1;
        continue; // trailing comma tolerated: loop re-checks for '}'
      }
      if (text[i] === "}") {
        i += 1;
        break;
      }
      fail("expected ',' or '}' in object");
    }
    return { type: "object", start, end: i, members };
  };

  const parseArray = (start) => {
    i += 1; // consume '['
    const elements = [];
    while (true) {
      skipTrivia();
      if (i >= n) fail("unterminated array");
      if (text[i] === "]") {
        i += 1;
        break;
      }
      const value = parseValue();
      elements.push(value);
      skipTrivia();
      if (text[i] === ",") {
        i += 1;
        continue; // trailing comma tolerated
      }
      if (text[i] === "]") {
        i += 1;
        break;
      }
      fail("expected ',' or ']' in array");
    }
    return { type: "array", start, end: i, elements };
  };

  function parseValue() {
    skipTrivia();
    const start = i;
    if (i >= n) return fail("unexpected end of input, expected a value");
    const c = text[i];
    if (c === "{") return parseObject(start);
    if (c === "[") return parseArray(start);
    if (c === '"') {
      const value = parseString();
      return { type: "string", start, end: i, value };
    }
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber(start);
    if (text.startsWith("true", i)) {
      i += 4;
      return { type: "literal", start, end: i, value: true };
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return { type: "literal", start, end: i, value: false };
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return { type: "literal", start, end: i, value: null };
    }
    return fail("unexpected token, expected a value");
  }

  const parseDocument = () => {
    const node = parseValue();
    skipTrivia();
    if (i < n) fail("unexpected trailing content after top-level value");
    return node;
  };

  return { parseDocument };
}

/** Convert a positional AST node into a plain JavaScript value. */
function nodeToValue(node) {
  switch (node.type) {
    case "object": {
      const obj = {};
      for (const member of node.members) obj[member.key] = nodeToValue(member.value);
      return obj;
    }
    case "array":
      return node.elements.map(nodeToValue);
    default:
      return node.value;
  }
}

/**
 * Parse JSONC text (comments + trailing commas tolerated) into a plain value.
 * Throws {@link JsoncError} with a position-only message on malformed input.
 */
export function parseJsonc(text, options = {}) {
  if (typeof text !== "string") throw new TypeError("parseJsonc: text must be a string");
  const label = options.path ?? "<config>";
  const node = makeScanner(text, label).parseDocument();
  return nodeToValue(node);
}

/** Leading whitespace (spaces/tabs) of the line containing `pos`. */
function lineIndent(text, pos) {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  let j = lineStart;
  while (j < text.length && (text[j] === " " || text[j] === "\t")) j += 1;
  return text.slice(lineStart, j);
}

/** Best-effort detection of the document's indent unit (defaults to two spaces). */
function detectIndentUnit(text, root) {
  if (root.type === "object" && root.members.length > 0) {
    const indent = lineIndent(text, root.members[0].keyStart);
    if (indent.length > 0) return indent;
  }
  if (root.type === "array" && root.elements.length > 0) {
    const indent = lineIndent(text, root.elements[0].start);
    if (indent.length > 0) return indent;
  }
  return "  ";
}

/** Re-indent a JSON.stringify block so lines after the first sit at `baseIndent`. */
function reindent(serialized, baseIndent) {
  if (baseIndent.length === 0) return serialized;
  const lines = serialized.split("\n");
  return lines.map((line, index) => (index === 0 ? line : baseIndent + line)).join("\n");
}

function splice(text, start, end, replacement) {
  return text.slice(0, start) + replacement + text.slice(end);
}

function serializeValue(value, indentUnit, baseIndent) {
  return reindent(JSON.stringify(value, null, indentUnit), baseIndent);
}

/** Insert a `"key": value` member into an object node, preserving formatting. */
function insertMember(text, objNode, key, value, indentUnit) {
  const keyLiteral = JSON.stringify(key);
  if (objNode.members.length > 0) {
    const last = objNode.members[objNode.members.length - 1];
    const memberIndent = lineIndent(text, objNode.members[0].keyStart);
    const valueText = serializeValue(value, indentUnit, memberIndent);
    // Inserting immediately after the last value works whether or not a trailing
    // comma already follows: the original comma (if any) simply trails our member.
    const insertion = `,\n${memberIndent}${keyLiteral}: ${valueText}`;
    return splice(text, last.valueEnd, last.valueEnd, insertion);
  }
  // Empty object `{}` (possibly with interior comments): insert before the '}'.
  const baseIndent = lineIndent(text, objNode.start);
  const memberIndent = baseIndent + indentUnit;
  const valueText = serializeValue(value, indentUnit, memberIndent);
  const closeBrace = objNode.end - 1;
  const insertion = `\n${memberIndent}${keyLiteral}: ${valueText}\n${baseIndent}`;
  return splice(text, closeBrace, closeBrace, insertion);
}

/**
 * Set `mcp.<configKey>` to `entry` inside a JSONC document, changing only that
 * subtree and preserving every other byte (comments, trailing commas, key order,
 * unrelated keys, and formatting). Returns the edited document text.
 *
 * Throws {@link JsoncError} when the document does not parse, and a plain Error
 * when the root or the `mcp` node is not an object (a merge that could corrupt
 * user structure is refused rather than forced).
 */
export function setMcpFlywheelEntry(text, configKey, entry, options = {}) {
  if (typeof text !== "string") throw new TypeError("setMcpFlywheelEntry: text must be a string");
  if (typeof configKey !== "string" || configKey.length === 0) {
    throw new TypeError("setMcpFlywheelEntry: configKey must be a non-empty string");
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError("setMcpFlywheelEntry: entry must be an object");
  }
  const label = options.path ?? "<config>";
  const root = makeScanner(text, label).parseDocument();
  if (root.type !== "object") {
    throw new Error(`${label}: config root must be a JSON object`);
  }
  const indentUnit = detectIndentUnit(text, root);
  const mcpMember = root.members.find((member) => member.key === "mcp");

  if (!mcpMember) {
    // No `mcp` key: insert a fresh `"mcp": { "<configKey>": entry }` member.
    return insertMember(text, root, "mcp", { [configKey]: entry }, indentUnit);
  }
  if (mcpMember.value.type !== "object") {
    throw new Error(`${label}: config "mcp" must be a JSON object`);
  }
  const mcpNode = mcpMember.value;
  const target = mcpNode.members.find((member) => member.key === configKey);
  if (target) {
    // Replace only the value span of the existing entry.
    const baseIndent = lineIndent(text, target.keyStart);
    const replacement = serializeValue(entry, indentUnit, baseIndent);
    return splice(text, target.valueStart, target.valueEnd, replacement);
  }
  // `mcp` exists but has no `<configKey>`: insert alongside the other servers.
  return insertMember(text, mcpNode, configKey, entry, indentUnit);
}
