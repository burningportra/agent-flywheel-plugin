import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const mcpServerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const repoRoot = path.resolve(mcpServerRoot, "..");
const driverPath = path.join(mcpServerRoot, "scripts", "lint-skill-dir.ts");
let resolveRepoRoot;
beforeAll(async () => {
    const loaded = await import(pathToFileURL(driverPath).href);
    if (typeof loaded !== "object"
        || loaded === null
        || !("resolveRepoRoot" in loaded)
        || typeof loaded.resolveRepoRoot !== "function") {
        throw new Error("lint-skill-dir must export resolveRepoRoot");
    }
    const candidate = loaded.resolveRepoRoot;
    resolveRepoRoot = (scriptUrl) => {
        const result = candidate(scriptUrl);
        if (typeof result !== "string") {
            throw new Error("resolveRepoRoot must return a string");
        }
        return result;
    };
});
describe("lint-skill-dir repository root", () => {
    const layouts = [
        ["source scripts", pathToFileURL(path.join(mcpServerRoot, "scripts", "lint-skill-dir.ts")).href],
        ["compiled dist scripts", pathToFileURL(path.join(mcpServerRoot, "dist", "scripts", "lint-skill-dir.js")).href],
    ];
    it.each(layouts)("resolves the repository from the %s layout", (_layout, scriptUrl) => {
        expect(resolveRepoRoot(scriptUrl)).toBe(repoRoot);
    });
});
//# sourceMappingURL=lint-skill-dir.test.js.map