/**
 * Wave collision detection (agent-flywheel-plugin-iy4).
 *
 * Covers:
 * - captureWaveStartSha: happy path + git-rev-parse failure surfaces FlywheelError
 * - diffWorkerAgainstWaveStart: parses `git diff --name-only` output
 * - matchesGlob / isIgnoredCollisionPath: minimal glob dialect
 * - aggregateCollisions: pure-function detection with mocked git outputs
 * - detectWaveCollisions: end-to-end orchestration with mocked exec
 * - forceSerialRerun: runs colliding units sequentially, in stable order
 * - collision-ignore seeding + load: idempotent file write, custom patterns honored
 */
export {};
//# sourceMappingURL=coordination.collisions.test.d.ts.map