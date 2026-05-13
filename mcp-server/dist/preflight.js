/**
 * T4.1 — Pre-flight banner renderer for `/agent-flywheel:start` Step 0c.
 *
 * Surfaces missing-deps inline above the start menu so a first-run operator
 * doesn't bounce off a cryptic downstream error. The banner only renders when
 * one of the 6 critical checks below is non-green; otherwise returns null and
 * Step 0c skips the AskUserQuestion gate entirely.
 */
/**
 * Which doctor checks gate Step 0c. Order is the render order so the banner
 * is stable across runs.
 */
export const PREFLIGHT_CHECK_NAMES = [
    "br_binary",
    "bv_binary",
    "cm_binary",
    "agent_mail_liveness",
    "mcp_connectivity",
    "projects_base_misconfig",
];
/**
 * Renders the pre-flight banner block. Returns `null` when no critical
 * check is non-green — Step 0c treats null as "skip the gate."
 */
export function renderPreflightBanner(report) {
    const critical = new Set(PREFLIGHT_CHECK_NAMES);
    const issues = report.checks.filter((c) => critical.has(c.name) && c.severity !== "green");
    if (issues.length === 0)
        return null;
    return [
        "⚠ Pre-flight issues:",
        ...issues.map((c) => `   • ${c.name} — ${c.message ?? "(no message)"}  → Try: ${("tryThis" in c && c.tryThis) || c.hint || "see /flywheel-doctor"}`),
        "",
        "Run /agent-flywheel:flywheel-setup to fix all at once, or continue with degraded features.",
    ].join("\n");
}
//# sourceMappingURL=preflight.js.map