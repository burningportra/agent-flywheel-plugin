import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildFreshEyesPrompt, type FreshEyesPromptOpts } from "../gates.js";

const baseOptions: FreshEyesPromptOpts = {
  round: 3,
  memoryContext: "\n\n## Prior Session Learnings\nkeep reservations narrow\n",
  allArtifacts: ["src/a.ts", "src/b.ts"],
  callbackHint: "\n\nCALLBACK",
  regressionHint: "\n\nREGRESSION",
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("buildFreshEyesPrompt", () => {
  it("preserves the legacy self-review prompt byte-for-byte", () => {
    const prompt = buildFreshEyesPrompt({
      ...baseOptions,
      emitStructuredFindings: false,
    });

    expect(Buffer.byteLength(prompt)).toBe(2296);
    expect(sha256(prompt)).toBe(
      "94fd0201dfd153e918cd8ac29b555c8b2f7ff902ca7a96223117e90934bb5c63",
    );
    expect(prompt).toContain("- src/a.ts\n- src/b.ts");
    expect(prompt).not.toContain("STRUCTURED FINDINGS REQUIRED");
  });

  it("preserves the structured findings contract byte-for-byte", () => {
    const prompt = buildFreshEyesPrompt({
      ...baseOptions,
      shaRange: "abc123..def456",
      emitStructuredFindings: true,
    });

    expect(Buffer.byteLength(prompt)).toBe(3236);
    expect(sha256(prompt)).toBe(
      "0fc2cbc117252f5310af9b0facfdfc37c4d19c0283871194b6112b3730cb1632",
    );
    expect(prompt).toContain('"sha_range": "abc123..def456"');
    expect(prompt).toContain("findings = []` is mandatory for `status = \"pass\"");
  });
});
