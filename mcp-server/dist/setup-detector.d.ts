export type InstallPlan = {
    install: string[];
    register: string[];
    start: string[];
    configure: string[];
    skip: string[];
};
/**
 * Names of the ACFS-stack CLIs the flywheel detects. Order is preserved
 * in the resulting `install` / `skip` buckets so the skill can render a
 * stable list to the user.
 */
export declare const REQUIRED_CLIS: readonly ["br", "bv", "cm", "dcg", "ntm"];
export type RequiredCli = (typeof REQUIRED_CLIS)[number];
export type Probes = {
    hasCli: (bin: RequiredCli) => Promise<boolean>;
    isAgentMailAlive: () => Promise<boolean>;
    isMcpRegistered: () => Promise<boolean>;
    getNtmBase: () => Promise<string | null>;
};
export declare function detectInstallState(opts: {
    cwd: string;
    probes?: Partial<Probes>;
}): Promise<InstallPlan>;
/**
 * T3.2 — Render an `InstallPlan` as a fixed-shape bulleted list for the
 * `/flywheel-setup` Step 2 consent prompt. Pure stringifier; do not call
 * from probing code.
 *
 * The Skip row is omitted entirely when nothing is already configured, so
 * fresh-machine plans do not show a noisy empty "Skip" line.
 */
export declare function renderPlan(plan: InstallPlan): string;
/**
 * T3.2 — True when the plan has zero actionable items. `skip` does not
 * count: a skip-only plan means everything is already configured, so the
 * setup skill should short-circuit to "already configured, run doctor."
 */
export declare function isPlanEmpty(plan: InstallPlan): boolean;
/**
 * One step of the batch run. `status: "ok"` means the step succeeded;
 * `"error"` means caller must surface error + tryThis and prompt for
 * retry/skip/abort. `step` mirrors the `BatchExecutor` method name so a
 * caller can correlate the result with the original bucket.
 */
export type BatchResult = {
    status: "ok" | "error";
    step: "installTool" | "registerMcp" | "symlink" | "startAgentMail";
    target?: string;
    error?: string;
    note?: string;
};
/**
 * Pluggable batch step set. Production wiring uses `performSymlink` and
 * `registerMcpAtomic` from this module; tests inject deterministic stubs
 * to assert call ordering and error propagation.
 */
export interface BatchExecutor {
    installTool(name: string): Promise<BatchResult>;
    registerMcp(name: string): Promise<BatchResult>;
    symlink(spec: string): Promise<BatchResult>;
    startAgentMail(): Promise<BatchResult>;
}
/**
 * Walks an `InstallPlan` in a fixed order: `install` → `register` →
 * `configure` (symlinks) → `start` (services). Does NOT short-circuit on
 * a failed step — the caller (skills/flywheel-setup) decides retry, skip,
 * or abort, which lets the operator finish symlinking even when a brew
 * install hiccups. Returns one `BatchResult` per planned action; empty
 * buckets contribute nothing.
 */
export declare function executeBatch(plan: InstallPlan, exec: BatchExecutor): Promise<BatchResult[]>;
/**
 * Symlink helper for the `configure` bucket. Accepts either a raw absolute
 * path or a `"projects_base symlink: <abs-target>"` plan-line and creates
 * `<target>` pointing at `cwd`. Idempotent — if `target` already exists,
 * returns `ok` with `note: "already symlinked"`.
 */
export declare function performSymlink(cwd: string, spec: string): Promise<BatchResult>;
/**
 * Structural subset of the doctor report the post-flight render needs.
 * Decoupled from the canonical DoctorReport type so this module stays
 * import-free of doctor.ts (which depends on heavy probe wiring) and can
 * be exercised by lightweight unit tests.
 */
export type DoctorReportLike = {
    overall: "green" | "yellow" | "red";
    checks: Array<{
        name: string;
        severity: "green" | "yellow" | "red";
        message?: string;
        hint?: string;
    }>;
};
/**
 * Step 4 of `/flywheel-setup`. Invokes the injected doctor once, then
 * stringifies the report into either a success banner or a list of
 * failing checks (yellow + red) with each one's `hint` surfaced inline.
 * Falls back to a generic "see /flywheel-doctor" pointer when a check has
 * no hint of its own.
 */
export declare function runPostFlight(opts: {
    cwd: string;
    doctor: (input: {
        cwd: string;
    }) => Promise<DoctorReportLike>;
}): Promise<string>;
/**
 * Idempotent MCP-server registration: merges `mcpServers["agent-flywheel"]`
 * into `~/.claude.json` via atomic tmp+rename. Existing `mcpServers` keys
 * are preserved. If the key is already present, returns `ok` with
 * `note: "already registered"`.
 */
export declare function registerMcpAtomic(opts?: {
    configPath?: string;
    pluginRoot?: string;
}): Promise<BatchResult>;
//# sourceMappingURL=setup-detector.d.ts.map