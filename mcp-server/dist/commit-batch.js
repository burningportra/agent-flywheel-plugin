import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { BatchReviewVerdictSchema } from "./types.js";
import { errMsg } from "./errors.js";
import { appendMemory } from "./memory.js";
const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const BR_TIMEOUT_MS = 15_000;
const RAW_SNIPPET_CHARS = 2048;
/** A bead filed from a finding gets P0 for critical down to P3 for low, so the swarm takes the worst first. */
const PRIORITY_BY_SEVERITY = { critical: "0", high: "1", medium: "2", low: "3" };
/**
 * Count commits since the batch-review baseline with `git rev-list --count
 * <sha>..HEAD` via execFile (the sha is an argv element, never shell text).
 * Throws on git failure so callers can decide whether to skip the gate.
 */
export async function countCommitsSinceLastBatchReview(cwd, sha, signal) {
    let stdout;
    try {
        const result = await execFileAsync("git", ["rev-list", "--count", `${sha}..HEAD`], { cwd, timeout: GIT_TIMEOUT_MS, signal });
        stdout = result.stdout;
    }
    catch (err) {
        throw new Error(`git rev-list failed in ${cwd}: ${errMsg(err)}`);
    }
    const trimmed = stdout.trim();
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n < 0) {
        throw new Error(`git rev-list returned non-integer count: "${trimmed}"`);
    }
    return n;
}
/** A 0, unset, or non-integer `commitBatchThreshold` turns batch reviews off. */
export function batchReviewsEnabled(state) {
    const threshold = state.commitBatchThreshold;
    return typeof threshold === "number" && Number.isInteger(threshold) && threshold > 0;
}
/** True when batch reviews are on and `count` (from `countCommitsSinceLastBatchReview`) has reached the threshold. */
export function shouldTriggerBatchReview(state, count) {
    return batchReviewsEnabled(state) && count >= state.commitBatchThreshold;
}
export function batchReviewVerdictPath(cwd, shaRange) {
    return path.join(cwd, ".pi-flywheel", "batch-reviews", `${shaRange}.json`);
}
/**
 * Record that a review of `shaRange` went out. Only commits after its end sha
 * count toward the next review, so the gate stays quiet while this one runs,
 * and the range stays in `pendingBatchReviews` until its verdict is applied.
 */
export function recordBatchReviewDispatch(state, shaRange) {
    state.lastBatchReviewSha = shaRange.split("..")[1];
    const pending = state.pendingBatchReviews ?? [];
    if (!pending.includes(shaRange))
        state.pendingBatchReviews = [...pending, shaRange];
}
/**
 * Read the verdict for `shaRange` and file one bead per finding, whatever the
 * verdict's status, or one re-review bead when the verdict can't be read.
 *
 * Mutates `state`. Each bead id goes into `batchReviewSynthesizedBeads[shaRange]`
 * as soon as br returns it, so a call that fails partway can simply be
 * repeated: it files only the findings that don't have a bead yet, and a call
 * on an applied range files nothing. The range leaves `pendingBatchReviews`
 * once every finding has its bead. Throws when the verdict file can't be read
 * or `br create` fails; the caller saves `state` either way.
 */
export async function applyBatchReviewVerdict(cwd, state, shaRange, signal) {
    let raw;
    try {
        raw = await fs.readFile(batchReviewVerdictPath(cwd, shaRange), "utf-8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return { kind: "pending" };
        throw new Error(`Failed to read the batch-review verdict for ${shaRange}: ${errMsg(err)}`);
    }
    const parsed = parseVerdict(raw, shaRange);
    if (!parsed.ok) {
        if (!state.batchReviewSynthesizedBeads?.[shaRange]) {
            try {
                appendMemory(cwd, `malformed batch-review verdict (sha range ${shaRange}): ${parsed.reason}`, "batch-review");
            }
            catch { /* CASS is best-effort */ }
        }
        const rawSnippet = raw.length > RAW_SNIPPET_CHARS ? `${raw.slice(0, RAW_SNIPPET_CHARS)}\n…(truncated)` : raw;
        const beadIds = await fileFindingBeads(cwd, state, shaRange, [reReviewFinding(shaRange, parsed.reason, rawSnippet)], signal);
        settle(state, shaRange);
        return { kind: "malformed", reason: parsed.reason, rawSnippet, beadIds };
    }
    const beadIds = await fileFindingBeads(cwd, state, shaRange, parsed.verdict.findings, signal);
    settle(state, shaRange);
    return { kind: "filed", verdict: parsed.verdict, beadIds };
}
function parseVerdict(raw, shaRange) {
    let json;
    try {
        json = JSON.parse(raw);
    }
    catch (err) {
        return { ok: false, reason: `Verdict JSON parse failed: ${errMsg(err)}` };
    }
    const result = BatchReviewVerdictSchema.safeParse(json);
    if (!result.success) {
        const issues = result.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ");
        return { ok: false, reason: `Verdict schema validation failed (BatchReviewVerdictSchema): ${issues}` };
    }
    if (result.data.sha_range !== shaRange) {
        return { ok: false, reason: `Verdict sha_range "${result.data.sha_range}" does not match the path "${shaRange}"` };
    }
    return { ok: true, verdict: result.data };
}
function reReviewFinding(shaRange, reason, rawSnippet) {
    return {
        severity: "high",
        summary: `Nobody has reviewed commits ${shaRange}, because the batch reviewer's verdict could not be read (${reason}). ` +
            `Review \`git diff ${shaRange}\` with fresh eyes and file a bead with \`br create\` for each real issue.`,
        suggested_bead_title: `Re-review commits ${shaRange} (batch-review verdict unreadable)`,
        affected_files: [path.join(".pi-flywheel", "batch-reviews", `${shaRange}.json`)],
        evidence_excerpt: rawSnippet,
    };
}
async function fileFindingBeads(cwd, state, shaRange, findings, signal) {
    const filed = state.batchReviewSynthesizedBeads?.[shaRange] ?? [];
    state.batchReviewSynthesizedBeads = { ...state.batchReviewSynthesizedBeads, [shaRange]: filed };
    const programLabel = state.beadProgramScope?.kind === "tagged" ||
        state.beadProgramScope?.kind === "unresolved"
        ? state.beadProgramScope.label
        : undefined;
    const labels = ["auto-batch-review", programLabel].filter(Boolean).join(",");
    for (let i = filed.length; i < findings.length; i++) {
        const finding = findings[i];
        let stdout;
        try {
            const result = await execFileAsync("br", [
                "create",
                "--title", finding.suggested_bead_title,
                "--type", "task",
                "--priority", PRIORITY_BY_SEVERITY[finding.severity],
                "--description", formatFindingBody(finding, shaRange),
                "--labels", labels,
                "--silent",
            ], { cwd, timeout: BR_TIMEOUT_MS, signal });
            stdout = result.stdout;
        }
        catch (err) {
            throw new Error(`br create failed for finding ${i + 1}/${findings.length} (${finding.severity}: ${finding.suggested_bead_title}): ${errMsg(err)}`);
        }
        const beadId = stdout.trim().split(/\s+/)[0] ?? "";
        if (!beadId) {
            throw new Error(`br create --silent returned empty stdout for finding ${i + 1}/${findings.length}`);
        }
        filed.push(beadId);
    }
    return [...filed];
}
function settle(state, shaRange) {
    if (!state.pendingBatchReviews)
        return;
    state.pendingBatchReviews = state.pendingBatchReviews.filter((range) => range !== shaRange);
}
function formatFindingBody(finding, shaRange) {
    const files = finding.affected_files.map((f) => `- ${f}`).join("\n");
    return [
        finding.summary,
        "",
        `Found during batch review (sha range ${shaRange}).`,
        "",
        `Severity: ${finding.severity}`,
        "",
        "Affected files:",
        files,
        "",
        "Evidence:",
        finding.evidence_excerpt,
    ].join("\n");
}
//# sourceMappingURL=commit-batch.js.map