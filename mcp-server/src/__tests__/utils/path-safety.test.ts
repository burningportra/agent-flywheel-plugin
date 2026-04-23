import { describe, it, expect } from "vitest";
import {
  assertSafeRelativePath,
  assertSafeSegment,
  requireSafeRelativePath,
  requireSafeSegment,
} from "../../utils/path-safety.js";

const ROOT = "/tmp/flywheel-root";

describe("assertSafeRelativePath", () => {
  it("accepts a normal relative path", () => {
    const r = assertSafeRelativePath("docs/plans/2026-04-23-x.md", { root: ROOT });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("docs/plans/2026-04-23-x.md");
  });

  it("rejects '../foo' (parent traversal)", () => {
    const r = assertSafeRelativePath("../foo", { root: ROOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("parent_traversal");
  });

  it("rejects nested '../' escape (a/../../b)", () => {
    const r = assertSafeRelativePath("a/../../b", { root: ROOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("parent_traversal");
  });

  it("rejects '/etc/passwd' when relative is expected", () => {
    const r = assertSafeRelativePath("/etc/passwd", { root: ROOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("absolute_when_relative_expected");
  });

  it("rejects absolute paths even when they happen to start with root prefix", () => {
    // An absolute-looking path shouldn't sneak through just because it matches.
    const r = assertSafeRelativePath(`${ROOT}/../etc/passwd`, { root: ROOT });
    expect(r.ok).toBe(false);
  });

  it("allows absolute paths inside root when opted in, but rejects ones outside", () => {
    const inside = assertSafeRelativePath(`${ROOT}/docs/x.md`, {
      root: ROOT,
      allowAbsoluteInsideRoot: true,
    });
    expect(inside.ok).toBe(true);

    const outside = assertSafeRelativePath("/etc/passwd", {
      root: ROOT,
      allowAbsoluteInsideRoot: true,
    });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.reason).toBe("escapes_root");
  });

  it("rejects null-byte injection 'foo\\u0000bar'", () => {
    const r = assertSafeRelativePath("foo\u0000bar", { root: ROOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("null_byte");
  });

  it("rejects control characters", () => {
    const r = assertSafeRelativePath("foo\tbar", { root: ROOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("control_char");
  });

  it("rejects empty input", () => {
    const r = assertSafeRelativePath("", { root: ROOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("empty");
  });

  it("rejects non-string input", () => {
    const r = assertSafeRelativePath(42 as unknown, { root: ROOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_string");
  });

  it("rejects paths over maxLength", () => {
    const huge = "a/".repeat(600) + "x";
    const r = assertSafeRelativePath(huge, { root: ROOT, maxLength: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_long");
  });
});

describe("assertSafeSegment", () => {
  it("accepts a normal identifier", () => {
    const r = assertSafeSegment("agent-flywheel-plugin-mq3");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("agent-flywheel-plugin-mq3");
  });

  it("rejects 'foo:bar' (CE-blunder canary — colon spread into path.join)", () => {
    const r = assertSafeSegment("foo:bar");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("colon");
  });

  it("rejects '..:..:etc:passwd' (opencode.ts:106 repro shape)", () => {
    const r = assertSafeSegment("..:..:etc:passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("colon");
  });

  it("rejects '..' literal", () => {
    const r = assertSafeSegment("..");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("reserved_segment");
  });

  it("rejects '.' literal", () => {
    const r = assertSafeSegment(".");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("reserved_segment");
  });

  it("rejects segment containing '/'", () => {
    const r = assertSafeSegment("foo/bar");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("separator_in_segment");
  });

  it("rejects segment containing backslash", () => {
    const r = assertSafeSegment("foo\\bar");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("backslash");
  });

  it("rejects segment with null byte 'foo\\u0000bar'", () => {
    const r = assertSafeSegment("foo\u0000bar");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("null_byte");
  });

  it("rejects leading dot when rejectLeadingDot is set", () => {
    const r = assertSafeSegment(".env", { rejectLeadingDot: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("reserved_segment");
  });

  it("allows leading dot by default", () => {
    const r = assertSafeSegment(".env");
    expect(r.ok).toBe(true);
  });

  it("rejects segments over maxLength", () => {
    const long = "a".repeat(200);
    const r = assertSafeSegment(long, { maxLength: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_long");
  });
});

describe("require* helpers throw on rejection", () => {
  it("requireSafeRelativePath throws for '../foo'", () => {
    expect(() => requireSafeRelativePath("../foo", { root: ROOT })).toThrow(
      /parent_traversal/,
    );
  });

  it("requireSafeSegment throws for 'foo:bar'", () => {
    expect(() => requireSafeSegment("foo:bar")).toThrow(/colon/);
  });

  it("requireSafeRelativePath returns the normalized value on accept", () => {
    expect(
      requireSafeRelativePath("docs/plans/x.md", { root: ROOT }),
    ).toBe("docs/plans/x.md");
  });
});
