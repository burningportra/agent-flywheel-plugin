import { join } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { errMsg } from "./errors.js";
import { loadCachedProfile, profileRepo, saveCachedProfile } from "./profiler.js";
import { assertSafeSegment } from "./utils/path-safety.js";
/**
 * Compute or load the repo profile snapshot and persist it as JSON under outputDir.
 * Returns the absolute path to the snapshot, or null if profiling failed entirely.
 * Exported for testability.
 */
export async function writeProfileSnapshot(exec, cwd, outputDir, signal) {
    try {
        let profile = await loadCachedProfile(exec, cwd);
        if (!profile) {
            profile = await profileRepo(exec, cwd, signal);
            // Fire-and-forget cache save; don't let it block planners.
            saveCachedProfile(exec, cwd, profile).catch(() => { });
        }
        const snapshotPath = join(outputDir, "profile-snapshot.json");
        writeFileSync(snapshotPath, JSON.stringify(profile, null, 2), "utf8");
        return snapshotPath;
    }
    catch (err) {
        process.stderr.write(`[deep-plan] WARNING: Could not compute profile snapshot: ${errMsg(err)}\n`);
        return null;
    }
}
/**
 * Run deep planning agents via the claude CLI in print mode.
 * Each agent gets its own task file and runs in parallel.
 */
export async function runDeepPlanAgents(exec, cwd, agents, signal) {
    // Write each agent's task to a temp file and spawn claude in print mode
    const outputDir = join(tmpdir(), `claude-deep-plan-${Date.now()}`);
    let resolvedOutputDir = outputDir;
    try {
        mkdirSync(outputDir, { recursive: true });
    }
    catch (err) {
        const fallbackDir = join(tmpdir(), `claude-deep-plan-fallback-${Date.now()}`);
        try {
            mkdirSync(fallbackDir, { recursive: true });
            resolvedOutputDir = fallbackDir;
        }
        catch {
            resolvedOutputDir = tmpdir(); // last resort
        }
        process.stderr.write(`[deep-plan] WARNING: Could not create output dir ${outputDir}, falling back to ${resolvedOutputDir}\n`);
    }
    // Compute/load shared profile snapshot once and hand path to each planner.
    const snapshotPath = await writeProfileSnapshot(exec, cwd, resolvedOutputDir, signal);
    const snapshotPreamble = snapshotPath
        ? `Shared repo profile available at: ${snapshotPath}. Read it once with the Read tool before scanning; do NOT rerun broad grep/ls unless the snapshot is missing fields you need.\n\n`
        : "";
    const promises = agents.map(async (agent) => {
        const startTime = Date.now();
        // Path-traversal guard (bead mq3): agent.name is attacker-influencible in
        // the spawn config path (e.g. if a future synthesis agent emits it). Reject
        // any separator/control/colon before splicing into the filename.
        const nameCheck = assertSafeSegment(agent.name);
        if (!nameCheck.ok) {
            return {
                name: agent.name,
                model: agent.model ?? "default",
                plan: `(AGENT FAILED — unsafe agent.name rejected: ${nameCheck.reason})`,
                exitCode: 1,
                elapsed: 0,
                error: `unsafe agent.name: ${nameCheck.message}`,
            };
        }
        const safeName = nameCheck.value;
        const taskFile = join(resolvedOutputDir, `${safeName}-task.md`);
        const outputFile = join(resolvedOutputDir, `${safeName}-output.md`);
        try {
            writeFileSync(taskFile, `${snapshotPreamble}${agent.task}`, "utf8");
            const args = [
                "--print", // non-interactive, output to stdout
                "--tools", "read,bash,grep,find,ls", // read-only tools
            ];
            if (agent.model) {
                args.push("--model", agent.model);
            }
            args.push(`@${taskFile}`);
            const result = await exec("claude", args, {
                timeout: Number(process.env.DEEP_PLAN_TIMEOUT_MS ?? 420000), // 7 min default; override via DEEP_PLAN_TIMEOUT_MS env var
                cwd,
                signal,
            });
            const plan = result.stdout.trim();
            if (!plan) {
                return {
                    name: agent.name,
                    model: agent.model ?? "default",
                    plan: "(AGENT RETURNED EMPTY — exclude from synthesis)",
                    exitCode: result.code,
                    elapsed: Math.floor((Date.now() - startTime) / 1000),
                };
            }
            try {
                writeFileSync(outputFile, plan, "utf8");
            }
            catch (writeErr) {
                process.stderr.write(`[deep-plan] WARNING: Could not write output file ${outputFile}: ${errMsg(writeErr)}\n`);
            }
            return {
                name: agent.name,
                model: agent.model ?? "default",
                plan,
                exitCode: result.code,
                elapsed: Math.floor((Date.now() - startTime) / 1000),
            };
        }
        catch (err) {
            return {
                name: agent.name,
                model: agent.model ?? "default",
                plan: `(AGENT FAILED — exclude from synthesis: ${errMsg(err)})`,
                exitCode: 1,
                elapsed: Math.floor((Date.now() - startTime) / 1000),
                error: errMsg(err),
            };
        }
    });
    // Run all in parallel, then filter to only viable results for synthesis
    const allResults = await Promise.all(promises);
    const viable = filterViableResults(allResults);
    if (viable.length === 0) {
        process.stderr.write(`[deep-plan] WARNING: All ${allResults.length} planners failed or timed out. Synthesis will be empty.\n`);
    }
    else if (viable.length < allResults.length) {
        process.stderr.write(`[deep-plan] WARNING: Only ${viable.length}/${allResults.length} planners succeeded.\n`);
    }
    return viable;
}
/**
 * Filter deep-plan results to only those that are viable for synthesis.
 * Excludes failed agents and empty results (sentinel strings starting with "(AGENT").
 */
export function filterViableResults(results) {
    return results.filter(r => r.exitCode === 0 && !r.plan.startsWith("(AGENT"));
}
// ─── I9: Synthesizer template hints ──────────────────────────
//
// The synthesizer may annotate bead specs with a template hint of the shape
// `<id>@<version>` (e.g. `foundation-with-fresh-eyes-gate@1`). Approve-time
// expansion (in `tools/approve.ts`) parses the hint and calls
// `expandTemplate(id, version, input)` from `bead-templates.ts`. Beads without
// a hint fall through the legacy free-form path unchanged.
/**
 * Matches a synthesizer-emitted template hint of the shape `<id>@<version>`.
 *
 * - `id`      — lowercase kebab-case (same shape validated by
 *               `validateTemplateIntegrity` in `bead-templates.ts`).
 * - `version` — positive integer.
 *
 * Leading/trailing whitespace is tolerated so `template: "  foo@1  "` still
 * parses; internal whitespace is rejected.
 */
export const TEMPLATE_HINT_REGEX = /^(?<id>[a-z][a-z0-9-]*)@(?<version>\d+)$/;
/**
 * Parse a synthesizer-emitted template hint (`"<id>@<version>"`).
 *
 * Returns `undefined` when the hint is missing, not a string, or malformed —
 * the caller should treat `undefined` as "no template hint, fall through to
 * legacy free-form bead creation." Malformed hints are logged at warn level so
 * they surface in session telemetry without breaking the bead-creation path.
 */
export function parseTemplateHint(hint) {
    if (typeof hint !== "string")
        return undefined;
    const trimmed = hint.trim();
    if (trimmed.length === 0)
        return undefined;
    const match = TEMPLATE_HINT_REGEX.exec(trimmed);
    if (!match || !match.groups) {
        process.stderr.write(`[deep-plan] WARNING: Ignoring malformed template hint: ${JSON.stringify(trimmed)}\n`);
        return undefined;
    }
    const version = Number.parseInt(match.groups.version, 10);
    if (!Number.isFinite(version) || version < 1) {
        process.stderr.write(`[deep-plan] WARNING: Ignoring template hint with non-positive version: ${JSON.stringify(trimmed)}\n`);
        return undefined;
    }
    return { id: match.groups.id, version };
}
/**
 * Guidance block embedded into the plan-to-beads prompt so the synthesizing
 * agent knows how to emit template hints. Kept as an exported helper so it
 * can be composed into both the freeform bead-creation prompt
 * (`prompts.ts` §planToBeadsPrompt) and any future synthesizer prompt paths.
 */
export function synthesizerTemplateHintGuidance() {
    return [
        "### Template hints (optional but recommended)",
        "",
        "When a bead matches one of the built-in templates, annotate the bead spec with:",
        "",
        "    template: <id>@<version>",
        "",
        "The approve-time expansion path will call `expandTemplate(id, version, { title, scope, acceptance, test_plan })`",
        "and replace the bead description with the rendered body. When that expanded body is used in `br create`,",
        "include a machine-readable `Template: <id>` line near the top so `flywheel_calibrate` can group closed beads by template.",
        "Beads without a `template:` hint flow through the legacy free-form path unchanged and should omit `Template: <id>`.",
        "",
        "Hint ids must be lowercase kebab-case and versions must be positive integers,",
        "matching the regex `^[a-z][a-z0-9-]*@\\d+$` (e.g. `foundation-with-fresh-eyes-gate@1`).",
        "Malformed hints are ignored with a warn-level log; the bead is created as free-form.",
    ].join("\n");
}
//# sourceMappingURL=deep-plan.js.map