import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../memory.js", () => ({
  readMemory: vi.fn(),
}));

import { withCassContext } from "../feedback.js";
import { readMemory } from "../memory.js";

const mockReadMemory = vi.mocked(readMemory);

describe("withCassContext", () => {
  beforeEach(() => {
    mockReadMemory.mockReset();
  });

  it("prepends CASS memory to the prompt", () => {
    mockReadMemory.mockReturnValue("- [b-123] Keep the useful context.");

    const result = withCassContext("Implement the bead.", "/repo", "the bead");

    expect(result).toBe(
      "## Context from Prior Flywheel Runs\n" +
      "- [b-123] Keep the useful context.\n\n" +
      "---\n\n" +
      "Implement the bead.",
    );
    expect(mockReadMemory).toHaveBeenCalledWith("/repo", "the bead");
  });

  it("returns the original prompt when reading memory throws", () => {
    mockReadMemory.mockImplementation(() => {
      throw new Error("cm timed out");
    });

    expect(withCassContext("Implement the bead.", "/repo", "the bead")).toBe(
      "Implement the bead.",
    );
  });
});
