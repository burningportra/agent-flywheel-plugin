/**
 * I9 — Approve-time bead template expansion.
 *
 * Coverage:
 *   - Plan with a well-formed `template: "foundation-with-fresh-eyes-gate@1"`
 *     hint → bead created with expanded body (snapshot).
 *   - Plan with `add-feature@99` (version mismatch) → `template_not_found`
 *     envelope emitted through `makeFlywheelErrorResult`.
 *   - Plan missing a required placeholder → `template_placeholder_missing`
 *     envelope with hint remediation.
 *   - Legacy plan without any template hints → passthrough unchanged.
 *
 * This file exercises the pure helpers `expandBeadPlanSpec` and
 * `expandBeadPlanSpecs` — the bead-creation path is tested without touching
 * the br CLI or hotspot-matrix code (disjoint from I5 wiring per I9 spec).
 */
export {};
//# sourceMappingURL=approve.expand.test.d.ts.map