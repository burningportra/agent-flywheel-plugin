import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const wrapup = readFileSync(path.join(repoRoot, "skills", "start", "_wrapup.md"), "utf8");

function section(start: string, end: string): string {
  const startIndex = wrapup.indexOf(start);
  const endIndex = wrapup.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return wrapup.slice(startIndex, endIndex);
}

describe("wrap-up single-source procedures", () => {
  it("prints the grading tool text and keeps the verdict decisions", () => {
    const grading = section("## Step 9.5.0:", "## Step 9.5:");

    expect(grading).toContain("result.content[0].text");
    expect(grading).not.toContain("renderVerdictTable");
    expect(grading).toContain("AskUserQuestion");
    expect(grading).toContain("`Iterate`");
    expect(grading).toContain("`Accept anyway`");
    expect(grading).toContain("`Abort`");
  });

  it("invokes docs-de-slopify once without caching its rules", () => {
    expect(wrapup.match(/\/docs-de-slopify/g)).toHaveLength(1);
    expect(wrapup).not.toContain("Emdash overuse");
    expect(wrapup.match(/\bWrite\s*\(/g)).toHaveLength(1);
  });

  it("calls the team-drain script before TeamDelete instead of embedding jq", () => {
    const cycleReset = section("#### Cycle-reset checklist", '> **"Done for now" also triggers team-drain.**');

    expect(cycleReset).toContain("mcp-server/scripts/team-drain.sh <team-name>...");
    expect(cycleReset).toContain("confirm that nothing owns it");
    expect(cycleReset).toContain("TeamDelete");
    expect(cycleReset).not.toContain("jq '.members");
  });
});
