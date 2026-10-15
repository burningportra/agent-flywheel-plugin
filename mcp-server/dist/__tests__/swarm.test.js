import { describe, expect, it } from "vitest";
import { recommendComposition } from "../swarm.js";
describe("recommendComposition", () => {
    it("keeps the small-project composition below 100 open beads", () => {
        expect(recommendComposition(99)).toEqual({
            total: 3,
            models: [
                { model: "anthropic/claude-opus-4-7", count: 1 },
                { model: "codex", count: 1 },
                { model: "anthropic/claude-haiku-4-5", count: 1 },
            ],
            rationale: "99 open beads — small project, minimal swarm",
        });
    });
    it("keeps the medium-project composition from 100 through 399 open beads", () => {
        expect(recommendComposition(100)).toEqual({
            total: 8,
            models: [
                { model: "anthropic/claude-opus-4-7", count: 3 },
                { model: "codex", count: 3 },
                { model: "anthropic/claude-haiku-4-5", count: 2 },
            ],
            rationale: "100 open beads — medium project, moderate swarm",
        });
        expect(recommendComposition(399)).toEqual({
            total: 8,
            models: [
                { model: "anthropic/claude-opus-4-7", count: 3 },
                { model: "codex", count: 3 },
                { model: "anthropic/claude-haiku-4-5", count: 2 },
            ],
            rationale: "399 open beads — medium project, moderate swarm",
        });
    });
    it("keeps the large-project composition at 400 or more open beads", () => {
        expect(recommendComposition(400)).toEqual({
            total: 10,
            models: [
                { model: "anthropic/claude-opus-4-7", count: 4 },
                { model: "codex", count: 4 },
                { model: "anthropic/claude-haiku-4-5", count: 2 },
            ],
            rationale: "400 open beads — large project, full swarm recommended",
        });
    });
});
//# sourceMappingURL=swarm.test.js.map