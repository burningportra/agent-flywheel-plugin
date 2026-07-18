import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyRepoProfile, profileRepo } from "../profiler.js";
import { scanRepo } from "../scan.js";
vi.mock("../profiler.js", async () => {
    const actual = await vi.importActual("../profiler.js");
    return {
        ...actual,
        profileRepo: vi.fn(),
    };
});
const CWD = "/workspaces/agent-flywheel";
const profileRepoMock = vi.mocked(profileRepo);
let stderrLines = [];
let restoreStderr = () => { };
beforeEach(() => {
    stderrLines = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderrLines.push(String(chunk));
        return true;
    });
    restoreStderr = () => stderrSpy.mockRestore();
    profileRepoMock.mockReset();
    profileRepoMock.mockResolvedValue(makeProfile());
});
afterEach(() => {
    restoreStderr();
});
function execResult(overrides = {}) {
    return {
        code: 0,
        stdout: "",
        stderr: "",
        ...overrides,
    };
}
function makeProfile(overrides = {}) {
    return {
        name: "mock-repo",
        languages: ["TypeScript"],
        frameworks: ["Vitest"],
        structure: "mcp-server/src/server.ts",
        entrypoints: ["mcp-server/src/server.ts"],
        recentCommits: [],
        hasTests: true,
        testFramework: "Vitest",
        hasDocs: true,
        hasCI: false,
        ciPlatform: undefined,
        todos: [],
        keyFiles: { "package.json": "{}" },
        readme: "# Mock Repo",
        packageManager: "npm",
        bestPracticesGuides: [],
        ...overrides,
    };
}
function cccSearchOutput(location, snippet) {
    return [
        "--- Result 1 (score: 0.91) ---",
        `File: ${location}`,
        snippet,
        "",
    ].join("\n");
}
function stderrText() {
    return stderrLines.join("");
}
async function resolveBehavior(behavior) {
    if (behavior instanceof Error) {
        throw behavior;
    }
    return behavior;
}
function searchIdFromArgs(args) {
    const joined = args.join(" ");
    if (joined.includes("workflow")) {
        return "workflow-entrypoints";
    }
    if (joined.includes("planning")) {
        return "planning-review";
    }
    if (joined.includes("fallback")) {
        return "reliability-fallbacks";
    }
    throw new Error(`unexpected ccc search args: ${joined}`);
}
function makeCccExec(options = {}) {
    const exec = vi.fn(async (cmd, args) => {
        if (cmd !== "ccc") {
            throw new Error(`unexpected command: ${cmd}`);
        }
        const subcommand = args[0];
        if (subcommand === "--help") {
            return resolveBehavior(options.help ?? execResult({ stdout: "ccc help" }));
        }
        if (subcommand === "status") {
            return resolveBehavior(options.status ?? execResult({ stdout: "ready" }));
        }
        if (subcommand === "init") {
            return resolveBehavior(options.init ?? execResult());
        }
        if (subcommand === "index") {
            return resolveBehavior(options.index ?? execResult({ stdout: "indexed" }));
        }
        if (subcommand === "search") {
            const searchId = searchIdFromArgs(args);
            const behavior = options.searches?.[searchId] ??
                options.defaultSearch ??
                execResult({
                    stdout: cccSearchOutput(`mcp-server/src/${searchId}.ts:1`, `${searchId} match`),
                });
            return resolveBehavior(behavior);
        }
        throw new Error(`unexpected ccc subcommand: ${subcommand}`);
    });
    return exec;
}
describe("scanRepo falls back to builtin when ccc throws", () => {
    it("uses the builtin profile when the ccc binary check exits non-zero", async () => {
        const fallbackProfile = makeProfile({ name: "builtin-profile" });
        profileRepoMock.mockResolvedValueOnce(fallbackProfile);
        const exec = makeCccExec({
            help: execResult({ code: 1, stderr: "ccc missing" }),
        });
        const result = await scanRepo(exec, CWD);
        expect(result.source).toBe("builtin");
        expect(result.provider).toBe("builtin");
        expect(result.profile).toBe(fallbackProfile);
        expect(result.fallback).toMatchObject({
            used: true,
            from: "ccc",
            to: "builtin",
            reason: "ccc missing",
        });
        expect(profileRepoMock).toHaveBeenCalledTimes(1);
        expect(stderrText()).toContain("ccc provider failed");
    });
    it("uses the builtin profile when ccc indexing rejects", async () => {
        const fallbackProfile = makeProfile({ name: "index-fallback" });
        profileRepoMock.mockResolvedValueOnce(fallbackProfile);
        const exec = makeCccExec({
            index: new Error("index exploded"),
        });
        const result = await scanRepo(exec, CWD);
        expect(result.source).toBe("builtin");
        expect(result.profile.name).toBe("index-fallback");
        expect(result.sourceMetadata?.warnings).toContain("Fell back from ccc to builtin scan provider.");
        expect(result.fallback?.error).toEqual({
            message: "index exploded",
            recoverable: true,
        });
        expect(profileRepoMock).toHaveBeenCalledTimes(1);
    });
});
describe("partial ccc query failure returns partial ScanCodebaseAnalysis", () => {
    it("keeps two successful ccc searches when one query exits non-zero", async () => {
        const cccProfile = makeProfile({ name: "ccc-profile" });
        profileRepoMock.mockResolvedValueOnce(cccProfile);
        const exec = makeCccExec({
            searches: {
                "workflow-entrypoints": execResult({
                    stdout: cccSearchOutput("mcp-server/src/server.ts:10", "server entrypoint"),
                }),
                "planning-review": execResult({ code: 2, stderr: "planning failed" }),
                "reliability-fallbacks": execResult({
                    stdout: cccSearchOutput("mcp-server/src/scan.ts:20", "fallback path"),
                }),
            },
        });
        const result = await scanRepo(exec, CWD);
        expect(result.source).toBe("ccc");
        expect(result.fallback).toBeUndefined();
        expect(result.profile).toBe(cccProfile);
        expect(result.codebaseAnalysis.summary).toBe("ccc scanned 2 codebase slices and returned 2 relevant matches.");
        expect(result.codebaseAnalysis.recommendations.map((r) => r.id)).toEqual([
            "workflow-entrypoints",
            "reliability-fallbacks",
        ]);
        expect(result.codebaseAnalysis.structuralInsights).toHaveLength(2);
        expect(result.codebaseAnalysis.qualitySignals).toContainEqual({
            label: "query_count",
            value: "2",
        });
        expect(stderrText()).toContain('ccc query "planning-review" failed');
    });
    it("retains a successful query even when it returns no matches", async () => {
        const exec = makeCccExec({
            searches: {
                "workflow-entrypoints": execResult({ stdout: "" }),
                "planning-review": execResult({ code: 1, stderr: "review failed" }),
                "reliability-fallbacks": execResult({
                    stdout: cccSearchOutput("mcp-server/src/errors.ts:12", "error handling"),
                }),
            },
        });
        const result = await scanRepo(exec, CWD);
        expect(result.source).toBe("ccc");
        expect(result.codebaseAnalysis.summary).toBe("ccc scanned 2 codebase slices and returned 1 relevant matches.");
        expect(result.codebaseAnalysis.recommendations).toHaveLength(2);
        expect(result.codebaseAnalysis.recommendations[0]).toMatchObject({
            id: "workflow-entrypoints",
            detail: "No ccc matches found for query: flywheel workflow command entrypoint state machine",
        });
        expect(result.codebaseAnalysis.recommendations[1].detail).toContain("mcp-server/src/errors.ts:12");
    });
});
describe("all ccc queries fail and trigger builtin fallback", () => {
    it("falls back after all ccc searches exit non-zero", async () => {
        const cccProfile = makeProfile({ name: "ccc-profile" });
        const fallbackProfile = makeProfile({ name: "fallback-profile" });
        profileRepoMock
            .mockResolvedValueOnce(cccProfile)
            .mockResolvedValueOnce(fallbackProfile);
        const exec = makeCccExec({
            defaultSearch: execResult({ code: 2, stderr: "search failed" }),
        });
        const result = await scanRepo(exec, CWD);
        expect(result.source).toBe("builtin");
        expect(result.profile).toBe(fallbackProfile);
        expect(result.fallback).toMatchObject({
            used: true,
            from: "ccc",
            to: "builtin",
            reason: expect.stringContaining("search failed"),
        });
        expect(profileRepoMock).toHaveBeenCalledTimes(2);
        expect(stderrText()).toContain('ccc query "workflow-entrypoints" failed');
        expect(stderrText()).toContain("ccc provider failed");
    });
    it("falls back after every ccc search rejects", async () => {
        const fallbackProfile = makeProfile({ name: "fallback-after-rejections" });
        profileRepoMock
            .mockResolvedValueOnce(makeProfile({ name: "ccc-profile" }))
            .mockResolvedValueOnce(fallbackProfile);
        const exec = makeCccExec({
            defaultSearch: new Error("search crashed"),
        });
        const result = await scanRepo(exec, CWD);
        expect(result.source).toBe("builtin");
        expect(result.profile.name).toBe("fallback-after-rejections");
        expect(result.fallback?.reason).toBe("search crashed");
        expect(result.codebaseAnalysis.summary).toBe("Partial scan: fell back from ccc to builtin provider.");
        expect(profileRepoMock).toHaveBeenCalledTimes(2);
    });
});
describe("scanRepo never throws when both ccc and profiler fail", () => {
    it("returns an empty profile when ccc is unavailable and profiling rejects", async () => {
        profileRepoMock.mockRejectedValue(new Error("profiler down"));
        const exec = makeCccExec({
            help: execResult({ code: 1, stderr: "ccc missing" }),
        });
        const result = await scanRepo(exec, CWD);
        expect(result.source).toBe("builtin");
        expect(result.profile).toEqual(createEmptyRepoProfile(CWD));
        expect(result.codebaseAnalysis.summary).toBe("Scan failed: both ccc and builtin providers failed. Results may be incomplete.");
        expect(result.sourceMetadata?.warnings).toContain("Profiler also failed: profiler down");
        expect(stderrText()).toContain("builtin profiler also failed");
    });
    it("returns an empty profile when ccc searches and both profile attempts fail", async () => {
        profileRepoMock.mockRejectedValue(new Error("profile collector failed"));
        const exec = makeCccExec({
            defaultSearch: new Error("search crashed"),
        });
        await expect(scanRepo(exec, CWD)).resolves.toMatchObject({
            source: "builtin",
            provider: "builtin",
            profile: createEmptyRepoProfile(CWD),
            fallback: {
                used: true,
                from: "ccc",
                to: "builtin",
            },
        });
        expect(profileRepoMock).toHaveBeenCalledTimes(2);
        expect(stderrText()).toContain("profile collector failed");
    });
});
describe("createEmptyRepoProfile returns a valid RepoProfile shape", () => {
    it("populates required fields with empty safe defaults", () => {
        const profile = createEmptyRepoProfile("/tmp/service-api");
        expect(profile).toEqual({
            name: "service-api",
            languages: [],
            frameworks: [],
            structure: "",
            entrypoints: [],
            recentCommits: [],
            hasTests: false,
            testFramework: undefined,
            hasDocs: false,
            hasCI: false,
            ciPlatform: undefined,
            todos: [],
            keyFiles: {},
            readme: undefined,
            packageManager: undefined,
            bestPracticesGuides: [],
        });
    });
    it("returns fresh containers for each empty profile", () => {
        const first = createEmptyRepoProfile("/tmp/first-repo");
        const second = createEmptyRepoProfile("/tmp/second-repo");
        first.languages.push("TypeScript");
        first.entrypoints.push("mcp-server/src/server.ts");
        first.keyFiles["package.json"] = "{}";
        expect(first.name).toBe("first-repo");
        expect(second.name).toBe("second-repo");
        expect(second.languages).toEqual([]);
        expect(second.entrypoints).toEqual([]);
        expect(second.keyFiles).toEqual({});
    });
});
//# sourceMappingURL=scan.test.js.map