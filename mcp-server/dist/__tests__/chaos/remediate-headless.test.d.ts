/**
 * Chaos test: headless / CI use case.
 *
 * Simulates `process.stdin.isTTY === false` (no terminal) AND
 * `autoConfirm: true`. The dispatcher MUST proceed — it must not block on
 * any interactive confirm. This is the canonical CI invocation pattern.
 *
 * The dispatcher itself does not consult `process.stdin.isTTY` (the gate is
 * autoConfirm), so the goal here is to assert the contract holds even when
 * stdin is non-TTY: a mutating handler in execute mode with autoConfirm:true
 * runs to completion.
 */
export {};
//# sourceMappingURL=remediate-headless.test.d.ts.map