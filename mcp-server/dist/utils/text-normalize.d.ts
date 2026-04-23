/**
 * text-normalize: line-ending and BOM normalization for text file reads.
 *
 * Motivation — bead i72 (P1: Line-ending normalization at file read
 * boundaries). CE's frontmatter.ts breaks on Windows-saved files (CRLF
 * endings) and BOM-prefixed files. Our SKILL.md loader, bead-template
 * parser, plan-file readers, and many JSON/YAML parsers have the same
 * latent issue: a contributor on Windows can silently produce broken
 * artifacts (frontmatter that "looks fine" but won't parse, JSON whose
 * leading `{` is a BOM, etc.).
 *
 * Policy:
 *   - Strip a leading UTF-8 BOM (`\uFEFF`) once at the start.
 *   - Replace every CRLF and bare CR with LF, so downstream parsers see
 *     a single canonical line ending.
 *
 * Use this at every site that does `fs.readFile(path, 'utf8')` and then
 * parses markdown, YAML, or JSON. Skip for opaque binary I/O and for
 * files where preserving CRLF is part of the contract (e.g. shipped
 * Windows batch scripts).
 */
export declare function normalizeText(raw: string): string;
//# sourceMappingURL=text-normalize.d.ts.map