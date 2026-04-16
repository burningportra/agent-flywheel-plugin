import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../lint/parser.js";
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
function readFixture(name) {
    return readFileSync(join(FIXTURES, name), "utf8");
}
describe("parser", () => {
    it("empty source produces empty arrays and no findings", async () => {
        const doc = await parse("", "empty.md");
        expect(doc.fences).toEqual([]);
        expect(doc.askUserQuestionCalls).toEqual([]);
        expect(doc.slashReferences).toEqual([]);
        expect(doc.placeholders).toEqual([]);
        expect(doc.headers).toEqual([]);
        expect(doc.parserFindings).toEqual([]);
        expect(doc.source).toBe("");
        expect(doc.filePath).toBe("empty.md");
    });
    it("extracts well-formed AUQ with header, options, multiSelect", async () => {
        const src = `Some prose.

\`\`\`js
AskUserQuestion({
  questions: [
    {
      question: "Pick one",
      header: "Choice",
      multiSelect: false,
      options: [
        { label: "A", description: "first" },
        { label: "B", description: "second" },
        { label: "C", description: "third" }
      ]
    }
  ]
});
\`\`\`
`;
        const doc = await parse(src, "f.md");
        expect(doc.askUserQuestionCalls).toHaveLength(1);
        const call = doc.askUserQuestionCalls[0];
        expect(call.parseError).toBe(false);
        expect(call.questions).toHaveLength(1);
        const q = call.questions[0];
        expect(q.question).toBe("Pick one");
        expect(q.header).toBe("Choice");
        expect(q.multiSelectExplicit).toBe(true);
        expect(q.multiSelectValue).toBe(false);
        expect(q.options).toHaveLength(3);
        expect(q.options[0].label).toBe("A");
        expect(q.options[0].description).toBe("first");
        expect(q.options[0].isBareString).toBe(false);
    });
    it("detects bare-string options", async () => {
        const src = `\`\`\`js
AskUserQuestion({
  questions: [
    {
      header: "h",
      options: ["foo", "bar"]
    }
  ]
});
\`\`\`
`;
        const doc = await parse(src, "f.md");
        const opts = doc.askUserQuestionCalls[0].questions[0].options;
        expect(opts).toHaveLength(2);
        expect(opts[0].isBareString).toBe(true);
        expect(opts[0].label).toBe("foo");
        expect(opts[1].label).toBe("bar");
    });
    it("malformed AUQ (mismatched braces) yields parseError without throwing", async () => {
        const src = `\`\`\`js
AskUserQuestion({
  questions: [
    { header: "h", options: [ { label: "a"
\`\`\`
trailing text
`;
        const doc = await parse(src, "f.md");
        expect(doc.askUserQuestionCalls).toHaveLength(1);
        expect(doc.askUserQuestionCalls[0].parseError).toBe(true);
    });
    it("multi-question AUQ extracts each question", async () => {
        const src = `\`\`\`js
AskUserQuestion({
  questions: [
    { header: "h1", question: "q1", options: [{label:"a"}] },
    { header: "h2", question: "q2", options: [{label:"b"}] }
  ]
});
\`\`\`
`;
        const doc = await parse(src, "f.md");
        const qs = doc.askUserQuestionCalls[0].questions;
        expect(qs).toHaveLength(2);
        expect(qs[0].header).toBe("h1");
        expect(qs[1].header).toBe("h2");
    });
    it("slash refs: prose extracted, URLs/paths/HTTP methods excluded", async () => {
        const src = `Use the /idea-wizard skill.

See https://example.com/path for docs.

The path /usr/local/bin/foo is excluded (multi-slash).

GET /api/v1/users is REST.

Run /commit-now to commit.
`;
        const doc = await parse(src, "f.md");
        const names = doc.slashReferences.map((r) => r.name).sort();
        expect(names).toContain("idea-wizard");
        expect(names).toContain("commit-now");
        expect(names).not.toContain("path");
        expect(names).not.toContain("usr");
        expect(names).not.toContain("api");
    });
    it("slash refs inside AUQ option description are flagged with insideAuqPayload", async () => {
        const src = `\`\`\`js
AskUserQuestion({
  questions: [
    {
      header: "h",
      options: [
        { label: "Yes", description: "Run /idea-wizard now" }
      ]
    }
  ]
});
\`\`\`
`;
        const doc = await parse(src, "f.md");
        const inAuq = doc.slashReferences.filter((r) => r.insideAuqPayload);
        expect(inAuq.length).toBeGreaterThan(0);
        expect(inAuq.some((r) => r.name === "idea-wizard")).toBe(true);
    });
    it("placeholders: HTML tags skipped, custom tags extracted", async () => {
        const src = `Some prose.

A line break <br> here.

A custom <USER_INPUT> placeholder.

Inline <strong>bold</strong>.

Custom <my-tag> too.
`;
        const doc = await parse(src, "f.md");
        const names = doc.placeholders.map((p) => p.name).sort();
        expect(names).toContain("user_input");
        expect(names).toContain("my-tag");
        expect(names).not.toContain("br");
        expect(names).not.toContain("strong");
    });
    it("fences: triple-backtick and quad-backtick captured with language", async () => {
        const src = `\`\`\`js
const x = 1;
\`\`\`

\`\`\`\`md
\`\`\`js
nested
\`\`\`
\`\`\`\`
`;
        const doc = await parse(src, "f.md");
        expect(doc.fences.length).toBeGreaterThanOrEqual(2);
        expect(doc.fences.some((f) => f.language === "js")).toBe(true);
        expect(doc.fences.some((f) => f.language === "md")).toBe(true);
    });
    it("nested-fence-with-comment-terminator fixture parses without crash", async () => {
        const src = readFixture("nested-fence-with-comment-terminator.md");
        const doc = await parse(src, "nested.md");
        expect(doc.fences.length).toBeGreaterThan(0);
        expect(doc.parserFindings.filter((f) => f.ruleId === "SKILL-010")).toHaveLength(0);
    });
    it("unclosed fence emits SKILL-010", async () => {
        const src = readFixture("unclosed-fence.md");
        const doc = await parse(src, "unclosed.md");
        const findings = doc.parserFindings.filter((f) => f.ruleId === "SKILL-010");
        expect(findings).toHaveLength(1);
        expect(findings[0].severity).toBe("error");
        expect(findings[0].file).toBe("unclosed.md");
    });
    it("CRLF input produces same findings as LF", async () => {
        const lf = readFixture("crlf.md");
        const crlf = lf.replace(/\n/g, "\r\n");
        const docLf = await parse(lf, "lf.md");
        const docCrlf = await parse(crlf, "crlf.md");
        expect(docLf.headers.length).toBe(docCrlf.headers.length);
        expect(docLf.fences.length).toBe(docCrlf.fences.length);
        expect(docLf.headers[0].span.start.line).toBe(docCrlf.headers[0].span.start.line);
    });
    it("UTF-8 BOM is stripped before parsing", async () => {
        const base = readFixture("utf8-bom.md");
        const withBom = "\ufeff" + base;
        const docBase = await parse(base, "a.md");
        const docBom = await parse(withBom, "b.md");
        expect(docBom.headers).toHaveLength(docBase.headers.length);
        expect(docBom.headers[0].span.start.line).toBe(docBase.headers[0].span.start.line);
        expect(docBom.source.charCodeAt(0)).not.toBe(0xfeff);
    });
    it("headers extracted with level and text", async () => {
        const src = `# H1

## H2 ##

### H3
`;
        const doc = await parse(src, "f.md");
        expect(doc.headers).toHaveLength(3);
        expect(doc.headers[0].level).toBe(1);
        expect(doc.headers[0].text).toBe("H1");
        expect(doc.headers[1].level).toBe(2);
        expect(doc.headers[1].text).toBe("H2");
        expect(doc.headers[2].level).toBe(3);
    });
    it("AUQ inside fenced block is still extracted (raw scan)", async () => {
        const src = `\`\`\`
AskUserQuestion({ questions: [{ header: "x", options: [{label:"y"}] }] });
\`\`\`
`;
        const doc = await parse(src, "f.md");
        expect(doc.askUserQuestionCalls).toHaveLength(1);
        expect(doc.askUserQuestionCalls[0].parseError).toBe(false);
    });
    it("string literals with escaped quotes do not break brace matching", async () => {
        const src = `\`\`\`js
AskUserQuestion({
  questions: [
    { header: "with \\"quotes\\" and { brace", options: [{label:"a"}] }
  ]
});
\`\`\`
`;
        const doc = await parse(src, "f.md");
        expect(doc.askUserQuestionCalls[0].parseError).toBe(false);
        expect(doc.askUserQuestionCalls[0].questions[0].header).toContain("quotes");
    });
    it("AUQ with unclosed paren falls back to parseError", async () => {
        const src = `AskUserQuestion({ questions: [`;
        const doc = await parse(src, "f.md");
        expect(doc.askUserQuestionCalls[0].parseError).toBe(true);
    });
    it("AUQ with line comments and block comments inside payload parses", async () => {
        const src = `\`\`\`js
AskUserQuestion({
  // a line comment
  questions: [
    /* block
       comment */
    { header: "h", multiSelect: true, options: [{label:"a"}] }
  ]
});
\`\`\`
`;
        const doc = await parse(src, "f.md");
        expect(doc.askUserQuestionCalls[0].parseError).toBe(false);
        const q = doc.askUserQuestionCalls[0].questions[0];
        expect(q.multiSelectExplicit).toBe(true);
        expect(q.multiSelectValue).toBe(true);
    });
    it("AUQ payload that is not an object yields parseError", async () => {
        const src = `\`\`\`js
AskUserQuestion("not-an-object");
\`\`\`
`;
        const doc = await parse(src, "f.md");
        expect(doc.askUserQuestionCalls[0].parseError).toBe(true);
    });
    it("AUQ with no questions field flags parseError", async () => {
        const src = `\`\`\`js
AskUserQuestion({ other: "thing" });
\`\`\`
`;
        const doc = await parse(src, "f.md");
        expect(doc.askUserQuestionCalls[0].parseError).toBe(true);
        expect(doc.askUserQuestionCalls[0].questions).toEqual([]);
    });
    it("AUQ labeled-args form (no outer braces) is supported", async () => {
        const src = `\`\`\`js
AskUserQuestion(questions: [
  { header: "h", question: "q", options: [{label:"a"}] }
]);
\`\`\`
`;
        const doc = await parse(src, "f.md");
        expect(doc.askUserQuestionCalls[0].parseError).toBe(false);
        expect(doc.askUserQuestionCalls[0].questions).toHaveLength(1);
        expect(doc.askUserQuestionCalls[0].questions[0].header).toBe("h");
    });
    it("string-keyed object literal fields are extracted (key as string literal)", async () => {
        const src = `\`\`\`js
AskUserQuestion({
  "questions": [
    { "header": "h", "options": [{"label":"a"}] }
  ]
});
\`\`\`
`;
        const doc = await parse(src, "f.md");
        expect(doc.askUserQuestionCalls[0].parseError).toBe(false);
        expect(doc.askUserQuestionCalls[0].questions[0].header).toBe("h");
    });
    it("escape sequences (\\n, \\t) in string literals decode", async () => {
        const src = `\`\`\`js
AskUserQuestion({
  questions: [
    { header: "line1\\nline2\\tend", options: [{label:"a"}] }
  ]
});
\`\`\`
`;
        const doc = await parse(src, "f.md");
        const h = doc.askUserQuestionCalls[0].questions[0].header;
        expect(h).toContain("\n");
        expect(h).toContain("\t");
    });
    it("invalid option (non-string non-object) is skipped", async () => {
        const src = `\`\`\`js
AskUserQuestion({
  questions: [
    { header: "h", options: [42, {label:"ok"}] }
  ]
});
\`\`\`
`;
        const doc = await parse(src, "f.md");
        const opts = doc.askUserQuestionCalls[0].questions[0].options;
        expect(opts.length).toBe(1);
        expect(opts[0].label).toBe("ok");
    });
    it("URL prefix exclusion: file: and http: skip slash refs", async () => {
        const src = `Visit file:/local/path or http:/host/path.

A bare /good ref.
`;
        const doc = await parse(src, "f.md");
        const names = doc.slashReferences.map((r) => r.name);
        expect(names).toContain("good");
    });
    it("HTML comment-style placeholders are not extracted from inline code", async () => {
        const src = `Use \`<placeholder-x>\` inside code.

But <placeholder-y> in prose works.
`;
        const doc = await parse(src, "f.md");
        const names = doc.placeholders.map((p) => p.name);
        expect(names).toContain("placeholder-y");
        expect(names).not.toContain("placeholder-x");
    });
    it("indented (tilde) fences are also captured", async () => {
        const src = `~~~python
print("hi")
~~~
`;
        const doc = await parse(src, "f.md");
        expect(doc.fences.length).toBeGreaterThanOrEqual(1);
        expect(doc.fences[0].unclosed).toBe(false);
    });
});
//# sourceMappingURL=parser.test.js.map