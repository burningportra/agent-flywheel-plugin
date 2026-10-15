import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withCassContext } from "../feedback.js";
import { resetCassDetection } from "../memory.js";
describe("CASS context timeout", () => {
    afterEach(() => {
        resetCassDetection();
        vi.unstubAllEnvs();
    });
    it("returns promptly when the cm context lookup hangs", () => {
        const binDir = mkdtempSync(join(tmpdir(), "flywheel-cm-timeout-"));
        const cmPath = join(binDir, "cm");
        writeFileSync(cmPath, [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then',
            "  printf 'cm 1.0\\n'",
            "  exit 0",
            "fi",
            "exec sleep 30",
            "",
        ].join("\n"), "utf8");
        chmodSync(cmPath, 0o755);
        vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
        resetCassDetection();
        try {
            const startedAt = performance.now();
            const result = withCassContext("Implement the bead.", binDir, "the bead");
            const elapsedMs = performance.now() - startedAt;
            expect(result).toBe("Implement the bead.");
            expect(elapsedMs).toBeLessThan(5_000);
        }
        finally {
            rmSync(binDir, { recursive: true, force: true });
        }
    }, 15_000);
});
//# sourceMappingURL=memory.test.js.map